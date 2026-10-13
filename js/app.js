import { parseScan, BRANDS, DEFAULT_BRAND_RULES } from './parser.js';
import { makePlacer, traySummary, groupCount, rangeProblems, isBlankSerial, capOf } from './trays.js';
import { newWorkspace, uid, shortId, stationsForMembers } from './defaults.js';
import * as db from './store.js';
import { SheetSync, makeJoinLink, readJoinLink, scanToRow, rowToScan, setupScript } from './sync.js';
import { loadScript } from './load.js';
import { exportWorkbook, readScansFromWorkbook, downloadText, scansToCsv, fmtTime, STATUS_TEXT } from './excel.js';

// ---------------------------------------------------------------- state ----

const state = {
  ws: null,
  scans: [], // sorted by ts, id
  byId: new Map(),
  view: 'scan',
  sync: null,
  syncStatus: null,
  logPage: 0,
  trayLayout: 'cards',
  lastResult: null,
};

const LS = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem('ddr.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('ddr.' + k, JSON.stringify(v));
    } catch {
      /* storage unavailable: preferences just won't persist */
    }
  },
};

let deviceId = LS.get('deviceId');
if (!deviceId) {
  deviceId = 'dev_' + shortId(8);
  LS.set('deviceId', deviceId);
}
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('ddr-tray-scanner') : null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const cls = (s) => String(s || '').replace(/[^\w]+/g, '-');
const brandChip = (b) => (b ? `<span class="chip b-${cls(b)}">${esc(b)}</span>` : '');
const genChip = (g, inferred) => (g ? `<span class="chip g-${cls(g)}" title="${inferred ? 'Inferred from part number' : 'From scan text'}">${esc(g)}${inferred ? ' ≈' : ''}</span>` : '<span class="muted">—</span>');
const statusText = (s) => {
  const icon = { placed: '✓', duplicate: '⚠', nopart: '⚠', full: '⛔', shipped: '📦' }[s] || '';
  return `<span class="st ${esc(s)}">${icon} ${esc(STATUS_TEXT[s] || s)}</span>`;
};

// "12/50", or just "12" when trays have no limit.
const ofCap = (n, cap) => (Number.isFinite(cap) ? `${n}/${cap}` : `${n}`);
const pctOf = (n, cap) => (Number.isFinite(cap) ? Math.min(100, Math.round((n / cap) * 100)) : 0);

function stationById(id) {
  return state.ws.stations.find((s) => s.id === id);
}
function currentStation() {
  const id = LS.get('station.' + state.ws.id);
  return stationById(id) || state.ws.stations[0];
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// Simple modal. actions: [{ label, value, cls }]. `bind(root)` wires inner controls.
function dialog({ title, body = '', actions = [{ label: 'Close', value: 'close' }], bind }) {
  const dlg = $('#dialog');
  // A fresh form per dialog so listeners added by `bind` never leak into the next one.
  const form = document.createElement('form');
  form.method = 'dialog';
  form.id = 'dialogForm';
  $('#dialogForm').replaceWith(form);
  form.innerHTML = `
    <h2>${esc(title)}</h2>
    <div class="dlg-body">${body}</div>
    <div class="dlg-actions">${actions.map((a) => `<button value="${esc(a.value)}" class="btn ${a.cls || ''}">${esc(a.label)}</button>`).join('')}</div>`;
  if (bind) bind(form);
  // Enter in a single-line field confirms with the primary button instead of the first one.
  form.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.matches('input') && !e.defaultPrevented) {
      e.preventDefault();
      const primary = form.querySelector('.dlg-actions .primary');
      if (primary) primary.click();
    }
  };
  return new Promise((resolve) => {
    dlg.onclose = () => {
      resolve(dlg.returnValue || 'close');
      focusScan();
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// ------------------------------------------------------------ feedback ----

let audioCtx = null;
function beep(kind) {
  if (!LS.get('sound', true)) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = { ok: [[1200, 0.08]], new: [[880, 0.09], [1320, 0.12]], bad: [[220, 0.25], [180, 0.25]] }[kind];
    let t = audioCtx.currentTime;
    for (const [f, d] of seq) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = kind === 'bad' ? 'square' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + d);
      t += d + 0.03;
    }
  } catch {
    /* audio unavailable */
  }
}
function speak(text) {
  if (!LS.get('voice', false) || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ---------------------------------------------------------- data layer ----

function sortScans() {
  state.scans.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function applyToMemory(upserts, deletes) {
  for (const id of deletes) state.byId.delete(id);
  for (const s of upserts) state.byId.set(s.id, s);
  state.scans = [...state.byId.values()];
  sortScans();
}

async function commit(upserts, deletes = []) {
  applyToMemory(upserts, deletes);
  await db.putScans(upserts);
  await db.deleteScans(deletes);
  if (state.sync) {
    const ops = [
      ...deletes.map((id) => ({ kind: 'delete', id })),
      ...upserts.map((s) => ({ kind: 'upsert', row: toRow(s) })),
    ];
    await state.sync.enqueue(ops);
  }
  channel && channel.postMessage({ type: 'scans', wsId: state.ws.id });
  scheduleRender();
}

function toRow(s) {
  return scanToRow(s, state.ws.id);
}

async function saveWorkspace() {
  state.ws.updatedAt = Date.now();
  await db.putWorkspace(state.ws);
  if (state.sync) await state.sync.pushWorkspace(state.ws);
  channel && channel.postMessage({ type: 'ws', wsId: state.ws.id });
  scheduleRender();
}

let lastTs = 0;
function nextTs() {
  const now = Date.now();
  const last = state.scans.length ? state.scans[state.scans.length - 1].ts : 0;
  lastTs = Math.max(now, last + 1, lastTs + 1);
  return lastTs;
}

function makeRecord(parsed, d, station) {
  return {
    id: uid(),
    wsId: state.ws.id,
    stationId: station.id,
    ...parsed,
    tray: d.tray,
    status: d.status,
    note: '',
    operator: LS.get('operator', '') || station.operator || '',
    device: deviceId,
    ts: nextTs(),
  };
}

// ---------------------------------------------------------------- scan ----

async function handleScan(raw) {
  raw = String(raw || '').trim();
  if (!raw) return;
  const station = currentStation();
  const parsed = parseScan(raw, state.ws.settings.brandRules);
  const placer = makePlacer(state.scans, state.ws.settings);
  const d = placer.place(parsed, station);
  const rec = makeRecord(parsed, d, station);
  await commit([rec]);
  showResult(rec, d);
}

async function handleBulk(lines) {
  const station = currentStation();
  const placer = makePlacer(state.scans, state.ws.settings);
  const recs = [];
  const tally = {};
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const parsed = parseScan(raw, state.ws.settings.brandRules);
    const d = placer.place(parsed, station);
    const rec = makeRecord(parsed, d, station);
    placer.commit(rec);
    recs.push(rec);
    tally[rec.status] = (tally[rec.status] || 0) + 1;
  }
  await commit(recs);
  toast(`Added ${recs.length} scans · ` + Object.entries(tally).map(([k, v]) => `${STATUS_TEXT[k]}: ${v}`).join(' · '), 5000);
}

function showResult(rec, d) {
  state.lastResult = { id: rec.id, d };
  const cap = capOf(state.ws.settings);
  const box = $('#result');
  box.className = 'result card';
  let kicker, tray, msg, kind;
  if (rec.status === 'placed') {
    const full = d.count >= cap;
    kind = d.newTray ? 'new' : 'ok';
    kicker = d.newTray ? (d.message.startsWith('Tray full') ? 'Previous tray full — new tray' : 'New part — new tray') : 'Add to tray';
    tray = rec.tray;
    msg = Number.isFinite(cap) ? `${d.count} / ${cap} sticks in this tray${full ? ' — tray is now FULL' : ''}` : `${d.count} stick${d.count === 1 ? '' : 's'} in this tray (no limit)`;
    box.classList.add(d.newTray ? 'new' : 'ok');
    beep(d.newTray ? 'new' : 'ok');
    speak(`Tray ${rec.tray}`);
  } else {
    kind = 'bad';
    box.classList.add('bad');
    beep('bad');
    if (rec.status === 'duplicate') {
      kicker = 'Duplicate serial';
      tray = d.dupOf && d.dupOf.tray != null ? d.dupOf.tray : '✕';
      msg = `${d.message}. Not placed.`;
      speak('Duplicate');
    } else if (rec.status === 'nopart') {
      kicker = 'No part number';
      tray = '✕';
      msg = 'Could not read a part number from this scan. Not placed.';
      speak('No part number');
    } else {
      kicker = 'All trays full';
      tray = '✕';
      msg = `${d.message}. Add trays to this station in Settings.`;
      speak('Trays full');
    }
  }
  const pct = rec.status === 'placed' ? pctOf(d.count, cap) : 0;
  box.innerHTML = `
    <div class="result-main">
      <div class="result-kicker">${esc(kicker)}</div>
      <div class="result-tray">${esc(tray)}</div>
      <div class="result-msg">${esc(msg)}</div>
      ${rec.status === 'placed' && Number.isFinite(cap) ? `<div class="fillbar"><span style="width:${pct}%"></span></div>` : ''}
      ${rec.status === 'duplicate' ? `<div class="row gap mt"><button class="btn" data-act="force">Place anyway</button><button class="btn" data-act="remove">Remove this scan</button></div>` : ''}
      ${rec.status === 'nopart' || rec.status === 'full' ? `<div class="row gap mt"><button class="btn" data-act="remove">Remove this scan</button></div>` : ''}
    </div>
    <dl class="result-side">
      <dt>Part #</dt><dd class="mono"><b>${esc(rec.part || '—')}</b></dd>
      <dt>Brand</dt><dd>${brandChip(rec.brand)}</dd>
      <dt>Gen</dt><dd>${genChip(rec.gen, rec.genInferred)}</dd>
      <dt>Label</dt><dd>${esc(rec.label || '—')}</dd>
      <dt>Serial</dt><dd class="mono">${esc(rec.serial || '—')}</dd>
      <dt>Station</dt><dd>${esc(stationById(rec.stationId)?.name || '')}</dd>
    </dl>`;
  void box.offsetWidth;
  box.classList.add('flash');
  box.dataset.kind = kind;
}

async function forcePlace(id) {
  const rec = state.byId.get(id);
  if (!rec) return;
  const station = stationById(rec.stationId) || currentStation();
  const others = state.scans.filter((s) => s.id !== id);
  const d = makePlacer(others, state.ws.settings).place(rec, station, { force: true });
  const upd = { ...rec, tray: d.tray, status: d.status, note: (rec.note ? rec.note + ' · ' : '') + 'duplicate serial accepted' };
  await commit([upd]);
  showResult(upd, d);
}

async function undoLast() {
  const mine = state.scans.filter((s) => s.device === deviceId);
  const last = mine[mine.length - 1];
  if (!last) return toast('Nothing to undo on this device');
  await commit([], [last.id]);
  toast(`Removed last scan (${last.part || 'no part'}${last.tray != null ? ' · tray ' + last.tray : ''})`);
  resetResult();
}

function resetResult() {
  const box = $('#result');
  box.className = 'result card idle';
  box.innerHTML = `<div class="result-main"><div class="result-kicker">Ready</div><div class="result-tray">—</div><div class="result-msg">Scan a stick to see which tray it goes in.</div></div><div class="result-side"></div>`;
}

function focusScan() {
  if (state.view === 'scan' && !$('#dialog').open) $('#scanInput').focus();
}

// ------------------------------------------------------------ rendering ----

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  if (!state.ws) return;
  $('#wsName').textContent = state.ws.name;
  renderSyncPill();
  const v = state.view;
  if (v === 'scan') renderScan();
  else if (v === 'trays') renderTrays();
  else if (v === 'find') renderFind();
  else if (v === 'dashboard') renderDashboard();
  else if (v === 'log') renderLog();
  else if (v === 'settings') renderSettings();
}

function renderSyncPill() {
  const pill = $('#syncPill');
  if (!state.ws.cloud) {
    pill.hidden = true;
    return;
  }
  const s = state.syncStatus || { state: 'syncing' };
  const text = {
    synced: '● Live',
    syncing: `↻ Syncing${s.pending ? ' ' + s.pending : ''}`,
    offline: `○ Offline${s.pending ? ' · ' + s.pending + ' queued' : ''}`,
    error: `⚠ Sync error${s.pending ? ' · ' + s.pending + ' queued' : ''}`,
  }[s.state] || s.state;
  pill.hidden = false;
  pill.className = 'pill ' + s.state;
  pill.textContent = text;
  pill.title = s.error || 'Team sync';
}

function stationOptions(selected, withAll) {
  return (withAll ? `<option value="">${esc(withAll)}</option>` : '') +
    state.ws.stations.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)} · ${s.trayStart}–${s.trayEnd}${s.operator ? ' · ' + esc(s.operator) : ''}</option>`).join('');
}

function renderScan() {
  const st = currentStation();
  const sel = $('#stationSelect');
  sel.innerHTML = stationOptions(st.id);
  const op = $('#operatorInput');
  if (document.activeElement !== op) op.value = LS.get('operator', '') || '';
  op.placeholder = st.operator || 'Your name';

  const mine = state.scans.filter((s) => s.stationId === st.id);
  const placed = mine.filter((s) => s.status === 'placed');
  const trays = new Set(placed.map((s) => s.tray));
  const total = st.trayEnd - st.trayStart + 1;
  $('#stationMeta').innerHTML = `<span>${placed.length} sticks · ${trays.size}/${total} trays used</span>`;

  const recent = mine.slice(-30).reverse();
  $('#recentTable').innerHTML = recent.length
    ? `<thead><tr><th>Time</th><th class="num">Tray</th><th>Part #</th><th>Brand</th><th>Gen</th><th class="hide-sm">Serial</th><th>Status</th><th></th></tr></thead><tbody>` +
      recent.map((s) => `<tr>
        <td class="small muted">${esc(fmtTime(s.ts).slice(11))}</td>
        <td class="num"><b>${s.tray ?? '—'}</b></td>
        <td class="mono">${esc(s.part || '—')}</td>
        <td>${brandChip(s.brand)}</td>
        <td>${genChip(s.gen, s.genInferred)}</td>
        <td class="mono hide-sm">${esc(s.serial || '—')}</td>
        <td>${statusText(s.status)}</td>
        <td><button class="btn small" data-edit="${esc(s.id)}">Edit</button></td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="muted">No scans at this station yet.</td></tr></tbody>';
}

function trayRows() {
  const cap = capOf(state.ws.settings);
  let rows = traySummary(state.scans, state.ws.stations, cap);
  const text = $('#trayFilterText').value.trim().toUpperCase();
  const station = $('#trayFilterStation').value;
  const brand = $('#trayFilterBrand').value;
  const gen = $('#trayFilterGen').value;
  const st = $('#trayFilterState').value;
  if (station) rows = rows.filter((r) => r.stationId === station);
  if (brand) rows = rows.filter((r) => r.brand === brand);
  if (gen) rows = rows.filter((r) => r.gen === gen);
  if (st === 'used') rows = rows.filter((r) => r.count > 0);
  else if (st === 'warn') rows = rows.filter((r) => r.mixed || r.state === 'over');
  else if (st === 'full') rows = rows.filter((r) => r.state === 'full' || r.state === 'over');
  else if (st) rows = rows.filter((r) => r.state === st);
  if (text) rows = rows.filter((r) => String(r.tray) === text || r.part.toUpperCase().includes(text) || r.label.toUpperCase().includes(text));
  return rows;
}

function renderTrays() {
  const fs = $('#trayFilterStation');
  const keep = fs.value;
  fs.innerHTML = stationOptions(keep, 'All stations');
  const fb = $('#trayFilterBrand');
  const keepB = fb.value;
  fb.innerHTML = '<option value="">All brands</option>' + BRANDS.map((b) => `<option ${b === keepB ? 'selected' : ''}>${b}</option>`).join('');

  const cap = capOf(state.ws.settings);
  const rows = trayRows();
  const shown = rows.slice(0, 1500);
  $('#trayCount').textContent = `${rows.length} trays${rows.length > shown.length ? ` (showing first ${shown.length})` : ''}`;
  const grid = $('#trayGrid');
  grid.classList.toggle('as-table', state.trayLayout === 'table');
  if (!rows.length) {
    grid.innerHTML = `<div class="card muted">No trays match. ${state.scans.length ? '' : 'Start scanning on the Scan tab — trays fill in here live.'}</div>`;
    return;
  }
  if (state.trayLayout === 'table') {
    grid.innerHTML = `<div class="card table-wrap"><table class="grid"><thead><tr><th class="num">Tray</th><th>Station</th><th>Part #</th><th>Brand</th><th>Gen</th><th>Label</th><th class="num">Sticks</th><th>Status</th></tr></thead><tbody>` +
      shown.map((r) => `<tr data-tray="${r.tray}" style="cursor:pointer">
        <td class="num"><b>${r.tray}</b></td><td>${esc(r.stationName)}</td><td class="mono">${esc(r.part || '—')}</td>
        <td>${brandChip(r.brand)}</td><td>${r.gen ? genChip(r.gen) : ''}</td><td>${esc(r.label)}</td>
        <td class="num">${r.count}</td><td>${trayBadge(r, cap)}</td></tr>`).join('') + '</tbody></table></div>';
    return;
  }
  grid.innerHTML = shown.map((r) => {
    const pct = pctOf(r.count, cap);
    return `<button class="tray ${r.state} b-${cls(r.brand)}" data-tray="${r.tray}">
      <div class="tray-top"><span class="tray-num">${r.tray}</span><span class="tray-count">${ofCap(r.count, cap)}</span></div>
      <div class="tray-part">${esc(r.part || 'Empty')}</div>
      <div class="tray-meta">${r.brand ? brandChip(r.brand) : ''}${r.gen ? genChip(r.gen) : ''}${trayBadge(r, cap)}</div>
      ${Number.isFinite(cap) ? `<div class="fillbar"><span style="width:${pct}%"></span></div>` : ''}
    </button>`;
  }).join('');
}

function trayBadge(r, cap) {
  if (r.mixed) return '<span class="badge warn">⚠ Mixed parts</span>';
  if (r.count > cap) return '<span class="badge warn">⚠ Over capacity</span>';
  if (r.count === cap) return '<span class="badge full">✓ FULL</span>';
  return r.count ? '' : '<span class="muted small">Empty</span>';
}

async function openTray(n) {
  const cap = capOf(state.ws.settings);
  const items = state.scans.filter((s) => s.tray === n && s.status === 'placed');
  const shipped = state.scans.filter((s) => s.tray === n && s.status === 'shipped');
  const st = state.ws.stations.find((s) => n >= s.trayStart && n <= s.trayEnd);
  const body = `
    <p>${esc(st ? st.name : '')} · <b>${ofCap(items.length, cap)}</b> sticks${shipped.length ? ` · ${shipped.length} shipped earlier` : ''}</p>
    ${items.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>#</th><th>Part #</th><th>Serial</th><th>Gen</th><th>Label</th><th>Scanned</th><th></th></tr></thead><tbody>` +
      items.map((s, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(s.part)}</td><td class="mono">${esc(s.serial || '—')}</td><td>${genChip(s.gen, s.genInferred)}</td><td>${esc(s.label)}</td><td class="small muted">${esc(fmtTime(s.ts))}</td><td><button type="button" class="btn small" data-del="${esc(s.id)}">Remove</button></td></tr>`).join('') +
      '</tbody></table></div>' : '<p class="muted">This tray is empty.</p>'}`;
  const actions = [{ label: 'Close', value: 'close' }];
  if (items.length) {
    actions.unshift({ label: 'Download list (CSV)', value: 'csv' });
    actions.unshift({ label: '📦 Mark shipped & free tray', value: 'ship', cls: 'primary' });
  }
  const res = await dialog({
    title: `Tray ${n}`,
    body,
    actions,
    bind(root) {
      root.addEventListener('click', async (e) => {
        const id = e.target.dataset && e.target.dataset.del;
        if (!id) return;
        e.preventDefault();
        if (!confirm('Remove this stick from the tray?')) return;
        await commit([], [id]);
        e.target.closest('tr').remove();
      });
    },
  });
  if (res === 'ship') {
    if (!confirm(`Mark all ${items.length} sticks in tray ${n} as shipped? The tray becomes empty and can be reused. The records stay in the Log.`)) return;
    await commit(items.map((s) => ({ ...s, status: 'shipped', note: (s.note ? s.note + ' · ' : '') + 'shipped ' + fmtTime(Date.now()) })));
    toast(`Tray ${n} shipped and freed`);
  } else if (res === 'csv') {
    downloadText(`tray-${n}.csv`, scansToCsv(items, state.ws.stations), 'text/csv');
  }
}

function renderFind() {
  const q = $('#findInput').value.trim();
  const out = $('#findResults');
  if (!q) {
    out.innerHTML = '<div class="card muted">Type or scan a part number, serial number, or part of a label. Matches show which trays hold it.</div>';
    return;
  }
  let part = q.toUpperCase();
  let serial = q.toUpperCase();
  if (/\((P|S|L)\)/i.test(q) || q.includes(' ')) {
    const p = parseScan(q, state.ws.settings.brandRules);
    if (p.part) part = p.part;
    if (p.serial) serial = p.serial.toUpperCase();
  }
  const serialHits = state.scans.filter((s) => !isBlankSerial(s.serial) && s.serial.toUpperCase() === serial);
  const placed = state.scans.filter((s) => s.status === 'placed');
  const exact = placed.filter((s) => s.part === part);
  const loose = exact.length ? [] : placed.filter((s) => s.part.includes(part) || (s.label || '').toUpperCase().includes(part));
  const hits = exact.length ? exact : loose;
  const byTray = new Map();
  for (const s of hits) {
    const t = byTray.get(s.tray) || { tray: s.tray, part: s.part, brand: s.brand, gen: s.gen, count: 0, stationId: s.stationId };
    t.count++;
    byTray.set(s.tray, t);
  }
  const cap = capOf(state.ws.settings);
  let html = '';
  if (serialHits.length) {
    html += `<div class="card"><h2>Serial number</h2>` + serialHits.map((s) => `<div class="find-hit"><span class="big">${s.tray ?? '—'}</span><div>${statusText(s.status)}<div class="mono">${esc(s.part)} · ${esc(s.serial)}</div><div class="small muted">${esc(stationById(s.stationId)?.name || '')} · ${esc(fmtTime(s.ts))}</div></div></div>`).join('') + '</div>';
  }
  if (byTray.size) {
    html += `<div class="card"><h2>${exact.length ? 'Trays holding this part' : 'Similar parts'} · ${hits.length} sticks</h2><div class="tray-grid">` +
      [...byTray.values()].sort((a, b) => a.tray - b.tray).map((t) => `<button class="tray b-${cls(t.brand)}" data-tray="${t.tray}">
        <div class="tray-top"><span class="tray-num">${t.tray}</span><span class="tray-count">${ofCap(t.count, cap)}</span></div>
        <div class="tray-part">${esc(t.part)}</div>
        <div class="tray-meta">${brandChip(t.brand)}${t.gen ? genChip(t.gen) : ''}<span>${esc(stationById(t.stationId)?.name || '')}</span></div></button>`).join('') + '</div></div>';
  }
  if (!html) html = `<div class="card">No tray holds <b class="mono">${esc(part)}</b>. ${part ? 'Scanning it on the Scan tab would open a new tray.' : ''}</div>`;
  out.innerHTML = html;
}

function bars(entries, colorFor, total, onClickAttr) {
  if (!entries.length) return '<p class="muted small">No data yet.</p>';
  const max = Math.max(...entries.map((e) => e[1]));
  return '<div class="bars">' + entries.map(([k, v]) => {
    const pct = total ? Math.round((v / total) * 1000) / 10 : 0;
    const style = colorFor ? `style="--c:${colorFor(k)};width:${(v / max) * 100}%"` : `style="width:${(v / max) * 100}%"`;
    return `<div class="row-hit" title="${esc(k)}: ${v.toLocaleString()} sticks (${pct}%)" ${onClickAttr ? onClickAttr(k) : ''}>
      <span class="lbl">${esc(k)}</span><span class="track"><span class="bar" ${style}></span></span><span class="val">${v.toLocaleString()}</span></div>`;
  }).join('') + '</div>';
}

function renderDashboard() {
  const cap = capOf(state.ws.settings);
  const placed = state.scans.filter((s) => s.status === 'placed');
  const rows = traySummary(state.scans, state.ws.stations, cap);
  const used = rows.filter((r) => r.count > 0).length;
  const full = rows.filter((r) => r.count >= cap).length;
  const problems = state.scans.filter((s) => ['duplicate', 'nopart', 'full'].includes(s.status)).length;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const scannedToday = state.scans.filter((s) => s.ts >= today.getTime()).length;
  const shipped = state.scans.filter((s) => s.status === 'shipped').length;
  const parts = new Set(placed.map((s) => s.part)).size;
  const kpi = (k, v, s = '') => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $('#kpis').innerHTML =
    kpi('Sticks in trays', placed.length.toLocaleString(), `${parts} distinct part numbers`) +
    kpi('Trays in use', `${used}`, `of ${rows.length} · ${full} full`) +
    kpi('Scanned today', scannedToday.toLocaleString(), `${shipped.toLocaleString()} shipped overall`) +
    kpi('Needs attention', problems.toLocaleString(), 'duplicates, unreadable, no tray');

  const brandColor = (b) => `var(--${{ Samsung: 'samsung', 'SK Hynix': 'hynix', Micron: 'micron', Crucial: 'crucial', Kingston: 'kingston' }[b] || 'unknown'})`;
  $('#byBrand').innerHTML = bars(groupCount(state.scans, 'brand'), brandColor, placed.length);
  const genColor = (g) => `var(--${{ DDR3: 'ddr3', DDR4: 'ddr4', DDR5: 'ddr5' }[g] || 'unknown'})`;
  $('#byGen').innerHTML = bars(groupCount(state.scans, 'gen'), genColor, placed.length);
  const byStation = state.ws.stations.map((st) => [st.name, placed.filter((s) => s.stationId === st.id).length]).filter((e) => e[1] > 0);
  $('#byStation').innerHTML = bars(byStation, null, placed.length);
  $('#byPart').innerHTML = bars(groupCount(state.scans, 'part').slice(0, 15), null, placed.length, (k) => `data-find="${esc(k)}" style="cursor:pointer"`);
}

const PAGE = 100;
function logRows() {
  const q = $('#logFilterText').value.trim().toUpperCase();
  const st = $('#logFilterStation').value;
  const status = $('#logFilterStatus').value;
  let rows = state.scans;
  if (st) rows = rows.filter((s) => s.stationId === st);
  if (status) rows = rows.filter((s) => s.status === status);
  if (q) rows = rows.filter((s) => [s.part, s.serial, s.raw, s.note, s.label, s.operator, String(s.tray ?? '')].some((v) => String(v || '').toUpperCase().includes(q)));
  return rows.slice().reverse();
}

function renderLog() {
  const fs = $('#logFilterStation');
  fs.innerHTML = stationOptions(fs.value, 'All stations');
  const rows = logRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  state.logPage = Math.min(state.logPage, pages - 1);
  const slice = rows.slice(state.logPage * PAGE, state.logPage * PAGE + PAGE);
  $('#logTable').innerHTML = slice.length
    ? `<thead><tr><th>Scanned</th><th>Station</th><th class="num">Tray</th><th>Part #</th><th>Brand</th><th>Gen</th><th>Serial</th><th>Status</th><th>Operator</th><th>Note</th><th class="hide-sm">Raw scan</th><th></th></tr></thead><tbody>` +
      slice.map((s) => `<tr>
        <td class="small muted">${esc(fmtTime(s.ts))}</td>
        <td>${esc(stationById(s.stationId)?.name || s.stationId)}</td>
        <td class="num"><b>${s.tray ?? '—'}</b></td>
        <td class="mono">${esc(s.part || '—')}</td>
        <td>${brandChip(s.brand)}</td>
        <td>${genChip(s.gen, s.genInferred)}</td>
        <td class="mono">${esc(s.serial || '—')}</td>
        <td>${statusText(s.status)}</td>
        <td>${esc(s.operator)}</td>
        <td class="small">${esc(s.note)}</td>
        <td class="raw hide-sm" title="${esc(s.raw)}">${esc(s.raw)}</td>
        <td><button class="btn small" data-edit="${esc(s.id)}">Edit</button></td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="muted">No scans match.</td></tr></tbody>';
  $('#logPager').innerHTML = `<span>${rows.length.toLocaleString()} scans</span>
    <button class="btn small" data-page="-1" ${state.logPage === 0 ? 'disabled' : ''}>‹ Newer</button>
    <span>Page ${state.logPage + 1} / ${pages}</span>
    <button class="btn small" data-page="1" ${state.logPage >= pages - 1 ? 'disabled' : ''}>Older ›</button>`;
}

async function editScan(id) {
  const s = state.byId.get(id);
  if (!s) return;
  const res = await dialog({
    title: 'Edit scan',
    body: `
      <p class="mono small" style="overflow-wrap:anywhere">${esc(s.raw)}</p>
      <p>${brandChip(s.brand)} ${genChip(s.gen, s.genInferred)} <span class="mono">${esc(s.part)}</span> · ${statusText(s.status)}</p>
      <div class="row gap wrap">
        <label class="field"><span>Tray # (manual move)</span><input id="edTray" type="number" value="${s.tray ?? ''}"></label>
        <label class="field" style="flex:1"><span>Note</span><input id="edNote" value="${esc(s.note)}"></label>
      </div>`,
    actions: [
      { label: 'Delete scan', value: 'delete', cls: 'danger' },
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'save', cls: 'primary' },
    ],
    bind(root) {
      root.querySelector('#edNote').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), root.querySelector('button[value=save]').click()));
      dialog.vals = () => ({ tray: root.querySelector('#edTray').value, note: root.querySelector('#edNote').value });
    },
  });
  if (res === 'delete') {
    if (confirm('Delete this scan? If the stick is in a tray, take it out.')) await commit([], [id]);
  } else if (res === 'save') {
    const v = dialog.vals();
    const upd = { ...s, note: v.note.trim() };
    if (v.tray !== '' && Number(v.tray) !== s.tray) {
      const n = parseInt(v.tray, 10);
      if (!Number.isInteger(n) || n < 1) return toast('Tray must be a positive number');
      upd.tray = n;
      if (s.status !== 'shipped') upd.status = 'placed';
    }
    await commit([upd]);
  }
}

// ------------------------------------------------------------- settings ----

function rulesToText(rules) {
  return rules.map((r) => `${r.brand} | ${r.prefixes.join(', ')} | ${r.contains.join(', ')}${r.rawContains && r.rawContains.length ? ' | ' + r.rawContains.join(', ') : ''}`).join('\n');
}
function textToRules(text) {
  const split = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [brand, prefixes, contains, raw] = l.split('|').map((x) => x.trim());
    return { brand, prefixes: split(prefixes), contains: split(contains), rawContains: split(raw) };
  }).filter((r) => r.brand);
}

function renderSettings() {
  const ws = state.ws;
  if (document.activeElement !== $('#wsNameInput')) $('#wsNameInput').value = ws.name;
  const unlimited = ws.settings.capacity === 0;
  $('#noLimitInput').checked = unlimited;
  $('#capacityInput').disabled = unlimited;
  if (document.activeElement !== $('#capacityInput')) $('#capacityInput').value = unlimited ? '' : capOf(ws.settings);
  renderStorageInfo();
  $('#dupSerialInput').checked = !!ws.settings.allowDuplicateSerials;
  $('#soundInput').checked = LS.get('sound', true);
  $('#voiceInput').checked = LS.get('voice', false);
  if (document.activeElement !== $('#rulesInput')) $('#rulesInput').value = rulesToText(ws.settings.brandRules);

  const counts = groupCount(state.scans, 'stationId', () => true);
  const countOf = new Map(counts);
  if (!$('#stationsTable').contains(document.activeElement)) {
    $('#stationsTable').innerHTML = `<thead><tr><th>Member / station</th><th>Person scanning</th><th class="num">First tray</th><th class="num">Last tray</th><th class="num">Scans</th><th></th></tr></thead><tbody>` +
      ws.stations.map((s) => `<tr data-st="${esc(s.id)}">
        <td><input data-f="name" value="${esc(s.name)}"></td>
        <td><input data-f="operator" value="${esc(s.operator)}"></td>
        <td class="num"><input data-f="trayStart" type="number" min="1" value="${s.trayStart}"></td>
        <td class="num"><input data-f="trayEnd" type="number" min="1" value="${s.trayEnd}"></td>
        <td class="num">${(countOf.get(s.id) || 0).toLocaleString()}</td>
        <td><button class="btn small danger" data-remove-st="${esc(s.id)}" ${countOf.get(s.id) ? 'disabled title="Has scans"' : ''}>Remove</button></td></tr>`).join('') + '</tbody>';
  }
  renderSyncCard();
}

function gsheetSecret() {
  let sec = LS.get('gsheetSecret');
  if (!sec) {
    sec = shortId(24);
    LS.set('gsheetSecret', sec);
  }
  return sec;
}

let scriptTemplate = null;
async function copySetupScript() {
  try {
    if (!scriptTemplate) {
      const res = await fetch('gsheet/Code.gs', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      scriptTemplate = await res.text();
    }
    const text = setupScript(scriptTemplate, gsheetSecret());
    try {
      await navigator.clipboard.writeText(text);
      toast('Script copied — paste it into Apps Script', 4000);
    } catch {
      await dialog({ title: 'Copy this script', body: `<textarea rows="14" readonly id="scriptText">${esc(text)}</textarea>`, bind: (r) => setTimeout(() => r.querySelector('#scriptText').select(), 50) });
    }
  } catch (e) {
    toast('Could not load the script: ' + e.message, 5000);
  }
}

function renderSyncCard() {
  const ws = state.ws;
  const body = $('#syncBody');
  if (ws.cloud) {
    const s = state.syncStatus || {};
    const link = makeJoinLink(ws);
    body.innerHTML = `
      <p>This project is <b>shared with your team through your Google Sheet</b>. Every member's scans appear for everyone within a few seconds. Each device also keeps its own full copy, so scanning keeps working offline and uploads later.</p>
      <p>Status: <b>${esc(s.state || 'connecting')}</b>${s.pending ? ` · ${s.pending} change(s) waiting to upload` : ''}${s.error ? ` · <span class="warn-text">${esc(s.error)}</span>` : ''}
      ${ws.cloud.sheetUrl ? ` · <a href="${esc(ws.cloud.sheetUrl)}" target="_blank" rel="noopener">Open the Google Sheet ↗</a>` : ''}</p>
      <label class="field"><span>Team link — send this to your team (anyone with it can view and edit this project)</span>
      <div class="share-box"><input id="shareLink" readonly value="${esc(link)}"><button class="btn primary" id="copyLink">Copy</button></div></label>
      <div class="row gap wrap mt"><button class="btn" id="resyncBtn">Reload from Google Sheet</button><button class="btn danger" id="unlinkBtn">Stop syncing on this device</button></div>`;
    return;
  }
  const saved = LS.get('gsheet', {}) || {};
  body.innerHTML = `
    <p>Right now this project lives <b>only in this browser</b>. Anyone else who opens the app gets their <b>own separate projects</b> — their scans never mix with yours.</p>
    <p>To let a team work on the <b>same</b> project live, connect a <b>Google Sheet in your own Google Drive</b> (free with any Gmail account; you own the data and can open it like Excel). One-time setup, about 5 minutes:</p>
    <ol class="steps small">
      <li>Create a new Google Sheet: <a href="https://sheet.new" target="_blank" rel="noopener">sheet.new ↗</a> (name it e.g. “DDR Tray Scanner Data”).</li>
      <li>In the sheet: <b>Extensions → Apps Script</b>. Delete the code there, then <button class="btn small" id="copyScriptBtn">Copy setup script</button> and paste it in. Click 💾 <b>Save</b>.</li>
      <li><b>Deploy → New deployment</b> → ⚙ <b>Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b> → <b>Deploy</b> → <b>Authorize access</b> (pick your account → <i>Advanced</i> → <i>Go to … (unsafe)</i> → <i>Allow</i> — this is your own script).</li>
      <li>Copy the <b>Web app URL</b> and paste it here:</li>
    </ol>
    <div class="row gap wrap">
      <label class="field" style="flex:1 1 420px"><span>Web app URL</span><input id="gsUrl" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(saved.url || '')}"></label>
    </div>
    <div class="row gap wrap mt"><button class="btn primary" id="shareBtn">Connect &amp; share this project</button></div>
    <p class="muted small mt">The copied script contains this device's private secret, so only this app can use your sheet. The same sheet can hold many projects. Got a team link from someone? Just open it — or use the project menu (top right) → “Join with a team link”.</p>`;
}

// ------------------------------------------------------------ workspaces ----

async function openWorkspace(id) {
  if (state.sync) {
    state.sync.close();
    state.sync = null;
  }
  state.syncStatus = null;
  const ws = await db.getWorkspace(id);
  if (!ws) throw new Error('Workspace not found');
  ws.settings = { capacity: 50, allowDuplicateSerials: false, brandRules: structuredClone(DEFAULT_BRAND_RULES), ...ws.settings };
  state.ws = ws;
  LS.set('lastWs', id);
  const scans = await db.getScans(id);
  state.byId = new Map(scans.map((s) => [s.id, s]));
  state.scans = scans;
  sortScans();
  state.logPage = 0;
  resetResult();
  render();
  if (ws.cloud) startSync().catch((e) => console.error(e));
}

async function startSync() {
  const ws = state.ws;
  const sync = new SheetSync({
    url: ws.cloud.url,
    key: ws.cloud.key,
    wsId: ws.id,
    onScans: (ups, dels) => applyRemote(ws.id, ups, dels),
    onWorkspace: (w) => applyRemoteWorkspace(ws.id, w),
    onStatus: (s) => {
      state.syncStatus = s;
      renderSyncPill();
      if (state.view === 'settings') renderSyncCard();
    },
  });
  state.sync = sync;
  state.syncStatus = { state: 'syncing' };
  renderSyncPill();
  let ok = true;
  try {
    await sync.init();
    if (sync.sheetUrl && ws.cloud && ws.cloud.sheetUrl !== sync.sheetUrl) {
      ws.cloud.sheetUrl = sync.sheetUrl;
      await db.putWorkspace(ws);
    }
    await pullFromCloud(sync, !ws.joined);
  } catch (e) {
    ok = false;
    sync.lastError = e.message;
    state.syncStatus = { state: navigator.onLine ? 'error' : 'offline', error: e.message };
    renderSyncPill();
    toast('Could not reach the team Google Sheet — working offline. Scans are saved on this device and will upload later.', 5000);
  }
  if (state.sync === sync) {
    sync.subscribe();
    sync.flush();
  }
  return ok;
}

async function pullFromCloud(sync, publishIfMissing) {
  const ws = state.ws;
  const remote = await sync.fetchWorkspace();
  if (!remote) {
    if (!publishIfMissing) throw new Error('Project not found in the Google Sheet');
    await sync.publish(ws, state.scans);
  } else {
    ws.name = remote.name;
    ws.stations = remote.stations && remote.stations.length ? remote.stations : ws.stations;
    ws.settings = { ...ws.settings, ...remote.settings };
    await db.putWorkspace(ws);
  }
  const remoteScans = await sync.fetchAllScans();
  if (state.sync !== sync) return;
  // Keep local changes that have not been uploaded yet.
  const pending = await db.outboxList(ws.id);
  const map = new Map(remoteScans.map((s) => [s.id, s]));
  for (const p of pending) {
    if (p.kind === 'delete') map.delete(p.id);
    else if (p.kind === 'upsert') map.set(p.row.id, rowToScan(p.row));
  }
  const merged = [...map.values()].map((s) => ({ ...s, wsId: ws.id }));
  await db.replaceScans(ws.id, merged);
  state.byId = new Map(merged.map((s) => [s.id, s]));
  state.scans = merged;
  sortScans();
  scheduleRender();
}

function applyRemote(wsId, ups, dels) {
  if (!state.ws || state.ws.id !== wsId) return;
  const realDels = dels.filter((id) => state.byId.has(id));
  const realUps = ups.map((s) => ({ ...s, wsId }));
  if (!realUps.length && !realDels.length) return;
  applyToMemory(realUps, realDels);
  db.putScans(realUps).then(() => db.deleteScans(realDels));
  scheduleRender();
}

function applyRemoteWorkspace(wsId, w) {
  if (!state.ws || state.ws.id !== wsId) return;
  if (w.name) state.ws.name = w.name;
  if (w.stations && w.stations.length) state.ws.stations = w.stations;
  if (w.settings) state.ws.settings = { ...state.ws.settings, ...w.settings };
  db.putWorkspace(state.ws);
  scheduleRender();
}

async function createWorkspace(name) {
  const ws = newWorkspace(name || 'My Project');
  await db.putWorkspace(ws);
  await openWorkspace(ws.id);
  return ws;
}

async function joinTeam(info) {
  let ws = await db.getWorkspace(info.wsId);
  if (!ws) {
    ws = newWorkspace(info.name);
    ws.id = info.wsId;
    ws.joined = true; // never publish a blank project over the team's copy
    ws.cloud = { url: info.url, key: info.key };
    await db.putWorkspace(ws);
  } else if (!ws.cloud) {
    ws.cloud = { url: info.url, key: info.key };
    await db.putWorkspace(ws);
  }
  LS.set('gsheet', { url: info.url, key: info.key });
  await openWorkspace(ws.id);
  toast(`Joined “${info.name}”`);
}

async function newProjectWizard() {
  const saved = LS.get('gsheet', {}) || {};
  const canShare = !!(saved.url && saved.key);
  const res = await dialog({
    title: 'New project',
    body: `
      <div class="wizard">
        <label class="field"><span>Project name</span><input id="npName" value="${esc('Batch ' + new Date().toLocaleDateString())}"></label>
        <label class="field"><span>Project members — one name per line (each gets their own trays)</span>
          <textarea id="npMembers" rows="6" placeholder="Ashu&#10;Ronny&#10;Elvira">${esc(state.ws.stations.map((s) => s.operator || s.name).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 7).join('\n'))}</textarea></label>
        <div class="row gap wrap">
          <label class="field"><span>Trays per member</span><input id="npTrays" type="number" min="1" max="10000" value="100"></label>
          <label class="field"><span>Sticks per tray</span><input id="npCap" type="number" min="1" max="1000" value="50"></label>
          <label class="check"><input id="npNoLimit" type="checkbox"> No limit</label>
        </div>
        ${canShare ? '<label class="check mt"><input id="npShare" type="checkbox" checked> Share live with my team (uses your connected Google Sheet)</label>' : ''}
        <p class="small muted mt" id="npPreview"></p>
      </div>`,
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create project', value: 'ok', cls: 'primary' }],
    bind(root) {
      const q = (id) => root.querySelector(id);
      const read = () => {
        const members = q('#npMembers').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        return {
          name: q('#npName').value.trim() || 'New project',
          members: members.length ? [...new Set(members)] : ['Station 1'],
          trays: Math.max(1, parseInt(q('#npTrays').value, 10) || 100),
          cap: q('#npNoLimit').checked ? 0 : Math.max(1, parseInt(q('#npCap').value, 10) || 50),
          share: !!(q('#npShare') && q('#npShare').checked),
        };
      };
      const preview = () => {
        const v = read();
        q('#npCap').disabled = v.cap === 0;
        q('#npPreview').innerHTML = stationsForMembers(v.members, v.trays).map((s) => `<b>${esc(s.name)}</b>: trays ${s.trayStart}–${s.trayEnd}`).join(' · ') +
          `<br>${v.cap ? `Up to ${v.cap} sticks per tray, then a new tray opens.` : 'No limit: all sticks of the same part number go in one tray.'}`;
      };
      root.addEventListener('input', preview);
      preview();
      dialog.wizard = read;
    },
  });
  if (res !== 'ok') return;
  const v = dialog.wizard();
  const ws = newWorkspace(v.name);
  ws.stations = stationsForMembers(v.members, v.trays);
  ws.settings.capacity = v.cap;
  await db.putWorkspace(ws);
  await openWorkspace(ws.id);
  setView('scan');
  if (v.share) {
    state.ws.cloud = { url: saved.url, key: saved.key };
    await db.putWorkspace(state.ws);
    if (await startSync()) {
      toast('Project created and shared — copy the team link in Settings', 5000);
      render();
      return;
    }
    if (state.sync) state.sync.close(), (state.sync = null);
    state.ws.cloud = null;
    state.syncStatus = null;
    await db.putWorkspace(state.ws);
    render();
    toast('Project created, but the Google Sheet could not be reached — it is saved on this device only for now.', 7000);
    return;
  }
  toast(`Project “${v.name}” created with ${v.members.length} member${v.members.length === 1 ? '' : 's'}`);
}

let persisted = null;
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch {
    persisted = null;
  }
}

function renderStorageInfo() {
  const box = $('#storageInfo');
  if (!box) return;
  const last = LS.get('backup.' + state.ws.id);
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  box.innerHTML = `
    <ul class="steps small">
      <li><b>Every scan is saved instantly</b> to this browser's built-in database (IndexedDB) on this device — before the tray number even appears. Closing the tab, the browser, a crash or a power cut loses nothing: open the same link on the same device and browser and everything is back.</li>
      <li>Browser storage protection: ${persisted ? '<b style="color:var(--good)">ON</b> — the browser will not auto-delete this data.' : persisted === false ? '<b>not granted</b> by this browser (data is still saved; keep regular backups).' : 'unknown in this browser.'}</li>
      <li>${state.ws.cloud ? '<b>Team project:</b> every scan is also uploaded to your team’s Google Sheet, so it is safe even if this device is lost, and other members see it live.' : '<b>Only on this device.</b> Data is lost if you clear browsing data, use a private/incognito window, or switch to another device/browser.'}</li>
      <li>Last backup of this project: <b>${last ? (days === 0 ? 'today' : days + ' day(s) ago') : 'never'}</b>. ${!state.ws.cloud ? 'Use “Download backup” or “Export Excel” below at the end of each day.' : ''}</li>
    </ul>`;
}

async function workspaceMenu() {
  const all = (await db.listWorkspaces()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const res = await dialog({
    title: 'Projects on this device',
    body: `<div class="ws-list">${all.map((w) => `
      <div class="ws-item ${w.id === state.ws.id ? 'current' : ''}">
        <div class="grow"><b>${esc(w.name)}</b><div class="small muted">${w.cloud ? '● Team (synced)' : 'Only on this device'}</div></div>
        ${w.id === state.ws.id ? '<span class="small muted">Open</span>' : `<button class="btn small" value="open:${esc(w.id)}">Open</button>`}
      </div>`).join('')}</div>
      <p class="muted small">Each project has its own members, trays and scans. Use one per batch, shipment, shift or customer.</p>`,
    actions: [
      { label: 'Join with a team link', value: 'join' },
      { label: '+ New project', value: 'new', cls: 'primary' },
      { label: 'Close', value: 'close' },
    ],
  });
  if (res.startsWith('open:')) await openWorkspace(res.slice(5));
  else if (res === 'new') await newProjectWizard(); else if (res === 'join') {
    const link = prompt('Paste the team link');
    const info = link && readJoinLink(link.slice(link.indexOf('#')));
    if (link && !info) return toast('That link is not a valid team link');
    if (info) await joinTeam(info);
  }
}

// ------------------------------------------------------- import/export ----

async function importExcel(file) {
  toast('Reading workbook…', 10000);
  let sheets;
  try {
    sheets = await readScansFromWorkbook(file);
  } catch (e) {
    return toast('Could not read file: ' + e.message, 6000);
  }
  const total = sheets.reduce((n, s) => n + s.scans.length, 0);
  if (!total) return toast('No scans found. Expected sheets named like “1-100” with scans in column B.', 6000);
  const list = sheets.filter((s) => s.scans.length).map((s) => `<li>${esc(s.sheet)}: ${s.scans.length.toLocaleString()} scans</li>`).join('');
  const res = await dialog({
    title: 'Import from Excel',
    body: `<p>Found <b>${total.toLocaleString()}</b> scans:</p><ul>${list}</ul><p class="small muted">Each sheet goes to the station with the same tray range (a new station is created if none matches). Scans are placed in their original order using this app's rules.</p>`,
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Import', value: 'ok', cls: 'primary' }],
  });
  if (res !== 'ok') return;
  let stationsChanged = false;
  const placer = makePlacer(state.scans, state.ws.settings);
  const recs = [];
  for (const sh of sheets) {
    if (!sh.scans.length) continue;
    let st = state.ws.stations.find((s) => s.trayStart === sh.trayStart && s.trayEnd === sh.trayEnd);
    if (!st) {
      const cand = { id: 'st_' + shortId(6), name: `Sheet ${sh.sheet}`, operator: '', trayStart: sh.trayStart, trayEnd: sh.trayEnd };
      if (rangeProblems([...state.ws.stations, cand]).length) {
        toast(`Skipped sheet ${sh.sheet}: its tray range overlaps an existing station`, 6000);
        continue;
      }
      state.ws.stations.push(cand);
      stationsChanged = true;
      st = cand;
    }
    for (const raw of sh.scans) {
      const parsed = parseScan(raw, state.ws.settings.brandRules);
      const d = placer.place(parsed, st);
      const rec = makeRecord(parsed, d, st);
      rec.operator = st.operator || '';
      rec.note = 'imported from ' + file.name;
      placer.commit(rec);
      recs.push(rec);
    }
  }
  if (stationsChanged) await saveWorkspace();
  await commit(recs);
  toast(`Imported ${recs.length.toLocaleString()} scans`, 5000);
}

function backup() {
  const data = { format: 'ddr-tray-scanner', version: 1, exportedAt: new Date().toISOString(), workspace: { ...state.ws, cloud: null }, scans: state.scans };
  downloadText(`${state.ws.name.replace(/[^\w-]+/g, '_')}_backup.json`, JSON.stringify(data));
  LS.set('backup.' + state.ws.id, Date.now());
  if (state.view === 'settings') renderStorageInfo();
}

async function restore(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('Not a valid backup file');
  }
  if (data.format !== 'ddr-tray-scanner' || !data.workspace) return toast('Not a DDR Tray Scanner backup');
  const ws = { ...newWorkspace(), ...data.workspace, id: newWorkspace().id, cloud: null, name: data.workspace.name + ' (restored)' };
  await db.putWorkspace(ws);
  await db.putScans((data.scans || []).map((s) => ({ ...s, id: uid(), wsId: ws.id })));
  await openWorkspace(ws.id);
  toast(`Restored ${(data.scans || []).length.toLocaleString()} scans into a new project`);
}

// --------------------------------------------------------------- camera ----

let camera = null;
async function startCamera() {
  const box = $('#cameraBox');
  box.hidden = false;
  try {
    await loadScript('vendor/html5-qrcode.min.js', 'Html5Qrcode');
    camera = new window.Html5Qrcode('cameraReader');
    let last = '';
    let lastAt = 0;
    await camera.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 180 } }, (text) => {
      const now = Date.now();
      if (text === last && now - lastAt < 2500) return; // ignore the same code held in view
      last = text;
      lastAt = now;
      handleScan(text);
    });
  } catch (e) {
    toast('Camera unavailable: ' + (e.message || e), 5000);
    stopCamera();
  }
}
async function stopCamera() {
  $('#cameraBox').hidden = true;
  if (camera) {
    try {
      await camera.stop();
    } catch {
      /* already stopped */
    }
    camera = null;
  }
}

// --------------------------------------------------------------- events ----

function setView(v) {
  state.view = v;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  for (const s of $$('.view')) s.hidden = s.id !== 'view-' + v;
  if (v !== 'scan') stopCamera();
  render();
  if (v === 'scan') focusScan();
  if (v === 'find') $('#findInput').focus();
  history.replaceState(null, '', '#' + v);
}

function bind() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#wsButton').addEventListener('click', workspaceMenu);
  $('#syncPill').addEventListener('click', () => setView('settings'));

  // scan
  $('#scanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#scanInput');
    const v = input.value;
    input.value = '';
    await handleScan(v);
    input.focus();
  });
  $('#scanInput').addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text && /\n/.test(text.trim())) {
      e.preventDefault();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (confirm(`Add ${lines.length} scans from the clipboard to ${currentStation().name}?`)) handleBulk(lines);
    }
  });
  $('#stationSelect').addEventListener('change', (e) => {
    LS.set('station.' + state.ws.id, e.target.value);
    resetResult();
    render();
    focusScan();
  });
  $('#operatorInput').addEventListener('change', (e) => LS.set('operator', e.target.value.trim()));
  $('#undoBtn').addEventListener('click', undoLast);
  $('#bulkBtn').addEventListener('click', async () => {
    const res = await dialog({
      title: `Bulk paste into ${currentStation().name}`,
      body: '<p class="small muted">One scan per line — e.g. paste a column copied from Excel.</p><textarea id="bulkText" rows="12"></textarea>',
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Add scans', value: 'ok', cls: 'primary' }],
      bind(root) {
        dialog.bulk = () => root.querySelector('#bulkText').value;
      },
    });
    if (res === 'ok') await handleBulk(dialog.bulk().split(/\r?\n/));
  });
  $('#result').addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act || !state.lastResult) return;
    if (act === 'force') await forcePlace(state.lastResult.id);
    if (act === 'remove') {
      await commit([], [state.lastResult.id]);
      resetResult();
    }
    focusScan();
  });
  $('#cameraBtn').addEventListener('click', startCamera);
  $('#cameraStop').addEventListener('click', stopCamera);

  document.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return editScan(ed.dataset.edit);
    const tr = e.target.closest('[data-tray]');
    if (tr && !$('#dialog').open) return openTray(Number(tr.dataset.tray));
    const f = e.target.closest('[data-find]');
    if (f) {
      $('#findInput').value = f.dataset.find;
      setView('find');
    }
  });

  // Keep a hardware scanner's keystrokes from getting lost: typing anywhere on
  // the Scan tab goes into the scan box.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t.matches && t.matches('input, textarea, select, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && state.view === 'scan') {
      e.preventDefault();
      undoLast();
      return;
    }
    if (state.view === 'scan' && !typing && !$('#dialog').open && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      $('#scanInput').focus();
    }
  });

  // trays
  ['#trayFilterText', '#trayFilterStation', '#trayFilterBrand', '#trayFilterGen', '#trayFilterState'].forEach((s) =>
    $(s).addEventListener('input', () => renderTrays()));
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.trayLayout = b.dataset.layout;
    $$('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    renderTrays();
  }));

  // find
  $('#findInput').addEventListener('input', renderFind);
  $('#findInput').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), renderFind(), e.target.select()));

  // log
  ['#logFilterText', '#logFilterStation', '#logFilterStatus'].forEach((s) => $(s).addEventListener('input', () => {
    state.logPage = 0;
    renderLog();
  }));
  $('#logPager').addEventListener('click', (e) => {
    const p = e.target.dataset.page;
    if (!p) return;
    state.logPage += Number(p);
    renderLog();
  });
  $('#exportCsvBtn').addEventListener('click', () => downloadText(`${state.ws.name.replace(/[^\w-]+/g, '_')}_scans.csv`, scansToCsv(logRows().reverse(), state.ws.stations), 'text/csv'));
  const xl = () => exportWorkbook(state.ws, state.scans).catch((e) => toast(e.message, 5000));
  $('#exportXlsxBtn').addEventListener('click', xl);
  $('#exportXlsxBtn2').addEventListener('click', xl);

  // settings
  $('#wsNameInput').addEventListener('change', (e) => {
    state.ws.name = e.target.value.trim() || state.ws.name;
    saveWorkspace();
  });
  $('#capacityInput').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!(n >= 1 && n <= 1000)) return toast('Capacity must be 1–1000');
    state.ws.settings.capacity = n;
    saveWorkspace();
    toast(`Trays now hold ${n} sticks (applies to new scans)`);
  });
  $('#noLimitInput').addEventListener('change', (e) => {
    state.ws.settings.capacity = e.target.checked ? 0 : parseInt($('#capacityInput').value, 10) || 50;
    saveWorkspace();
    toast(e.target.checked ? 'No tray limit: each part number keeps one tray' : `Trays hold ${state.ws.settings.capacity} sticks`);
  });
  $('#newProjectBtn2').addEventListener('click', newProjectWizard);
  $('#dupSerialInput').addEventListener('change', (e) => {
    state.ws.settings.allowDuplicateSerials = e.target.checked;
    saveWorkspace();
  });
  $('#soundInput').addEventListener('change', (e) => {
    LS.set('sound', e.target.checked);
    if (e.target.checked) beep('ok');
  });
  $('#voiceInput').addEventListener('change', (e) => {
    LS.set('voice', e.target.checked);
    speak('Tray 1');
  });
  $('#stationsTable').addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    const id = e.target.closest('tr')?.dataset.st;
    if (!f || !id) return;
    const stations = state.ws.stations.map((s) => ({ ...s }));
    const st = stations.find((s) => s.id === id);
    st[f] = f === 'trayStart' || f === 'trayEnd' ? parseInt(e.target.value, 10) : e.target.value.trim();
    const problems = rangeProblems(stations);
    $('#stationProblems').textContent = problems.join(' · ');
    if (problems.length) return;
    state.ws.stations = stations;
    saveWorkspace();
  });
  $('#stationsTable').addEventListener('click', (e) => {
    const id = e.target.dataset.removeSt;
    if (!id) return;
    if (state.ws.stations.length <= 1) return toast('Keep at least one station');
    state.ws.stations = state.ws.stations.filter((s) => s.id !== id);
    saveWorkspace();
  });
  $('#addStationBtn').addEventListener('click', () => {
    const maxEnd = Math.max(0, ...state.ws.stations.map((s) => s.trayEnd));
    const name = prompt('Member name', `Member ${state.ws.stations.length + 1}`);
    if (!name || !name.trim()) return;
    const size = state.ws.stations.length ? state.ws.stations[state.ws.stations.length - 1].trayEnd - state.ws.stations[state.ws.stations.length - 1].trayStart + 1 : 100;
    state.ws.stations.push({ id: 'st_' + shortId(6), name: name.trim(), operator: name.trim(), trayStart: maxEnd + 1, trayEnd: maxEnd + size });
    toast(`${name.trim()} gets trays ${maxEnd + 1}–${maxEnd + size}`);
    saveWorkspace();
  });
  $('#saveRulesBtn').addEventListener('click', () => {
    const rules = textToRules($('#rulesInput').value);
    if (!rules.length) return toast('Add at least one rule');
    state.ws.settings.brandRules = rules;
    saveWorkspace();
    toast('Brand rules saved (apply to new scans)');
  });
  $('#resetRulesBtn').addEventListener('click', () => {
    state.ws.settings.brandRules = structuredClone(DEFAULT_BRAND_RULES);
    $('#rulesInput').value = rulesToText(DEFAULT_BRAND_RULES);
    saveWorkspace();
  });
  $('#importXlsx').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importExcel(f);
  });
  $('#backupBtn').addEventListener('click', backup);
  $('#restoreFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) restore(f);
  });
  $('#clearScansBtn').addEventListener('click', async () => {
    const n = state.scans.length;
    if (!n) return toast('No scans to delete');
    const typed = prompt(`This deletes all ${n.toLocaleString()} scans in project “${state.ws.name}”${state.ws.cloud ? ' for EVERYONE on the team' : ''}. Type DELETE to confirm.`);
    if (typed !== 'DELETE') return;
    await commit([], state.scans.map((s) => s.id));
    toast('All scans deleted');
  });
  $('#deleteWsBtn').addEventListener('click', async () => {
    if (!confirm(`Remove “${state.ws.name}” from this device?${state.ws.cloud ? ' The team copy stays in the Google Sheet; you can re-join with the link.' : ' Download a backup first if you need the data.'}`)) return;
    const id = state.ws.id;
    if (state.sync) state.sync.close(), (state.sync = null);
    await db.deleteWorkspace(id);
    const rest = await db.listWorkspaces();
    if (rest.length) await openWorkspace(rest[0].id);
    else await createWorkspace('My Project');
  });
  $('#syncBody').addEventListener('click', async (e) => {
    const id = e.target.id;
    if (id === 'copyLink') {
      const input = $('#shareLink');
      input.select();
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        document.execCommand('copy');
      }
      toast('Team link copied');
    } else if (id === 'shareBtn') {
      const url = $('#gsUrl').value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) return toast('Paste the Web app URL (it starts with https://script.google.com/macros/s/…)', 6000);
      const saved = LS.get('gsheet', {}) || {};
      const key = saved.url === url && saved.key ? saved.key : gsheetSecret();
      state.ws.cloud = { url, key };
      await db.putWorkspace(state.ws);
      toast('Connecting to your Google Sheet and uploading…', 10000);
      const ok = await startSync();
      if (!ok) {
        const err = state.syncStatus && state.syncStatus.error;
        if (state.sync) state.sync.close(), (state.sync = null);
        state.ws.cloud = null;
        state.syncStatus = null;
        await db.putWorkspace(state.ws);
        render();
        toast('Could not connect: ' + (err || 'check the Web app URL') + '. Make sure you pasted the copied script and set access to “Anyone”. Nothing was shared.', 10000);
        return;
      }
      LS.set('gsheet', { url, key });
      render();
      toast('Shared! Copy the team link and send it to your team.', 5000);
    } else if (id === 'copyScriptBtn') {
      await copySetupScript();
    } else if (id === 'resyncBtn') {
      if (!state.sync) return;
      try {
        await pullFromCloud(state.sync, false);
        toast('Reloaded from the Google Sheet');
      } catch (err) {
        toast(err.message, 5000);
      }
    } else if (id === 'unlinkBtn') {
      if (!confirm('Stop syncing on this device? Your local copy stays here, but it will no longer update with the team.')) return;
      if (state.sync) state.sync.close(), (state.sync = null);
      state.ws.cloud = null; // the cloud copy is untouched
      await db.putWorkspace(state.ws);
      state.syncStatus = null;
      render();
    }
  });

  // other tabs on this device
  if (channel) {
    channel.onmessage = async (e) => {
      if (!state.ws || e.data.wsId !== state.ws.id) return;
      if (e.data.type === 'scans') {
        const scans = await db.getScans(state.ws.id);
        state.byId = new Map(scans.map((s) => [s.id, s]));
        state.scans = scans;
        sortScans();
      } else if (e.data.type === 'ws') {
        const ws = await db.getWorkspace(state.ws.id);
        if (ws) state.ws = { ...ws, settings: { ...state.ws.settings, ...ws.settings } };
      }
      scheduleRender();
    };
  }

  window.addEventListener('hashchange', async () => {
    const info = readJoinLink(location.hash);
    if (info) await promptJoin(info);
  });
}

async function promptJoin(info) {
  history.replaceState(null, '', location.pathname + location.search + '#scan');
  const res = await dialog({
    title: 'Join team workspace',
    body: `<p>You were invited to <b>${esc(info.name)}</b>. Scans you make there are shared live with everyone who has this link.</p><p class="small muted">Your other workspaces on this device are not affected.</p>`,
    actions: [{ label: 'Not now', value: 'no' }, { label: 'Join', value: 'yes', cls: 'primary' }],
  });
  if (res === 'yes') await joinTeam(info);
}

// ----------------------------------------------------------------- boot ----

async function boot() {
  bind();
  requestPersistence();
  try {
    await db.openDb();
  } catch (e) {
    document.body.innerHTML = `<main><div class="card"><h2>Storage unavailable</h2><p>${esc(e.message)}</p><p>This app stores data in your browser. Private/incognito windows or blocked site data can prevent that.</p></div></main>`;
    return;
  }
  const join = readJoinLink(location.hash);
  const all = await db.listWorkspaces();
  const last = LS.get('lastWs');
  if (all.length) await openWorkspace(all.some((w) => w.id === last) ? last : all[0].id);
  else await createWorkspace('My Project');
  const v = location.hash.replace('#', '');
  setView(['scan', 'trays', 'find', 'dashboard', 'log', 'settings'].includes(v) ? v : 'scan');
  if (join) await promptJoin(join);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
