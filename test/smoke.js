// Smoke-тест: поднимает мок ProPresenter + мост и проверяет сценарий пульта.
// Запуск: node test/smoke.js  (код выхода 0 — всё ок)
'use strict';
process.env.PP_PORT = '50999'; // свой порт, чтобы тест не задевал живой ProPresenter на 50001
const assert = require('assert');
const { startMock } = require('./mock');
const { startServer } = require('../server');

(async () => {
  const mock = await startMock(50999);
  const srv = await startServer(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p, opts) => {
    const r = await fetch(base + p, opts);
    return { status: r.status, type: r.headers.get('content-type'), body: await r.arrayBuffer() };
  };

  // 1. статика пульта отдаётся
  const html = await get('/');
  assert.equal(html.status, 200);
  assert.ok(html.type.includes('text/html'));

  // 2. мост проксирует /version мока
  const ver = JSON.parse(new TextDecoder().decode((await get('/pp/version')).body));
  assert.equal(ver.api_version, 'v1');

  // 3. живой слайд до переключений (правда в P20 — status/slide, slide_index там null)
  const cur0 = JSON.parse(new TextDecoder().decode((await get('/pp/v1/status/slide')).body));
  assert.ok(cur0.current.text.length > 0, 'текущий слайд должен иметь текст');
  const idxNull = JSON.parse(new TextDecoder().decode((await get('/pp/v1/presentation/slide_index')).body));
  assert.equal(idxNull.presentation_index, null);

  // 4. переключение вперёд через прокси
  assert.equal((await get('/pp/v1/presentation/active/next/trigger')).status, 204);
  const cur1 = JSON.parse(new TextDecoder().decode((await get('/pp/v1/status/slide')).body));
  assert.notEqual(cur1.current.text, cur0.current.text, 'после next текст живого слайда должен смениться');

  // 5. прямой переход на слайд и назад
  await get('/pp/v1/presentation/active/4/trigger');
  let cur = JSON.parse(new TextDecoder().decode((await get('/pp/v1/status/slide')).body));
  assert.equal(cur.current.text, 'Я прихожу\nТакой, как есть');
  await get('/pp/v1/presentation/active/previous/trigger');
  cur = JSON.parse(new TextDecoder().decode((await get('/pp/v1/status/slide')).body));
  assert.equal(cur.current.text, 'Хвала Тебе\nВо веки веков');

  // 6. миниатюра слайда — бинарный образ через прокси
  const th = await get('/pp/v1/presentation/DEMO-0000-0001/thumbnail/2?quality=320&thumbnail_type=jpeg');
  assert.equal(th.status, 200);
  assert.equal(new Uint8Array(th.body)[0], 0x89, 'PNG-подпись на месте (мок отдаёт PNG)');

  // 7. затемнение экрана
  await get('/pp/v1/status/audience_screens', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'false' });
  assert.equal(JSON.parse(new TextDecoder().decode((await get('/pp/v1/status/audience_screens')).body)), false);

  // 8. активная презентация со слайдами и группами
  const act = JSON.parse(new TextDecoder().decode((await get('/pp/v1/presentation/active')).body));
  assert.equal(act.presentation.groups.length, 3);
  assert.ok(act.presentation.groups[0].slides[0].text.length > 0);

  // 9. библиотеки: список и содержимое
  const libs = JSON.parse(new TextDecoder().decode((await get('/pp/v1/libraries')).body));
  assert.ok(libs.some((l) => l.name === 'ПесниNew'));
  const libItems = JSON.parse(new TextDecoder().decode((await get('/pp/v1/library/LIB-SONGS')).body));
  assert.equal(libItems.items[0].uuid, 'DEMO-0000-0001');

  // 10. запуск презентации из библиотеки
  assert.equal((await get('/pp/v1/library/LIB-SONGS/DEMO-0000-0001/trigger')).status, 204);
  cur = JSON.parse(new TextDecoder().decode((await get('/pp/v1/status/slide')).body));
  assert.equal(cur.current.text, 'Милость превыше суда\nБольше, чем я вижу');

  // 11. плейлисты: список, содержимое, запуск по индексу
  const pls = JSON.parse(new TextDecoder().decode((await get('/pp/v1/playlists')).body));
  assert.equal(pls[0].id.name, 'По умолчанию');
  const plItems = JSON.parse(new TextDecoder().decode((await get('/pp/v1/playlist/PL-1')).body));
  assert.equal(plItems.items[0].target_uuid, 'DEMO-0000-0001');
  assert.equal((await get('/pp/v1/playlist/PL-1/0/trigger')).status, 204);

  console.log('SMOKE OK: 11/11 проверок прошли');
  mock.server.close(); srv.close();
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
