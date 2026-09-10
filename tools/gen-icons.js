// Генератор иконок ПВA без зависимостей: рисует тёмный квадрат с белым
// «плей»-треугольником и кодирует в PNG через zlib.
// Запуск: node tools/gen-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // фон #16181d, скруглённые углы
  const r = Math.round(size * 0.18);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x), dy = Math.min(y, size - 1 - y);
      const corner = Math.max(dx, dy) < r && (r - dx) ** 2 + (r - dy) ** 2 > r * r;
      put(x, y, 22, 24, 29, corner ? 0 : 255);
    }
  // «плей»: треугольник с центром чуть правее середины
  const cx = size * 0.54, cy = size / 2, w = size * 0.26, h = size * 0.3;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const t = (y - (cy - h / 2)) / h;           // 0 — верх, 1 — низ
      const half = w * (1 - Math.abs(t * 2 - 1)); // ширина строки треугольника
      if (t >= 0 && t <= 1 && x > cx - half / 2 && x < cx + half / 2) put(x, y, 240, 242, 245);
    }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const byte of body) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePng, drawIcon };

if (require.main === module) {
  for (const size of [192, 512, 180]) {
    const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    fs.writeFileSync(path.join(OUT, name), encodePng(size, drawIcon(size)));
    console.log('icons/' + name);
  }
}
