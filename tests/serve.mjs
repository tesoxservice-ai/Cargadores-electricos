// Servidor local mínimo que aplica los mismos headers que vercel.json (útil para probar la CSP antes de subir).
// Uso:  npm start   →  http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(raiz, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(config.headers[0].headers.map((h) => [h.key, h.value]));
const puerto = Number(process.env.PORT) || 5173;

createServer((req, res) => {
  if (req.url.split('?')[0] === '/' || req.url.startsWith('/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(readFileSync(join(raiz, 'index.html')));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}).listen(puerto, '127.0.0.1', () => console.log('Sirviendo en http://localhost:' + puerto));
