// Servidor local mínimo: aplica los mismos headers que vercel.json y atiende /api/state con el mismo
// código que Vercel (api/state.js), guardando en .data/estado.json en vez de Upstash.
// Uso:  npm start   →  http://localhost:5173   (contraseña de prueba: la de APP_PASSWORD, por defecto «local»)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(raiz, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(config.headers[0].headers.map((h) => [h.key, h.value]));
const puerto = Number(process.env.PORT) || 5173;
process.env.APP_PASSWORD ||= 'local';
const apiState = createRequire(import.meta.url)(join(raiz, 'api', 'state.js'));

createServer(async (req, res) => {
  const ruta = req.url.split('?')[0];
  if (ruta === '/api/state') {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return apiState(req, res);
  }
  if (ruta === '/' || ruta === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    return res.end(readFileSync(join(raiz, 'index.html')));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
}).listen(puerto, '127.0.0.1', () => {
  console.log('Sirviendo en http://localhost:' + puerto);
  console.log('Contraseña de la nube de prueba: ' + process.env.APP_PASSWORD + '  (datos en .data/estado.json)');
});
