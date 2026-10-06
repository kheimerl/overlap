// Local development server.
//   http://localhost:8000  serves the static site (stands in for GitHub Pages)
//   http://localhost:8788  runs apps-script/Code.gs against an in-memory sheet
//                          (stands in for script.google.com)
// The API port mimics Apps Script's CORS behavior: it allows simple cross-origin
// requests but rejects preflights, so a client that triggers one fails here too.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend } from './gas-shim.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_PORT = Number(process.env.SITE_PORT || 8000);
const API_PORT = Number(process.env.API_PORT || 8788);
// Real Apps Script calls take 1-2 s; set API_DELAY_MS=1500 to see how the UI copes.
const API_DELAY_MS = Number(process.env.API_DELAY_MS || 0);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const { global: backend } = loadBackend();
backend.setup();

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(SITE_PORT, () => console.log(`site: http://localhost:${SITE_PORT}/`));

createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') return void res.writeHead(405, { 'Content-Type': 'text/plain' }).end('preflight not supported');
  const url = new URL(req.url, 'http://x');
  const send = out => setTimeout(() => res.writeHead(200, { ...cors, 'Content-Type': out.mime }).end(out.getContent()), API_DELAY_MS);
  if (req.method === 'GET') return send(backend.doGet({ parameter: Object.fromEntries(url.searchParams) }));
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => send(backend.doPost({ postData: { contents: body, type: req.headers['content-type'] } })));
}).listen(API_PORT, () => console.log(`api:  http://localhost:${API_PORT}/  (Code.gs on an in-memory sheet)`));
