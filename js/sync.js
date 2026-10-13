// Optional team sync through a free Supabase project (Postgres + Realtime).
// The local IndexedDB copy stays the source the UI reads from; changes are
// queued in an outbox and pushed in order, so scanning keeps working offline
// and catches up when the network returns.

import { outboxAdd, outboxList, outboxRemove } from './store.js';

import { loadScript } from './load.js';

const PAGE = 1000;

function loadLib() {
  return loadScript('vendor/supabase.js', 'supabase');
}

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
    tray: r.tray,
    status: r.status,
    note: r.note || '',
    operator: r.operator || '',
    device: r.device || '',
    ts: Number(r.ts),
  };
}

export class CloudSync {
  constructor({ url, key, wsId, onScans, onWorkspace, onStatus }) {
    this.url = url;
    this.key = key;
    this.wsId = wsId;
    this.onScans = onScans;
    this.onWorkspace = onWorkspace;
    this.onStatus = onStatus || (() => {});
    this.client = null;
    this.channel = null;
    this.flushing = false;
    this.retryTimer = null;
    this.retryDelay = 2000;
    this.closed = false;
    this.lastError = '';
    this._online = () => this.flush();
  }

  async init() {
    const { createClient } = await loadLib();
    this.client = createClient(this.url, this.key, { auth: { persistSession: false } });
    window.addEventListener('online', this._online);
  }

  status(state, extra = {}) {
    this.onStatus({ state, error: this.lastError, ...extra });
  }

  async fetchWorkspace() {
    const { data, error } = await this.client.from('ddr_workspaces').select('*').eq('id', this.wsId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { id: data.id, name: data.name, stations: data.stations, settings: data.settings, updatedAt: Date.parse(data.updated_at) } : null;
  }

  async pushWorkspace(ws) {
    const row = { id: ws.id, name: ws.name, stations: ws.stations, settings: ws.settings, updated_at: new Date().toISOString() };
    await this.enqueue([{ kind: 'workspace', row }]);
  }

  async fetchAllScans() {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.client
        .from('ddr_scans')
        .select('*')
        .eq('ws_id', this.wsId)
        .order('ts', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      out.push(...data.map(rowToScan));
      if (data.length < PAGE) break;
    }
    return out;
  }

  // Upload an entire local workspace (used when a local workspace is first shared).
  async publish(ws, scans) {
    const { error } = await this.client
      .from('ddr_workspaces')
      .upsert({ id: ws.id, name: ws.name, stations: ws.stations, settings: ws.settings, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    for (let i = 0; i < scans.length; i += 500) {
      const batch = scans.slice(i, i + 500).map((s) => scanToRow(s, ws.id));
      const r = await this.client.from('ddr_scans').upsert(batch);
      if (r.error) throw new Error(r.error.message);
    }
  }

  subscribe() {
    const ws = this.wsId;
    this.channel = this.client
      .channel('ddr-' + ws)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ddr_scans', filter: `ws_id=eq.${ws}` }, (p) => this.onScans([rowToScan(p.new)], []))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ddr_scans', filter: `ws_id=eq.${ws}` }, (p) => this.onScans([rowToScan(p.new)], []))
      // Delete events cannot be filtered server-side; ids from other workspaces are simply not found locally.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'ddr_scans' }, (p) => p.old && p.old.id && this.onScans([], [p.old.id]))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ddr_workspaces', filter: `id=eq.${ws}` }, (p) => {
        if (p.new && p.new.id) this.onWorkspace({ name: p.new.name, stations: p.new.stations, settings: p.new.settings });
      })
      .subscribe((state) => {
        if (state === 'SUBSCRIBED') {
          this.live = true;
          this.flush();
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
          this.live = false;
          this.status('offline');
        }
      });
  }

  async enqueue(ops) {
    await outboxAdd(ops.map((op) => ({ ...op, wsId: this.wsId })));
    this.flush();
  }

  async pending() {
    return (await outboxList(this.wsId)).length;
  }

  async flush() {
    if (this.flushing || this.closed || !this.client) return;
    this.flushing = true;
    clearTimeout(this.retryTimer);
    try {
      let items = await outboxList(this.wsId);
      while (items.length) {
        this.status('syncing', { pending: items.length });
        // Group consecutive ops of the same kind into one request.
        const head = items[0];
        const group = [];
        for (const it of items) {
          if (it.kind !== head.kind || group.length >= 500) break;
          group.push(it);
        }
        let res;
        if (head.kind === 'upsert') {
          // Last write per id wins inside the group.
          const byId = new Map(group.map((g) => [g.row.id, g.row]));
          res = await this.client.from('ddr_scans').upsert([...byId.values()]);
        } else if (head.kind === 'delete') {
          res = await this.client.from('ddr_scans').delete().in('id', group.map((g) => g.id));
        } else {
          res = await this.client.from('ddr_workspaces').upsert(group[group.length - 1].row);
        }
        if (res.error) throw new Error(res.error.message);
        await outboxRemove(group.map((g) => g.seq));
        items = items.slice(group.length);
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
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener('online', this._online);
    if (this.channel) this.client.removeChannel(this.channel);
  }
}

// Share links carry the Supabase URL + public anon key + workspace id in the
// URL fragment (never sent to any server by the browser).
export function makeJoinLink(ws) {
  const payload = btoa(JSON.stringify({ u: ws.cloud.url, k: ws.cloud.key, w: ws.id, n: ws.name }));
  const base = location.href.split('#')[0];
  return `${base}#join=${encodeURIComponent(payload)}`;
}

export function readJoinLink(hash) {
  const m = /join=([^&]+)/.exec(hash || '');
  if (!m) return null;
  try {
    const p = JSON.parse(atob(decodeURIComponent(m[1])));
    if (!p.u || !p.k || !p.w) return null;
    return { url: p.u, key: p.k, wsId: p.w, name: p.n || 'Team workspace' };
  } catch {
    return null;
  }
}
