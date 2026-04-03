'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// Cache control - aggressive caching for static-like responses
const CACHE_CONTROL = {
  // Short cache for API responses (they change infrequently)
  API: 'public, max-age=300, stale-while-revalidate=60',
  // Long cache for HLS segments (they're static)
  SEGMENT: 'public, max-age=86400, stale-while-revalidate=86400',
  // No cache for errors
  ERROR: 'no-store, no-cache, must-revalidate'
};

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');
  return playlist;
}

// ── HLS upstream fetcher with redirect support and streaming ─────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { 
        Referer: REFERER, 
        Origin: ORIGIN, 
        'User-Agent': UA, 
        Accept: '*/*',
        // Request compression if supported
        'Accept-Encoding': 'gzip, deflate'
      },
      // Timeout to prevent hanging connections
      timeout: 30000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject).on('timeout', () => reject(new Error('Request timeout')));
  });
}

function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// Cache key generator for segment URLs
function getCacheKey(url) {
  // Simple hash for caching decisions
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = decodeURIComponent(q.url);
    const isSegment = /\.(ts|m4s|mp4|aac|webm)(\?|$)/i.test(url.split('?')[0]);
    const isM3u8 = /\.m3u8?(\?|$)/i.test(url.split('?')[0]);
    
    try {
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      
      // For HLS segments, use long cache
      if (isSegment) {
        res.setHeader('Cache-Control', CACHE_CONTROL.SEGMENT);
        res.setHeader('CDN-Cache-Control', 'max-age=86400');
        res.setHeader('Vercel-CDN-Cache-Control', 'max-age=86400');
      } 
      // For playlists, use shorter cache but still cache
      else if (isM3u8) {
        res.setHeader('Cache-Control', CACHE_CONTROL.API);
        res.setHeader('CDN-Cache-Control', 'max-age=300');
        res.setHeader('Vercel-CDN-Cache-Control', 'max-age=300');
      }
      
      const finalIsM3u8 = isM3u8 || ct.includes('mpegurl') || ct.includes('m3u8');
      
      if (finalIsM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      } else {
        // For segments, stream directly without buffering when possible
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        
        // Set content length if available
        if (upstream.headers['content-length']) {
          res.setHeader('Content-Length', upstream.headers['content-length']);
        }
        
        res.statusCode = upstream.statusCode;
        
        // Pipe with error handling
        upstream.pipe(res);
        upstream.on('error', (err) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end(err.message);
          }
        });
      }
    } catch (err) {
      res.setHeader('Cache-Control', CACHE_CONTROL.ERROR);
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    res.setHeader('Cache-Control', CACHE_CONTROL.ERROR);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  // Cache API responses
  res.setHeader('Cache-Control', CACHE_CONTROL.API);
  res.setHeader('Content-Type', 'application/json');
  
  try {
    const url = await getStream(q.id, q.s, q.e);
    // Return minimal response
    res.end(JSON.stringify({ url }));
  } catch (err) {
    res.setHeader('Cache-Control', CACHE_CONTROL.ERROR);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};