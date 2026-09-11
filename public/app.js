// Пульт ProPresenter — клиент.
// Все запросы идут через локальный мост (server.js): /pp/* → API ProPresenter.
// Источник правды о живом слайде — /v1/status/slide (в ProPresenter 20
// /v1/presentation/slide_index всегда отдаёт null). Индекс текущего слайда
// вычисляется сопоставлением текста со слайдами активной презентации.
'use strict';

const $ = (id) => document.getElementById(id);
const PP = (p) => fetch('/pp' + p).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  const t = r.headers.get('content-type') || '';
  return t.includes('json') ? r.json() : r.text();
});
// в колоде переводы строк бывают "\r" или "\r\n", в status/slide — "\r\n"; приводим к "\n"
const norm = (s) => (s || '').replace(/\r\n?/g, '\n');

const state = {
  pres: null,      // {uuid, name, flat:[{group, color, text, notes}]}
  idx: -1,         // индекс живого слайда в flat (по сопоставлению текста)
  liveText: '',    // текст живого слайда из status/slide
  liveNotes: '',
  statusNext: '',  // «следующий» от ProPresenter, если он его знает
  screens: true,
  ok: false,
};

/* ── загрузка активной презентации ─────────────────────── */

async function loadActive() {
  let body;
  try {
    body = await PP('/v1/presentation/active');
  } catch { return; }
  const p = body.presentation;
  if (!p) { state.pres = null; state.idx = -1; return; }
  const uuid = p.id?.uuid || p.uuid || '';
  const flat = [];
  (p.groups || []).forEach((g) => {
    (g.slides || []).forEach((s) => flat.push({
      group: g.name || '', color: g.color || '#555',
      text: norm(s.text), notes: norm(s.notes),
    }));
  });
  if (state.pres?.uuid !== uuid || state.pres?.flat.length !== flat.length) {
    state.pres = { uuid, name: p.id?.name || p.name || 'Без названия', flat };
  }
  state.idx = matchIndex();
}

function matchIndex() {
  if (!state.liveText || !state.pres) return -1;
  return state.pres.flat.findIndex((s) => s.text === state.liveText);
}

/* ── опрос живого слайда ───────────────────────────────── */

let pollTimer = null, tick = 0;

async function poll() {
  try {
    const st = await PP('/v1/status/slide');
    setOnline(true);
    const cur = st?.current || {};
    if (norm(cur.text) !== state.liveText || norm(cur.notes) !== state.liveNotes) {
      state.liveText = norm(cur.text);
      state.liveNotes = norm(cur.notes);
      await loadActive();       // могла смениться колода
      state.idx = matchIndex();
      render();
    }
    state.statusNext = norm(st?.next?.text || '');
    if (++tick % 4 === 0) {     // реже: экраны + обновление колоды
      state.screens = await PP('/v1/status/audience_screens');
      renderScreens();
      await loadActive();
      state.idx = matchIndex();
      render();
    }
  } catch (e) {
    setOnline(false, e);
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
  const n = state.pres?.flat.length || 0;
  if (i < 0 || i >= n) return;
  const s = state.pres.flat[i];        // оптимистично, подтвердит опрос
  state.idx = i; state.liveText = s.text; state.liveNotes = s.notes;
  render();
  trig(`${i}/trigger`);
}

function next() {
  const n = state.pres?.flat.length || 0;
  if (state.idx >= 0 && state.idx < n - 1) return goto(state.idx + 1);
  if (state.idx < 0) return trig('next/trigger'); // живого нет/не сопоставился — просто «дальше»
}

function prev() {
  if (state.idx > 0) return goto(state.idx - 1);
  if (state.idx < 0) return trig('previous/trigger');
}

$('btnNext').onclick = next;
$('btnPrev').onclick = prev;

$('btnBlack').onclick = () => {
  const to = !state.screens;
  state.screens = to; renderScreens();
  fetch('/pp/v1/status/audience_screens', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: String(to),
  }).catch((e) => setOnline(false, e));
};

$('btnClear').onclick = () => PP('/v1/clear/layer/slide').then(poll).catch((e) => setOnline(false, e));

/* ── выбор презентации: библиотеки и плейлисты ─────────── */

const picker = { tab: 'lib', openId: null, openName: '' };

const thumb0 = (uuid) => `/pp/v1/presentation/${uuid}/thumbnail/0?quality=96&thumbnail_type=jpeg`;

function pkRow({ ico, name, uuid, dim, action }) {
  const b = document.createElement('button');
  b.className = 'pkRow' + (dim ? ' dim' : '');
  b.innerHTML = (uuid ? `<img src="${thumb0(uuid)}" alt="" loading="lazy" onerror="this.remove()">`
    : `<span class="ico">${ico || '📁'}</span>`) + `<span class="nm"></span>`;
  b.querySelector('.nm').textContent = name;
  b.onclick = action;
  return b;
}

function pkRender(rows, title, backAction) {
  const list = $('pkList');
  list.replaceChildren(...rows);
  $('pkTitle').textContent = title;
  $('pkBack').hidden = !backAction;
  $('pkBack').onclick = backAction || null;
}

async function pkLoad() {
  const list = $('pkList');
  list.innerHTML = '<div class="pkEmpty">Загрузка…</div>';
  try {
    if (picker.tab === 'lib') {
      if (picker.openId) return await pkLibItems(picker.openId, picker.openName);
      const libs = await PP('/v1/libraries');
      pkRender(libs.map((l) => pkRow({
        name: l.name, action: () => { picker.openId = l.uuid; picker.openName = l.name; pkLoad(); },
      })), 'Библиотека');
    } else {
      if (picker.openId) return await pkPlaylistItems(picker.openId, picker.openName);
      const pls = await PP('/v1/playlists');
      pkRender(pls.map((p) => pkRow({
        name: p.id?.name ?? p.name, action: () => { picker.openId = p.id?.uuid ?? p.uuid; picker.openName = p.id?.name ?? p.name; pkLoad(); },
      })), 'Плейлисты');
    }
  } catch (e) {
    list.innerHTML = '<div class="pkEmpty">Не удалось загрузить</div>';
    setOnline(false, e);
  }
}

async function pkLibItems(libUuid, libName) {
  const { items } = await PP(`/v1/library/${libUuid}`);
  pkRender((items || []).map((it) => pkRow({
    name: it.name, uuid: it.uuid,
    action: () => pkLaunch(`/v1/library/${libUuid}/${it.uuid}/trigger`),
  })), libName, () => { picker.openId = null; pkLoad(); });
}

// элементы плейлиста: группы разворачиваем в плоский список с подзаголовками
function flattenPlaylist(items, out = []) {
  for (const it of items || []) {
    if (it.type === 'group') {
      out.push({ head: (it.id?.name ?? it.name) || 'Группа' });
      flattenPlaylist(it.items || it.children || [], out);
    } else out.push({ item: it });
  }
  return out;
}

async function pkPlaylistItems(plUuid, plName) {
  const body = await PP(`/v1/playlist/${plUuid}`);
  const flat = flattenPlaylist(body.items);
  const rows = flat.map((e) => e.head
    ? Object.assign(document.createElement('div'), { className: 'pkGroup', textContent: e.head })
    : pkRow({
      name: e.item.id?.name ?? e.item.name,
      uuid: e.item.target_uuid || e.item.presentation_info?.presentation_uuid,
      dim: e.item.type !== 'presentation',
      action: e.item.type === 'presentation'
        ? () => pkLaunch(`/v1/playlist/${plUuid}/${e.item.id?.index ?? e.item.index}/trigger`)
        : null,
    }));
  pkRender(rows, plName, () => { picker.openId = null; pkLoad(); });
}

async function pkLaunch(path) {
  try { await PP(path); } catch (e) { if (!String(e).includes('404')) setOnline(false, e); }
  closePicker();
  await poll(); // сразу подтянуть запущенное
}

function closePicker() {
  $('picker').hidden = true;
  picker.openId = null;
}

$('btnLib').onclick = () => { $('picker').hidden = false; pkLoad(); };
$('pkClose').onclick = closePicker;
$('tabLib').onclick = () => { picker.tab = 'lib'; picker.openId = null; pkSetTabs(); pkLoad(); };
$('tabPl').onclick = () => { picker.tab = 'pl'; picker.openId = null; pkSetTabs(); pkLoad(); };
function pkSetTabs() {
  $('tabLib').classList.toggle('on', picker.tab === 'lib');
  $('tabPl').classList.toggle('on', picker.tab === 'pl');
}

/* ── отрисовка ─────────────────────────────────────────── */

function setOnline(ok, err) {
  state.ok = ok;
  $('dot').className = ok ? 'on' : 'off';
  if (!ok && err) {
    $('ui').hidden = true;
    $('setupHint').hidden = false;
    $('errDetail').textContent = String(err.message || err).slice(0, 200);
  } else if (state.pres || state.liveText) {
    $('setupHint').hidden = true;
    $('ui').hidden = false;
  }
}

function renderCard(imgEl, textEl, uuid, i, pres, text, notes, group) {
  if (i >= 0 && pres) {
    imgEl.src = `/pp/v1/presentation/${uuid}/thumbnail/${i}?quality=640&thumbnail_type=jpeg`;
    imgEl.hidden = false;
    imgEl.onerror = () => { imgEl.hidden = true; };
  } else {
    imgEl.removeAttribute('src'); imgEl.hidden = true;
  }
  textEl.textContent = text || '';
  if (notes) textEl.append(`\n📝 ${notes}`);
  return group;
}

function render() {
  const pres = state.pres;
  $('presName').textContent = pres ? pres.name : (state.liveText ? 'Презентация вне колоды' : 'Ничего не запущено');
  const n = pres?.flat.length || 0;
  $('slidePos').textContent = n && state.idx >= 0 ? `${state.idx + 1} / ${n}` : '';

  const live = state.liveText ? { text: state.liveText, notes: state.liveNotes } : null;
  const curFlat = state.idx >= 0 ? pres.flat[state.idx] : null;

  if (!live) {
    renderCard($('curImg'), $('curText'), '', -1, null, '');
    $('curGroup').textContent = '';
    $('curText').textContent = pres ? 'Слайд не выбран — нажми «Вперёд» или тапни по ленте' : 'Запусти что-нибудь в ProPresenter';
    // следующий при старте — первый слайд колоды
    if (n) renderCard($('nextImg'), $('nextText'), pres.uuid, 0, pres, pres.flat[0].text, pres.flat[0].notes);
    else renderCard($('nextImg'), $('nextText'), '', -1, null, '');
  } else {
    $('curGroup').textContent = curFlat?.group || '';
    const g = renderCard($('curImg'), $('curText'),
      pres?.uuid, state.idx, pres, live.text, live.notes, curFlat?.group);
    const nxt = state.idx >= 0 ? pres?.flat[state.idx + 1] : null;
    if (nxt) renderCard($('nextImg'), $('nextText'), pres.uuid, state.idx + 1, pres, nxt.text, nxt.notes);
    else if (state.statusNext) renderCard($('nextImg'), $('nextText'), '', -1, null, state.statusNext);
    else renderCard($('nextImg'), $('nextText'), '', -1, null, n && state.idx === n - 1 ? '— конец —' : '');
  }

  const strip = $('strip');
  strip.replaceChildren(...(pres ? pres.flat : []).map((s, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.idx ? ' now' : '');
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
