#!/usr/bin/env node
// ProPresenter Пульт — локальный мост.
// Раздаёт веб-пульт из ./public и прозрачно проксирует /pp/* в REST API ProPresenter.
// Почему мост: страница с HTTPS (GitHub Pages) не может ходить в http://…:50001
// (mixed content + CORS), поэтому пульт и API живут на одном origin — этом сервере.
//
// Запуск: node server.js [--port 8080] [--pp 127.0.0.1] [--pp-port 50001,1025]
//   --port     порт этого сервера (по умолчанию 8080)
//   --pp       адрес машины с ProPresenter (по умолчанию 127.0.0.1)
//   --pp-port  кандидаты портов API ProPresenter через запятую (по умолчанию 50001,1025)

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PUB = path.join(__dirname, 'public');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg('--port', process.env.PORT || 8080));
const PP_HOST = arg('--pp', process.env.PP_HOST || '127.0.0.1');
const PP_PORTS = (arg('--pp-port', process.env.PP_PORT) || '50001,1025')
  .split(',').map(Number).filter(Boolean);
let ppPort = PP_PORTS[0];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function ppRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, resolve);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Перебираем порты, ищем живой API (GET /version). Вызывается на старте и
// повторно при отказе соединения — можно запускать сервер до ProPresenter.
async function detectPp() {
  for (const port of PP_PORTS) {
    try {
      const res = await ppRequest({ host: PP_HOST, port, path: '/version', method: 'GET' });
      const body = await readAll(res);
      if (res.statusCode === 200 && JSON.parse(body).api_version) {
        ppPort = port;
        console.log(`ProPresenter найден: http://${PP_HOST}:${ppPort}`);
        return true;
      }
    } catch { /* следующий порт */ }
  }
  return false;
}

async function proxy(req, res) {
  const u = new URL(req.url, 'http://x');
  const target = {
    host: PP_HOST,
    port: ppPort,
    path: u.pathname.replace(/^\/pp/, '') + u.search,
    method: req.method,
    headers: { ...req.headers, host: `${PP_HOST}:${ppPort}` },
  };
  // оставляем ответы несжатыми, чтобы просто проксировать байты как есть
  delete target.headers['accept-encoding'];
  const body = ['GET', 'HEAD'].includes(req.method) ? null : await readAll(req);

  let upstream;
  try {
    upstream = await ppRequest(target, body);
  } catch {
    if (await detectPp()) {
      target.port = ppPort;
      target.headers.host = `${PP_HOST}:${ppPort}`;
      upstream = await ppRequest(target, body);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `ProPresenter недоступен на ${PP_HOST} (порты ${PP_PORTS.join('/')}). ` +
          'Включи API: ProPresenter → Настройки → Сеть → Network, и запусти ProPresenter.',
      }));
      return;
    }
  }
  const headers = { ...upstream.headers };
  delete headers['transfer-encoding']; // Node выставит свою длину/чанковку
  res.writeHead(upstream.statusCode, headers);
  upstream.pipe(res);
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function startServer(port = PORT) {
  const server = http.createServer((req, res) => {
    const run = req.url.startsWith('/pp/') || req.url === '/pp' ? proxy(req, res) : Promise.resolve(serveStatic(req, res));
    run.catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(String(e)); } });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat().filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

if (require.main === module) {
  startServer().then(() => {
    console.log(`Пульт открыт:      http://localhost:${PORT}`);
    for (const a of lanAddresses()) console.log(`С телефона/планшета: ${a}`);
    detectPp().then((ok) => {
      if (!ok) console.log('ProPresenter не найден — сервер продолжит попытки при запросах.');
    });
  });
}

module.exports = { startServer };
