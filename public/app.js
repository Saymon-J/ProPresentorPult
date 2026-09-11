// Пульт ProPresenter — клиент.
// Все запросы идут через локальный мост (server.js): /pp/* → API ProPresenter.
'use strict';

const $ = (id) => document.getElementById(id);
const PP = (p) => fetch('/pp' + p).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  const t = r.headers.get('content-type') || '';
  return t.includes('json') ? r.json() : r.text();
});

const state = {
  pres: null,   // {uuid, name, flat:[{i, group, color, text, notes, enabled}]}
  idx: -1,
  screens: true,
  ok: false,
};

/* ── загрузка активной презентации ─────────────────────── */

async function loadActive() {
  let body;
  try {
    body = await PP('/v1/presentation/active');
  } catch {
    state.pres = null;
    render();
    return;
  }
  const p = body.presentation;
  if (!p) { state.pres = null; render(); return; } // ничего не открыто/запущено
  const uuid = p.id?.uuid || p.uuid || '';
  if (state.pres?.uuid === uuid) { render(); return; } // не перезагружаем лишний раз
  const flat = [];
  (p.groups || []).forEach((g) => {
    (g.slides || []).forEach((s) => flat.push({
      group: g.name || '', color: g.color || '#555',
      text: s.text || '', notes: s.notes || '', enabled: s.enabled !== false,
    }));
  });
  state.pres = { uuid, name: p.id?.name || p.name || 'Без названия', flat };
  render();
}

/* ── опрос текущего индекса ────────────────────────────── */

let pollTimer = null, tick = 0;

async function poll() {
  try {
    // P20 отдаёт null, когда ни один слайд не запущен — приводим к -1
    const raw = (await PP('/v1/presentation/slide_index')).presentation_index;
    const i = Number.isInteger(raw) ? raw : -1;
    setOnline(true);
    if (i !== state.idx) {
      state.idx = i;
      if (!state.pres) await loadActive(); else render();
    }
    if (++tick % 4 === 0) { // реже: состояние экранов + смена/открытие презентации
      state.screens = await PP('/v1/status/audience_screens');
      renderScreens();
      await loadActive(); // внутри есть проверка по uuid — лишней перезагрузки нет
    }
  } catch (e) {
    if (String(e).includes('404')) { // ничего не запущено
      setOnline(true);
      if (state.idx !== -1 || state.pres) { state.idx = -1; state.pres = null; render(); }
    } else setOnline(false, e);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, 800);
}

/* ── действия ──────────────────────────────────────────── */

// 404 от триггера — «нечего запускать», не авария связи; остальное зажигаем красным
const trig = (path) => PP(`/v1/presentation/active/${path}`).then(poll)
  .catch((e) => { if (!String(e).includes('404')) setOnline(false, e); });

function goto(i) {
  if (i < 0 || i >= (state.pres?.flat.length || 0)) return;
  state.idx = i; render(); // оптимистично, подтвердит опрос
  trig(`${i}/trigger`);
}

$('btnNext').onclick = () => goto(state.idx < 0 ? 0 : state.idx + 1);
$('btnPrev').onclick = () => goto(state.idx - 1) ?? null;

$('btnBlack').onclick = () => {
  const to = !state.screens;
  state.screens = to; renderScreens();
  fetch('/pp/v1/status/audience_screens', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: String(to),
  }).catch((e) => setOnline(false, e));
};

$('btnClear').onclick = () => PP('/v1/clear/layer/slide').catch((e) => setOnline(false, e));

/* ── отрисовка ─────────────────────────────────────────── */

function setOnline(ok, err) {
  state.ok = ok;
  $('dot').className = ok ? 'on' : 'off';
  if (!ok && err) {
    $('ui').hidden = true;
    $('setupHint').hidden = false;
    $('errDetail').textContent = String(err.message || err).slice(0, 200);
  } else if (state.pres || state.idx >= 0) {
    $('setupHint').hidden = true;
    $('ui').hidden = false;
  }
}

function render() {
  const pres = state.pres;
  $('presName').textContent = pres ? pres.name : 'Ничего не запущено';
  const n = pres?.flat.length || 0;
  $('slidePos').textContent = n && state.idx >= 0 ? `${state.idx + 1} / ${n}` : '';
  if (!pres) {
    $('curGroup').textContent = '';
    $('curImg').removeAttribute('src'); $('curImg').hidden = true;
    $('curText').textContent = '';
    $('nextImg').removeAttribute('src'); $('nextImg').hidden = true;
    $('nextText').textContent = '';
    $('strip').replaceChildren();
    setOnline(state.ok);
    return;
  }

  const cur = state.idx >= 0 ? pres.flat[state.idx] : null;
  const next = pres.flat[state.idx + 1]; // при idx=-1 это первый слайд — его и запустит «Вперёд»
  $('curGroup').textContent = cur?.group || '';
  const curImg = $('curImg');
  if (cur) {
    curImg.src = `/pp/v1/presentation/${pres.uuid}/thumbnail/${state.idx}?quality=640&thumbnail_type=jpeg`;
    curImg.hidden = false;
    curImg.onerror = () => { curImg.hidden = true; };
    $('curText').textContent = cur.text;
    $('curText').append(cur.notes ? `\n📝 ${cur.notes}` : '');
  } else {
    curImg.removeAttribute('src'); curImg.hidden = true;
    $('curText').textContent = 'Слайд не выбран — нажми «Вперёд» или тапни по ленте';
  }

  const nextImg = $('nextImg');
  if (next) {
    nextImg.src = `/pp/v1/presentation/${pres.uuid}/thumbnail/${state.idx + 1}?quality=384&thumbnail_type=jpeg`;
    nextImg.hidden = false;
    nextImg.onerror = () => { nextImg.hidden = true; };
    $('nextText').textContent = next.text;
  } else {
    nextImg.removeAttribute('src'); nextImg.hidden = true;
    $('nextText').textContent = '— конец —';
  }

  const strip = $('strip');
  strip.replaceChildren(...pres.flat.map((s, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.idx ? ' now' : '') + (s.enabled ? '' : ' disabled');
    b.style.setProperty('--gc', s.color);
    b.innerHTML = `${i + 1}<span class="g"></span>`;
    b.querySelector('.g').textContent = s.group;
    b.onclick = () => goto(i);
    return b;
  }));
  strip.querySelector('.now')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  setOnline(state.ok);
}

function renderScreens() {
  $('btnBlack').classList.toggle('active', !state.screens);
  $('btnBlack').textContent = state.screens ? '✦ Затемнить экран' : '◼ Экран затемнён — включить';
}

/* ── старт ─────────────────────────────────────────────── */

(async () => {
  try {
    const v = await PP('/version');
    $('presName').textContent = `Подключено: ${v.host_description || v.name || ''}`;
    setOnline(true);
  } catch (e) {
    setOnline(false, e);
  }
  await loadActive();
  await poll();
  startPolling();
  renderScreens();
})();

// PWA: service worker работает на https или localhost; в локальной сети
// по http он не регистрируется — это нормально, пульт и так работает.
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
