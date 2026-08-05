// Минимальный статический сервер для локального превью (порт 5085).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5085;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

// Внутри ROOT лежат и секреты (.supabase-token — токен Management API), и .git,
// и приватные документы. Раздаём только то, что и так уезжает на сайт.
const DENY = /(^|[/\\])(\.[^/\\]+|internal|tools|supabase|node_modules)([/\\]|$)/i;

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const rel = path.normalize(p).replace(/^([/\\])+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || DENY.test(rel)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
// Только петля: сервер поднимается в общей Wi-Fi и раздаёт содержимое каталога
// разработки — соседям по сети его видеть незачем.
}).listen(PORT, '127.0.0.1', () => console.log(`Albums dev server: http://localhost:${PORT}`));
