// Smoke-тест: поднимает мок ProPresenter + мост и проверяет сценарий пульта.
// Запуск: node test/smoke.js  (код выхода 0 — всё ок)
'use strict';
const assert = require('assert');
const { startMock } = require('./mock');
const { startServer } = require('../server');

(async () => {
  // мок на 50001 — мост ищет API на портах 50001/1025 по умолчанию
  const mock = await startMock(50001);
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

  // 3. индекс слайда
  const idx0 = await get('/pp/v1/presentation/slide_index');
  assert.equal(idx0.status, 200);
  assert.equal(JSON.parse(new TextDecoder().decode(idx0.body)).presentation_index, 0);

  // 4. переключение вперёд через прокси
  assert.equal((await get('/pp/v1/presentation/active/next/trigger')).status, 204);
  const idx1 = JSON.parse(new TextDecoder().decode((await get('/pp/v1/presentation/slide_index')).body));
  assert.equal(idx1.presentation_index, 1, 'после next индекс должен стать 1');

  // 5. прямой переход на слайд и назад
  await get('/pp/v1/presentation/active/4/trigger');
  assert.equal(JSON.parse(new TextDecoder().decode((await get('/pp/v1/presentation/slide_index')).body)).presentation_index, 4);
  await get('/pp/v1/presentation/active/previous/trigger');
  assert.equal(JSON.parse(new TextDecoder().decode((await get('/pp/v1/presentation/slide_index')).body)).presentation_index, 3);

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

  console.log('SMOKE OK: 8/8 проверок прошли');
  mock.server.close(); srv.close();
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
