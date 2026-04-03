'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// Cache control headers
const CACHE_CONTROL = {
  API: 'public, max-age=300, stale-while-revalidate=60',
  SEGMENT: 'public, max-age=86400, stale-while-revalidate=86400',
  ERROR: 'no-store, no-cache, must-revalidate'
};

// Compression settings
const COMPRESSION = {
  BROTLI_QUALITY: 6,  // Balanced (1-11, 11 is best but slowest)
  GZIP_LEVEL: 6,      // Balanced (1-9)
  MIN_SIZE: 1024      // Don't compress smaller than 1KB
};

// ── WASM singleton ────────────────────────────────────────────────
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

// ── Stream URL resolver ───────────────────────────────────────────
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

// ── HLS upstream fetcher with redirect support ───────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { 
        Referer: REFERER, 
        Origin: ORIGIN, 
        'User-Agent': UA, 
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br'
      },
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

// ── Brotli/Gzip Compression Helpers ───────────────────────────────
function shouldCompress(req, contentType, size) {
  // Don't compress video segments
  if (contentType && (
    contentType.includes('video') ||
    contentType.includes('mp2t') ||
    contentType.includes('mpegurl')
  )) {
    return false;
  }
  
  // Don't compress small responses
  if (size < COMPRESSION.MIN_SIZE) {
    return false;
  }
  
  // Check if client accepts compression
  const acceptEncoding = req.headers['accept-encoding'];
  if (!acceptEncoding) {
    return false;
  }
  
  return true;
}

function compressWithBrotli(data, quality = COMPRESSION.BROTLI_QUALITY) {
  return new Promise((resolve, reject) => {
    const params = {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
    };
    
    zlib.brotliCompress(data, { params }, (err, compressed) => {
      if (err) {
        console.error('Brotli compression error:', err);
        reject(err);
      } else {
        resolve(compressed);
      }
    });
  });
}

function compressWithGzip(data, level = COMPRESSION.GZIP_LEVEL) {
  return new Promise((resolve, reject) => {
    zlib.gzip(data, { level }, (err, compressed) => {
      if (err) {
        console.error('Gzip compression error:', err);
        reject(err);
      } else {
        resolve(compressed);
      }
    });
  });
}

async function compressResponse(req, res, data, contentType) {
  const size = Buffer.byteLength(data);
  
  if (!shouldCompress(req, contentType, size)) {
    res.setHeader('Content-Length', size);
    return data;
  }
  
  const acceptEncoding = req.headers['accept-encoding'];
  
  // Prefer Brotli (modern browsers support it)
  if (acceptEncoding.includes('br')) {
    try {
      const compressed = await compressWithBrotli(data);
      const ratio = ((1 - compressed.length / size) * 100).toFixed(1);
      console.log(`[Brotli] Compressed ${size} -> ${compressed.length} bytes (${ratio}% saved)`);
      
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', compressed.length);
      return compressed;
    } catch (err) {
      console.error('Brotli failed, falling back to gzip:', err);
    }
  }
  
  // Fallback to Gzip
  if (acceptEncoding.includes('gzip')) {
    try {
      const compressed = await compressWithGzip(data);
      const ratio = ((1 - compressed.length / size) * 100).toFixed(1);
      console.log(`[Gzip] Compressed ${size} -> ${compressed.length} bytes (${ratio}% saved)`);
      
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      return compressed;
    } catch (err) {
      console.error('Gzip compression failed:', err);
    }
  }
  
  // No compression
  res.setHeader('Content-Length', size);
  return data;
}

// ── Vercel serverless handler ─────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept-Encoding');
  res.setHeader('Vary', 'Accept-Encoding'); // Important for CDN caching
  
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
      
      // Set cache headers
      if (isSegment) {
        res.setHeader('Cache-Control', CACHE_CONTROL.SEGMENT);
        res.setHeader('CDN-Cache-Control', 'max-age=86400');
      } else if (isM3u8) {
        res.setHeader('Cache-Control', CACHE_CONTROL.API);
        res.setHeader('CDN-Cache-Control', 'max-age=300');
      }
      
      const finalIsM3u8 = isM3u8 || ct.includes('mpegurl') || ct.includes('m3u8');
      
      if (finalIsM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        let body = Buffer.concat(chunks).toString('utf8');
        body = rewriteM3u8(body, url);
        
        // Compress m3u8 response with Brotli
        const compressedBody = await compressResponse(req, res, body, 'application/vnd.apple.mpegurl');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end(compressedBody);
      } else {
        // For segments, stream directly without compression
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (upstream.headers['content-length']) {
          res.setHeader('Content-Length', upstream.headers['content-length']);
        }
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
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
    const errorResponse = JSON.stringify({ error: 'missing id' });
    const compressedError = await compressResponse(req, res, errorResponse, 'application/json');
    return res.end(compressedError);
  }

  // Cache API responses
  res.setHeader('Cache-Control', CACHE_CONTROL.API);
  res.setHeader('Content-Type', 'application/json');
  
  try {
    const url = await getStream(q.id, q.s, q.e);
    const responseData = JSON.stringify({ url });
    
    // Compress the API response with Brotli
    const compressedData = await compressResponse(req, res, responseData, 'application/json');
    res.end(compressedData);
  } catch (err) {
    res.setHeader('Cache-Control', CACHE_CONTROL.ERROR);
    res.statusCode = 500;
    const errorResponse = JSON.stringify({ error: err.message });
    const compressedError = await compressResponse(req, res, errorResponse, 'application/json');
    res.end(compressedError);
  }
};