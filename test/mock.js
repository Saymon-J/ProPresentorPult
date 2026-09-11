// Мок REST API ProPresenter (те же эндпоинты, что использует пульт).
// Двойное назначение: цель для test/smoke.js и демо без ProPresenter:
//   node test/mock.js            → порт 50001
//   node server.js               → пульт на :8080 управляет моком
'use strict';
const http = require('http');
const { encodePng } = require('../tools/gen-icons');

// hsl → rgb, чтобы каждый слайд-мок имел свой цвет миниатюры
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function thumb(size, idx) {
  const [r, g, b] = hsl((idx * 47) % 360, 0.5, 0.35);
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return encodePng(size, px);
}

function demoPresentation() {
  const groups = [
    { name: 'Куплет 1', color: '#4c8dff', slides: ['Милость превыше суда\nБольше, чем я вижу', 'Ты держишь меня\nВ Твоих руках'] },
    { name: 'Припев', color: '#35d07f', slides: ['Святой, святой\nДостоин Агнец', 'Хвала Тебе\nВо веки веков'] },
    { name: 'Куплет 2', color: '#ff9f43', slides: ['Я прихожу\nТакой, как есть'] },
  ];
  let i = 0;
  const out = [];
  for (const g of groups)
    out.push({
      name: g.name, color: g.color,
      slides: g.slides.map((text) => ({
        enabled: true, notes: `заметка ${++i}`, text, label: '', color: g.color,
      })),
    });
  return out;
}

function startMock(port = 50001) {
  const state = { idx: 0, screens: true, cleared: false, mediaOn: true,
    look: { id: { uuid: 'LOOK-1', name: 'По умолчанию', index: 0 },
      screens: [{ video_input: true, media: true, slide: true, announcements: true, props: true, messages: true, presentation: '', mask: '' }] } };
  const pres = {
    uuid: 'DEMO-0000-0001', id: { uuid: 'DEMO-0000-0001', name: 'Демо-песня', index: 0 },
    name: 'Демо-песня', groups: demoPresentation(), has_timeline: false, destination: 'presentation',
  };
  const flat = pres.groups.flatMap((g) => g.slides);
  const LIBS = [
    { uuid: 'LIB-DEFAULT', name: 'Default', index: 0 },
    { uuid: 'LIB-SONGS', name: 'ПесниNew', index: 1 },
  ];
  const LIB_ITEMS = { 'LIB-SONGS': [{ uuid: 'DEMO-0000-0001', name: 'Демо-песня', index: 0 }] };
  const PLAYLISTS = [{ id: { uuid: 'PL-1', name: 'По умолчанию', index: 0 }, field_type: 'playlist', children: [] }];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (p === '/version') return json(200, {
      name: 'Мок ProPresenter', platform: 'win', os_version: 'mock',
      host_description: 'Mock 8.0', api_version: 'v1',
    });
    if (p === '/v1/presentation/active') return json(200, { presentation: state.cleared ? null : pres });
    if (p === '/v1/presentation/slide_index') return json(200, { presentation_index: null }); // как в P20
    if (p === '/v1/status/slide') return json(200, {
      current: state.cleared ? { text: '', notes: '', uuid: '' }
        : { text: flat[state.idx]?.text || '', notes: flat[state.idx]?.notes || '', uuid: '' },
      next: { text: '', notes: '', uuid: '' }, // P20 здесь ничего не сообщает
    });
    if (p === '/v1/look/current') {
      if (req.method === 'PUT') {
        let b = ''; req.on('data', (c) => b += c);
        return req.on('end', () => { state.look = JSON.parse(b); res.writeHead(204); res.end(); });
      }
      return json(200, state.look);
    }
    if (p === '/v1/looks') return json(200, []);
    if (p === '/v1/status/audience_screens') {
      if (req.method === 'PUT') {
        let b = ''; req.on('data', (c) => b += c);
        return req.on('end', () => { state.screens = b === 'true'; res.writeHead(204); res.end(); });
      }
      return json(200, state.screens);
    }
    if (p === '/v1/status/layers') return json(200, {
      video_input: false, media: state.mediaOn, slide: !state.cleared,
      announcements: false, props: false, messages: false, audio: false,
    });
    if (p === '/v1/clear/layer/media') { state.mediaOn = false; res.writeHead(204); return res.end(); }
    if (p === '/v1/clear/layer/slide') { state.cleared = true; res.writeHead(204); return res.end(); }

    let m;
    const unClear = () => { state.cleared = false; state.mediaOn = true; };
    if (p === '/v1/libraries') return json(200, LIBS);
    if (p === '/v1/playlists') return json(200, PLAYLISTS);
    if ((m = p.match(/^\/v1\/library\/([^/]+)$/))) {
      return json(200, { update_type: 'all', items: LIB_ITEMS[m[1]] || [] });
    }
    if ((m = p.match(/^\/v1\/playlist\/([^/]+)$/))) {
      return json(200, {
        id: { uuid: m[1], name: 'По умолчанию', index: 0 },
        items: [{ id: { name: 'Демо-песня', index: 0, uuid: 'PLI-1' }, type: 'presentation', target_uuid: 'DEMO-0000-0001' }],
      });
    }
    if ((m = p.match(/^\/v1\/library\/([^/]+)\/([^/]+)\/trigger$/))) {
      unClear(); state.idx = 0; res.writeHead(204); return res.end();
    }
    if ((m = p.match(/^\/v1\/playlist\/([^/]+)\/(\d+)\/trigger$/))) {
      unClear(); state.idx = 0; res.writeHead(204); return res.end();
    }
    if (p === '/v1/presentation/active/next/trigger') { unClear(); state.idx = Math.min(state.idx + 1, flat.length - 1); res.writeHead(204); return res.end(); }
    if (p === '/v1/presentation/active/previous/trigger') { unClear(); state.idx = Math.max(state.idx - 1, 0); res.writeHead(204); return res.end(); }
    if ((m = p.match(/^\/v1\/presentation\/active\/(\d+)\/trigger$/))) {
      const i = Number(m[1]);
      if (i >= flat.length) return json(404, { error: 'no slide' });
      unClear(); state.idx = i; res.writeHead(204); return res.end();
    }
    if ((m = p.match(/^\/v1\/presentation\/([^/]+)\/(next|previous)\/trigger$/))) {
      unClear();
      state.idx = m[2] === 'next' ? Math.min(state.idx + 1, flat.length - 1) : Math.max(state.idx - 1, 0);
      res.writeHead(204); return res.end();
    }
    if ((m = p.match(/^\/v1\/presentation\/([^/]+)\/(\d+)\/trigger$/))) {
      const i = Number(m[2]);
      if (i >= flat.length) return json(404, { error: 'no slide' });
      unClear(); state.idx = i; res.writeHead(204); return res.end();
    }
    if ((m = p.match(/^\/v1\/presentation\/([^/]+)\/thumbnail\/(\d+)$/))) {
      const i = Number(m[2]);
      if (i >= flat.length) return json(404, { error: 'no slide' });
      const buf = thumb(96, i);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
      return res.end(buf);
    }
    json(404, { error: 'not found', path: p });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, state, port: server.address().port })));
}

module.exports = { startMock };

if (require.main === module) {
  startMock(Number(process.argv[2]) || 50001).then(({ port }) =>
    console.log(`Мок ProPresenter: http://127.0.0.1:${port} (управляй через server.js)`));
}
