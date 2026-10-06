import * as core from './core.js';
import { createApi, openEvent } from './api.js';
import { API_URL, POW_BITS } from './config.js';

const api = createApi(API_URL);
const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = id => document.getElementById(id);

// Builds an element. Children are appended as nodes or text, never parsed as HTML,
// so names and titles typed by other people are always inert.
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children.filter(c => c != null && c !== false));
  return e;
}

function setStatus(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('error', isError);
}

// ---- per-browser conveniences (may be unavailable; nothing depends on them) ----

const store = {
  get(k, fallback) {
    try { return JSON.parse(localStorage.getItem('overlap:' + k)) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem('overlap:' + k, JSON.stringify(v)); } catch { /* private mode etc. */ }
  },
  del(k) {
    try { localStorage.removeItem('overlap:' + k); } catch { /* ignore */ }
  },
};

function remember(key, title) {
  const list = store.get('recent', []).filter(r => r.key !== key);
  list.unshift({ key, title });
  store.set('recent', list.slice(0, 20));
}

// ---- routing ----

function show(id) {
  for (const s of ['loading', 'create', 'event', 'error']) $(s).hidden = s !== id;
}

function fail(message) {
  $('error-msg').textContent = message;
  show('error');
}

window.addEventListener('hashchange', () => location.reload());
const key = location.hash.slice(1);
// WebCrypto only exists on secure origins, and GitHub Pages will also serve plain HTTP.
if (!globalThis.crypto?.subtle && location.protocol === 'http:') location.replace('https:' + location.href.slice(5));
else if (!globalThis.crypto?.subtle) fail('This browser does not support the encryption this site needs.');
else if (!API_URL) fail('This site has no backend configured yet. Set DEPLOYED_API_URL in js/config.js.');
else if (key) showEvent(key);
else showCreate();

// ================= create page =================

function showCreate() {
  document.title = 'New event · Overlap';
  const selected = new Set();
  datePicker($('cal'), selected, () => {
    $('date-count').textContent = selected.size ? `${selected.size} selected.` : '';
  });

  const hourOptions = (sel, from, to, value) => {
    for (let h = from; h <= to; h++) sel.append(el('option', { value: h * 60, textContent: h === 24 ? '12 AM (midnight)' : core.formatMinutes(h * 60) }));
    sel.value = value * 60;
  };
  hourOptions($('start'), 0, 23, 9);
  hourOptions($('end'), 1, 24, 17);

  const zones = Intl.supportedValuesOf?.('timeZone') ?? [];
  if (!zones.includes(viewerTz)) zones.unshift(viewerTz);
  for (const z of zones) $('tz').append(el('option', { value: z, textContent: z.replace(/_/g, ' ') }));
  $('tz').value = viewerTz;

  const recent = store.get('recent', []);
  if (recent.length) {
    $('recent').hidden = false;
    for (const r of recent) {
      $('recent-list').append(el('li', {}, el('a', { href: '#' + r.key, textContent: r.title || 'Untitled event' })));
    }
  }

  $('create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const status = $('create-status');
    const meta = {
      title: $('title').value.trim(),
      dates: [...selected].sort(),
      start: Number($('start').value),
      end: Number($('end').value),
      step: Number($('step').value),
      tz: $('tz').value,
    };
    if (!meta.title) return setStatus(status, 'Give the event a name.', true);
    if (!meta.dates.length) return setStatus(status, 'Pick at least one date.', true);
    if (meta.end <= meta.start) return setStatus(status, '"No later than" must be after "No earlier than".', true);

    $('create-btn').disabled = true;
    setStatus(status, 'Creating… (a second or two of anti-spam work)');
    try {
      core.validateMeta(meta);
      const key = core.newEventKey();
      await api.create(await core.deriveEvent(key), meta, POW_BITS);
      remember(key, meta.title);
      location.hash = key;
    } catch (err) {
      setStatus(status, `Couldn't create the event: ${err.message}`, true);
      $('create-btn').disabled = false;
    }
  });
  show('create');
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Month calendar; click or drag across days to toggle them.
function datePicker(root, selected, onChange) {
  const today = isoDate(new Date());
  let month = new Date();
  month.setDate(1);
  let paint = null;  // true = selecting, false = deselecting

  function render() {
    const y = month.getFullYear(), m = month.getMonth();
    const prev = el('button', { type: 'button', textContent: '‹', ariaLabel: 'Previous month' });
    const next = el('button', { type: 'button', textContent: '›', ariaLabel: 'Next month' });
    prev.onclick = () => { month = new Date(y, m - 1, 1); render(); };
    next.onclick = () => { month = new Date(y, m + 1, 1); render(); };
    const grid = el('div', { className: 'cal-grid' },
      ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => el('div', { className: 'cal-dow', textContent: d })));
    for (let i = 0; i < new Date(y, m, 1).getDay(); i++) grid.append(el('div', { className: 'cal-day blank' }));
    for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) {
      const iso = isoDate(new Date(y, m, d));
      const past = iso < today;
      const cell = el('div', { className: 'cal-day' + (past ? ' past' : '') + (selected.has(iso) ? ' on' : ''), textContent: d });
      if (!past) cell.dataset.date = iso;
      grid.append(cell);
    }
    root.replaceChildren(
      el('div', { className: 'cal-head' }, prev, el('span', { textContent: month.toLocaleString('en-US', { month: 'long', year: 'numeric' }) }), next),
      grid);
  }

  function apply(cell) {
    const d = cell?.dataset?.date;
    if (!d) return;
    if (paint && selected.size >= core.MAX_DATES && !selected.has(d)) return;
    paint ? selected.add(d) : selected.delete(d);
    cell.classList.toggle('on', paint);
    onChange();
  }

  root.addEventListener('pointerdown', e => {
    const d = e.target.dataset?.date;
    if (!d) return;
    e.preventDefault();
    paint = !selected.has(d);
    apply(e.target);
  });
  root.addEventListener('pointermove', e => {
    if (paint !== null) apply(document.elementFromPoint(e.clientX, e.clientY));
  });
  window.addEventListener('pointerup', () => { paint = null; });
  render();
}

// ================= event page =================

async function showEvent(key) {
  let ev, data;
  try {
    ev = await core.deriveEvent(key);
  } catch {
    return fail('This link looks incomplete. Check that you copied the whole thing, including the part after #.');
  }
  try {
    data = await api.load(ev);
  } catch (err) {
    return fail(err.message === 'event not found'
      ? "This event doesn't exist. It may have expired after 90 days without activity, or the link is incomplete."
      : `Couldn't reach the server: ${err.message}`);
  }
  let state;
  try {
    state = await openEvent(ev, data);
  } catch {
    return fail("This event's details couldn't be decrypted. The link may be incomplete.");
  }

  const { meta } = state;
  const spd = core.slotsPerDay(meta);
  const n = core.slotCount(meta);
  const page = { ev, meta, spd, n, responses: state.responses, me: null };
  remember(key, meta.title);

  document.title = `${meta.title} · Overlap`;
  $('ev-title').textContent = meta.title;
  $('ev-sub').textContent = `${meta.dates.length} date${meta.dates.length > 1 ? 's' : ''}, ${core.formatMinutes(meta.start)} – ${core.formatMinutes(meta.end)}`;
  $('share-url').value = location.href;
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('copy').textContent = 'Copied';
    } catch {
      $('share-url').select();
    }
  };
  if (meta.tz !== viewerTz) {
    $('tz-note').hidden = false;
    $('tz-note').textContent = `Times are shown in ${meta.tz.replace(/_/g, ' ')}, the event's time zone. You appear to be in ${viewerTz.replace(/_/g, ' ')}; hover over or tap a slot to see your local time.`;
  }

  setupSignin(page);
  setupGroup(page);
  show('event');
}

// ---- time labels ----

function slotInfo(page, i) {
  const { meta, spd } = page;
  const day = Math.floor(i / spd), s = i % spd;
  const date = meta.dates[day];
  const from = meta.start + s * meta.step, to = from + meta.step;
  let text = `${core.formatDate(date)}, ${core.formatMinutes(from)} – ${core.formatMinutes(to)}`;
  if (meta.tz !== viewerTz) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: viewerTz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    text += ` (your time: ${fmt.format(core.zonedToUtc(date, from, meta.tz))})`;
  }
  return { day, s, date, from, text };
}

// Builds a dates-by-times grid. Cell i is the slot index (day-major).
function buildGrid(root, page) {
  const { meta, spd } = page;
  root.classList.toggle('fine', meta.step === 15);
  root.style.gridTemplateColumns = `auto repeat(${meta.dates.length}, minmax(40px, 1fr))`;
  const nodes = [el('div')];
  for (const d of meta.dates) {
    const [dow, md] = core.formatDate(d).split(', ');
    nodes.push(el('div', { className: 'g-head' }, el('b', { textContent: dow }), md));
  }
  const cells = [];
  for (let s = 0; s < spd; s++) {
    const min = meta.start + s * meta.step;
    nodes.push(el('div', { className: 'g-label', textContent: min % 60 === 0 ? core.formatMinutes(min) : '' }));
    for (let day = 0; day < meta.dates.length; day++) {
      const i = day * spd + s;
      const cell = el('div', { className: 'g-cell' + (min % 60 === 0 ? ' hour' : '') + (s === spd - 1 ? ' last' : '') });
      cell.dataset.i = i;
      cells[i] = cell;
      nodes.push(cell);
    }
  }
  root.replaceChildren(...nodes);
  return cells;
}

function cellIndex(root, x, y) {
  const t = document.elementFromPoint(x, y);
  return t && root.contains(t) && t.dataset.i !== undefined ? Number(t.dataset.i) : null;
}

// ---- your availability ----

function setupSignin(page) {
  const saved = store.get('me:' + page.ev.id, null);
  if (saved) return startPainting(page, saved);

  $('signin').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('name').value.trim();
    if (!name) return setStatus($('signin-status'), 'Enter your name.', true);
    const me = { name, psecret: await core.participantSecret(page.ev, name, $('password').value) };
    store.set('me:' + page.ev.id, me);
    startPainting(page, me);
  });
}

async function startPainting(page, me) {
  page.me = { ...me, pid: await core.pidFor(me.psecret) };
  const existing = page.responses.find(r => r.pid === page.me.pid);
  page.me.bits = existing ? existing.avail.slice() : new Array(page.n).fill(0);

  $('signin').hidden = true;
  $('mine').hidden = false;
  $('me-name').textContent = existing?.name ?? me.name;
  $('switch').onclick = () => {
    store.del('me:' + page.ev.id);
    location.reload();
  };

  const root = $('mine-grid');
  const cells = buildGrid(root, page);
  if (page.meta.tz !== viewerTz) cells.forEach((c, i) => { c.title = slotInfo(page, i).text; });
  const paint = () => cells.forEach((c, i) => {
    c.classList.toggle('on', page.me.bits[i] === core.YES);
    c.classList.toggle('maybe', page.me.bits[i] === core.IF_NEEDED);
  });
  paint();

  // Rectangle selection like when2meet: drag from one corner to the other.
  // The rectangle takes the state after the starting cell's: available -> if needed -> unavailable.
  let drag = null;
  const applyDrag = () => {
    const a = slotInfo(page, drag.from), b = slotInfo(page, drag.to);
    const [d0, d1] = [a.day, b.day].sort((x, y) => x - y), [s0, s1] = [a.s, b.s].sort((x, y) => x - y);
    page.me.bits = drag.base.map((v, i) => {
      const d = Math.floor(i / page.spd), s = i % page.spd;
      return d >= d0 && d <= d1 && s >= s0 && s <= s1 ? drag.value : v;
    });
    paint();
  };
  root.addEventListener('pointerdown', e => {
    const i = cellIndex(root, e.clientX, e.clientY);
    if (i === null) return;
    e.preventDefault();
    root.setPointerCapture(e.pointerId);
    drag = { from: i, to: i, value: (page.me.bits[i] + 1) % 3, base: page.me.bits.slice() };
    applyDrag();
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    const i = cellIndex(root, e.clientX, e.clientY);
    if (i !== null && i !== drag.to) {
      drag.to = i;
      applyDrag();
    }
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    scheduleSave(page);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}

// One save in flight at a time; edits made meanwhile are sent when it finishes.
// Failed saves retry with backoff, and leaving the page with unsaved edits prompts.
const save = { timer: null, inFlight: false, dirty: false, backoff: 0 };

window.addEventListener('beforeunload', e => {
  if (save.dirty || save.inFlight) e.preventDefault();
});

function scheduleSave(page) {
  save.dirty = true;
  setStatus($('save-status'), 'Saving…');
  clearTimeout(save.timer);
  save.timer = setTimeout(() => flushSave(page), 600);
}

async function flushSave(page) {
  if (save.inFlight || !save.dirty) return;
  save.inFlight = true;
  save.dirty = false;
  const bits = page.me.bits.slice();
  const name = $('me-name').textContent;
  try {
    await api.respond(page.ev, page.me.psecret, { name, ...core.encodeAvail(bits) });
    save.backoff = 0;
    const mine = { pid: page.me.pid, name, avail: bits };
    const i = page.responses.findIndex(r => r.pid === page.me.pid);
    if (i >= 0) page.responses[i] = mine; else page.responses.push(mine);
    renderGroup(page);
    if (!save.dirty) setStatus($('save-status'), 'Saved.');
  } catch (err) {
    save.dirty = true;
    save.backoff = Math.min((save.backoff || 1000) * 2, 30000);
    setStatus($('save-status'), `Not saved (${err.message}). Retrying in ${save.backoff / 1000} s…`, true);
    clearTimeout(save.timer);
    save.timer = setTimeout(() => flushSave(page), save.backoff);
    return;
  } finally {
    save.inFlight = false;
  }
  if (save.dirty) flushSave(page);
}

// ---- group availability ----

function setupGroup(page) {
  const root = $('group-grid');
  page.groupCells = buildGrid(root, page);

  const select = e => {
    const i = cellIndex(root, e.clientX, e.clientY);
    if (i !== null) showDetail(page, i);
  };
  root.addEventListener('pointermove', select);
  root.addEventListener('pointerdown', select);

  let last = Date.now();
  const refresh = async () => {
    last = Date.now();
    $('refresh').disabled = true;
    try {
      const { responses } = await openEvent(page.ev, await api.load(page.ev));
      page.responses = responses;
      renderGroup(page);
    } catch (err) {
      $('detail').replaceChildren(el('p', { className: 'status error', textContent: `Refresh failed: ${err.message}` }));
    } finally {
      $('refresh').disabled = false;
    }
  };
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - last > 15000) refresh();
  });
  renderGroup(page);
}

function counts(page) {
  const yes = new Array(page.n).fill(0), maybe = new Array(page.n).fill(0);
  for (const r of page.responses) {
    r.avail.forEach((v, i) => {
      if (v === core.YES) yes[i]++;
      else if (v === core.IF_NEEDED) maybe[i]++;
    });
  }
  return { yes, maybe };
}

function renderGroup(page) {
  const total = page.responses.length;
  const c = counts(page);
  // "If needed" counts as half toward the shading.
  page.groupCells.forEach((cell, i) => {
    const pct = total ? Math.round(((c.yes[i] + c.maybe[i] / 2) / total) * 100) : 0;
    cell.style.background = pct ? `color-mix(in oklab, var(--avail) ${pct}%, var(--cell))` : '';
  });

  const people = $('people');
  people.replaceChildren(el('span', { className: 'muted', textContent: total ? `${total} responded:` : 'No responses yet.' }));
  for (const r of [...page.responses].sort((a, b) => a.name.localeCompare(b.name))) {
    const chip = el('span', { className: 'chip', textContent: r.name, tabIndex: 0 });
    const hl = on => page.groupCells.forEach((cell, i) => cell.classList.toggle('hl', on && !!r.avail[i]));
    chip.onpointerenter = chip.onfocus = () => hl(true);
    chip.onpointerleave = chip.onblur = () => hl(false);
    people.append(chip);
  }

  const legend = $('legend');
  legend.replaceChildren();
  if (total) {
    legend.append(`0/${total}`);
    for (let k = 0; k <= total && k <= 6; k++) {
      const pct = Math.round((k / Math.min(total, 6)) * 100);
      const sw = el('span', { className: 'sw' });
      sw.style.background = `color-mix(in oklab, var(--avail) ${pct}%, var(--cell))`;
      legend.append(sw);
    }
    legend.append(`${total}/${total} available`);
    if (page.responses.some(r => r.avail.includes(core.IF_NEEDED))) legend.append(' · "if needed" counts as half');
  }

  renderBest(page, c, total);
  if (page.active != null) showDetail(page, page.active);
  else if (total) $('detail').replaceChildren(el('p', { className: 'muted', textContent: "Hover over or tap a slot to see who's free." }));
}

function showDetail(page, i) {
  if (page.active != null) page.groupCells[page.active]?.classList.remove('active');
  page.active = i;
  page.groupCells[i].classList.add('active');
  const names = state => page.responses.filter(r => r.avail[i] === state).map(r => r.name).sort();
  const yes = names(core.YES), maybe = names(core.IF_NEEDED), no = names(core.NO);
  $('detail').replaceChildren(
    el('p', {}, el('strong', { textContent: slotInfo(page, i).text })),
    el('p', { textContent: `Available (${yes.length}/${page.responses.length}): ${yes.join(', ') || 'nobody'}` }),
    ...(maybe.length ? [el('p', { textContent: `If needed: ${maybe.join(', ')}` })] : []),
    ...(no.length ? [el('p', { className: 'muted', textContent: `Unavailable: ${no.join(', ')}` })] : []),
  );
}

// Lists the contiguous blocks where the most people can make it, preferring
// slots where fewer of them are only "if needed".
function renderBest(page, c, total) {
  const root = $('best');
  const able = c.yes.map((y, i) => y + c.maybe[i]);
  const maxAble = Math.max(0, ...able);
  if (!total || !maxAble) return root.replaceChildren();
  const maxYes = Math.max(...c.yes.filter((_, i) => able[i] === maxAble));
  const best = i => able[i] === maxAble && c.yes[i] === maxYes;
  const runs = [];
  page.meta.dates.forEach((date, day) => {
    let startSlot = null;
    for (let s = 0; s <= page.spd; s++) {
      const hit = s < page.spd && best(day * page.spd + s);
      if (hit && startSlot === null) startSlot = s;
      if (!hit && startSlot !== null) {
        runs.push({ date, from: page.meta.start + startSlot * page.meta.step, to: page.meta.start + s * page.meta.step });
        startSlot = null;
      }
    }
  });
  runs.sort((a, b) => (b.to - b.from) - (a.to - a.from));
  root.replaceChildren(
    el('h2', { textContent: bestHeading(maxAble, maxAble - maxYes, total) }),
    el('ul', {}, ...runs.slice(0, 5).map(r =>
      el('li', { textContent: `${core.formatDate(r.date)}, ${core.formatMinutes(r.from)} – ${core.formatMinutes(r.to)}` }))),
  );
}

function bestHeading(able, ifNeeded, total) {
  const caveat = ifNeeded ? `, ${ifNeeded} only if needed` : '';
  if (able === total) return ifNeeded ? `Everyone can make it (${ifNeeded} only if needed)` : 'Everyone is free';
  return `Best times (${able} of ${total} can make it${caveat})`;
}
