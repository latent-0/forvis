// Local server: serves public/ and the same /api/extract function Vercel runs.
// Run: npm start  (reads .env if present), then open http://localhost:4317
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }
const { default: extract } = await import('./api/extract.js');

const PORT = Number(process.env.PORT || 4317);
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml' };

function readJson(req, limit = 4.5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('File too large for one request (4.5 MB).'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

// Minimal Vercel-style response helpers so the same handler runs locally.
function wrap(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  return res;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/api/extract') {
    wrap(res);
    try { req.body = req.method === 'POST' ? await readJson(req) : {}; }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    return extract(req, res);
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUBLIC, p));
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log(`Evidence Intake on http://localhost:${PORT}`));
