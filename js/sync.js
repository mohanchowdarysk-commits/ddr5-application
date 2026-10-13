// Optional team sync through a Google Sheet that the user owns (see
// gsheet/Code.gs). The local IndexedDB copy stays the source the UI reads
// from; changes are queued in an outbox and pushed in order, so scanning keeps
// working offline and catches up when the network returns. Other members'
// changes are picked up by polling the sheet's change log.

import { outboxAdd, outboxList, outboxRemove } from './store.js';

const PUSH_BATCH = 400;
const POLL_VISIBLE_MS = 8000;
const POLL_HIDDEN_MS = 60000;

export function scanToRow(s, wsId) {
  return {
    id: s.id,
    ws_id: wsId,
    station_id: s.stationId,
    raw: s.raw,
    part: s.part,
    brand: s.brand,
    gen: s.gen,
    gen_inferred: !!s.genInferred,
    label: s.label,
    serial: s.serial,
    tray: s.tray,
    status: s.status,
    note: s.note || '',
    operator: s.operator || '',
    device: s.device || '',
    ts: s.ts,
  };
}

export function rowToScan(r) {
  return {
    id: r.id,
    wsId: r.ws_id,
    stationId: r.station_id,
    raw: r.raw || '',
    part: r.part || '',
    brand: r.brand || 'Unknown',
    gen: r.gen || '',
    genInferred: !!r.gen_inferred,
    label: r.label || '',
    serial: r.serial || '',
    tray: r.tray === '' || r.tray == null ? null : Number(r.tray),
    status: r.status,
    note: r.note || '',
    operator: r.operator || '',
    device: r.device || '',
    ts: Number(r.ts),
  };
}

export class SheetSync {
  constructor({ url, key, wsId, onScans, onWorkspace, onStatus }) {
    this.url = url;
    this.secret = key;
    this.wsId = wsId;
    this.onScans = onScans;
    this.onWorkspace = onWorkspace;
    this.onStatus = onStatus || (() => {});
    this.rev = 0;
    this.cache = null;
    this.flushing = false;
    this.polling = false;
    this.retryTimer = null;
    this.pollTimer = null;
    this.retryDelay = 2000;
    this.closed = false;
    this.live = false;
    this.lastError = '';
    this.sheetUrl = '';
    this._online = () => {
      this.flush();
      this.poll();
    };
    this._visible = () => document.visibilityState === 'visible' && this.poll();
  }

  async call(params, body) {
    let res;
    if (body) {
      // text/plain keeps this a "simple" request: no CORS preflight, which Apps Script can't answer.
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...params, ...body, secret: this.secret }),
      });
    } else {
      const q = new URLSearchParams({ ...params, secret: this.secret });
      res = await fetch(`${this.url}${this.url.includes('?') ? '&' : '?'}${q}`);
    }
    if (!res.ok) throw new Error(`Google Sheet responded ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Unexpected reply — check the Web app URL and that access is set to "Anyone"');
    }
    if (!data.ok) throw new Error(data.error || 'Google Sheet error');
    return data;
  }

  async init() {
    const r = await this.call({ action: 'ping' });
    this.sheetUrl = r.sheetUrl || '';
    window.addEventListener('online', this._online);
    document.addEventListener('visibilitychange', this._visible);
    return r;
  }

  status(state, extra = {}) {
    this.onStatus({ state, error: this.lastError, ...extra });
  }

  async pullPages(since) {
    const ops = [];
    let rev = since;
    for (;;) {
      const r = await this.call({ action: 'pull', ws: this.wsId, since: rev });
      ops.push(...r.ops);
      rev = r.rev;
      if (!r.more) break;
    }
    return { ops, rev };
  }

  // Full download of this project (first connect / "Reload from sheet").
  async fetchWorkspace() {
    const { ops, rev } = await this.pullPages(0);
    const scans = new Map();
    let ws = null;
    for (const op of ops) {
      if (op.kind === 'upsert' && op.data) scans.set(op.data.id, rowToScan(op.data));
      else if (op.kind === 'delete') scans.delete(op.id);
      else if (op.kind === 'workspace' && op.data) ws = { id: this.wsId, name: op.data.name, stations: op.data.stations, settings: op.data.settings };
    }
    this.rev = rev;
    this.cache = [...scans.values()];
    return ws;
  }

  async fetchAllScans() {
    if (!this.cache) await this.fetchWorkspace();
    const out = this.cache;
    this.cache = null;
    return out;
  }

  wsRow(ws) {
    return { id: ws.id, name: ws.name, stations: ws.stations, settings: ws.settings, updated_at: new Date().toISOString() };
  }

  // Upload an entire local project (used when a project is first shared).
  async publish(ws, scans) {
    await this.call({ action: 'push' }, { ws: ws.id, ops: [{ kind: 'workspace', row: this.wsRow(ws) }] });
    for (let i = 0; i < scans.length; i += PUSH_BATCH) {
      const ops = scans.slice(i, i + PUSH_BATCH).map((s) => ({ kind: 'upsert', id: s.id, row: scanToRow(s, ws.id) }));
      await this.call({ action: 'push' }, { ws: ws.id, ops });
    }
  }

  async pushWorkspace(ws) {
    await this.enqueue([{ kind: 'workspace', row: this.wsRow(ws) }]);
  }

  subscribe() {
    this.live = true;
    this.schedulePoll(0);
  }

  schedulePoll(ms) {
    clearTimeout(this.pollTimer);
    if (this.closed) return;
    const delay = ms ?? (document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  // Fetch other members' changes since the last revision we saw.
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const { ops, rev } = await this.pullPages(this.rev);
      this.rev = rev;
      if (ops.length) {
        const pending = new Set((await outboxList(this.wsId)).map((p) => p.id || (p.row && p.row.id)));
        const ups = new Map();
        const dels = new Set();
        let ws = null;
        for (const op of ops) {
          if (op.kind === 'workspace') ws = op.data;
          else if (pending.has(op.id)) continue; // our newer local change wins until it is pushed
          else if (op.kind === 'upsert' && op.data) {
            ups.set(op.id, rowToScan(op.data));
            dels.delete(op.id);
          } else if (op.kind === 'delete') {
            ups.delete(op.id);
            dels.add(op.id);
          }
        }
        if (ups.size || dels.size) this.onScans([...ups.values()], [...dels]);
        if (ws) this.onWorkspace({ name: ws.name, stations: ws.stations, settings: ws.settings });
      }
      if (!this.flushing) {
        const n = (await outboxList(this.wsId)).length;
        if (!n) {
          this.lastError = '';
          this.status('synced', { pending: 0 });
        }
      }
    } catch (e) {
      this.lastError = e.message || String(e);
      const n = (await outboxList(this.wsId).catch(() => [])).length;
      this.status(navigator.onLine ? 'error' : 'offline', { pending: n });
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  async enqueue(ops) {
    await outboxAdd(ops.map((op) => ({ ...op, wsId: this.wsId })));
    this.flush();
  }

  async pending() {
    return (await outboxList(this.wsId)).length;
  }

  async flush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    clearTimeout(this.retryTimer);
    let pushed = false;
    try {
      let items = await outboxList(this.wsId);
      while (items.length) {
        this.status('syncing', { pending: items.length });
        const group = items.slice(0, PUSH_BATCH);
        await this.call(
          { action: 'push' },
          { ws: this.wsId, ops: group.map((g) => ({ kind: g.kind, id: g.id || (g.row && g.row.id), row: g.row })) }
        );
        await outboxRemove(group.map((g) => g.seq));
        pushed = true;
        items = await outboxList(this.wsId);
      }
      this.lastError = '';
      this.retryDelay = 2000;
      this.status(this.live ? 'synced' : 'offline', { pending: 0 });
    } catch (e) {
      this.lastError = e.message || String(e);
      const n = await this.pending().catch(() => 0);
      this.status(navigator.onLine ? 'error' : 'offline', { pending: n });
      this.retryTimer = setTimeout(() => this.flush(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 60000);
    } finally {
      this.flushing = false;
      if (pushed && this.live) this.schedulePoll(300); // pick up others' changes promptly
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pollTimer);
    window.removeEventListener('online', this._online);
    document.removeEventListener('visibilitychange', this._visible);
  }
}

// Unicode-safe base64 for share links.
function encode(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}
function decode(s) {
  return JSON.parse(decodeURIComponent(escape(atob(s))));
}

// Team links carry the Web app URL + secret + project id in the URL fragment
// (the part after #), which browsers never send to any server.
export function makeJoinLink(ws) {
  const payload = encode({ t: 'gsheet', u: ws.cloud.url, k: ws.cloud.key, w: ws.id, n: ws.name });
  const base = location.href.split('#')[0];
  return `${base}#join=${encodeURIComponent(payload)}`;
}

export function readJoinLink(hash) {
  const m = /join=([^&]+)/.exec(hash || '');
  if (!m) return null;
  try {
    const p = decode(decodeURIComponent(m[1]));
    if (!p.u || !p.k || !p.w) return null;
    return { url: p.u, key: p.k, wsId: p.w, name: p.n || 'Team project' };
  } catch {
    return null;
  }
}

export function setupScript(template, secret) {
  return template.replace("'__SECRET__'", JSON.stringify(secret));
}
