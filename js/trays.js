// Tray logic. Pure functions over the list of scan records, so local and
// synced workspaces compute the same thing.
//
// A scan record: { id, stationId, raw, part, brand, gen, genInferred, label,
//   serial, tray, status, note, operator, device, ts }
// status: 'placed' | 'duplicate' | 'nopart' | 'full' | 'shipped'
//
// Unlike the workbook (which recomputed every row's tray on each edit), a
// scan's tray is fixed when it is scanned, so deleting a row never moves
// sticks that are already sitting in a tray.

export const DEFAULT_CAPACITY = 50;

export function isBlankSerial(s) {
  return !s || s === '—' || s === '-';
}

// tray number -> { tray, part, brand, gen, label, count, parts: Set, lastTs }
export function occupancy(scans, stationId) {
  const map = new Map();
  for (const s of scans) {
    if (s.status !== 'placed' || s.tray == null) continue;
    if (stationId != null && s.stationId !== stationId) continue;
    let t = map.get(s.tray);
    if (!t) {
      t = { tray: s.tray, stationId: s.stationId, part: s.part, brand: s.brand, gen: s.gen, label: s.label, count: 0, parts: new Set(), lastTs: 0 };
      map.set(s.tray, t);
    }
    t.count++;
    t.parts.add(s.part);
    if (!t.gen && s.gen) t.gen = s.gen;
    if (!t.label && s.label) t.label = s.label;
    if (s.ts > t.lastTs) t.lastTs = s.ts;
  }
  return map;
}

export function serialSet(scans) {
  const set = new Set();
  for (const s of scans) {
    if ((s.status === 'placed' || s.status === 'shipped') && !isBlankSerial(s.serial)) set.add(s.serial.toUpperCase());
  }
  return set;
}

// Incremental placer: build once from the current scans, then place many
// scans in order (bulk paste / Excel import) without rescanning the list.
export function makePlacer(scans, settings = {}) {
  const capacity = settings.capacity || DEFAULT_CAPACITY;
  const occ = occupancy(scans, null);
  const serials = new Map();
  const seen = new Set();
  for (const s of scans) {
    if ((s.status === 'placed' || s.status === 'shipped') && !isBlankSerial(s.serial)) serials.set(s.serial.toUpperCase(), s);
    if (s.status === 'placed') seen.add(s.stationId + '|' + s.part);
  }

  function place(parsed, station, opts = {}) {
    if (!parsed.part) return { status: 'nopart', tray: null, message: 'No part number detected' };
    const serialKey = isBlankSerial(parsed.serial) ? '' : parsed.serial.toUpperCase();
    if (serialKey && !settings.allowDuplicateSerials && !opts.force && serials.has(serialKey)) {
      const dup = serials.get(serialKey);
      return { status: 'duplicate', tray: null, dupOf: dup, message: `Serial already scanned${dup.tray != null ? ' → Tray ' + dup.tray : ''}` };
    }
    // 1) an open tray in this station's range already holding this part (lowest number first)
    let open = null;
    for (const t of occ.values()) {
      if (t.tray < station.trayStart || t.tray > station.trayEnd) continue;
      if (t.parts.size === 1 && t.part === parsed.part && t.count < capacity && (!open || t.tray < open.tray)) open = t;
    }
    let d;
    if (open) {
      d = { status: 'placed', tray: open.tray, count: open.count + 1, newTray: false, message: `Add to Tray ${open.tray}` };
    } else {
      // 2) lowest empty tray in the station's range
      for (let n = station.trayStart; n <= station.trayEnd; n++) {
        if (!occ.has(n)) {
          const again = seen.has(station.id + '|' + parsed.part);
          d = { status: 'placed', tray: n, count: 1, newTray: true, message: again ? `Tray full → New Tray ${n}` : `New part → Tray ${n}` };
          break;
        }
      }
    }
    if (!d) return { status: 'full', tray: null, message: `All trays ${station.trayStart}–${station.trayEnd} are full` };
    return d;
  }

  // Record a scan that was stored, so later placements see it.
  function commit(rec) {
    if (rec.status !== 'placed' && rec.status !== 'shipped') return;
    if (!isBlankSerial(rec.serial)) serials.set(rec.serial.toUpperCase(), rec);
    if (rec.status !== 'placed' || rec.tray == null) return;
    seen.add(rec.stationId + '|' + rec.part);
    let t = occ.get(rec.tray);
    if (!t) {
      t = { tray: rec.tray, stationId: rec.stationId, part: rec.part, brand: rec.brand, gen: rec.gen, label: rec.label, count: 0, parts: new Set(), lastTs: 0 };
      occ.set(rec.tray, t);
    }
    t.count++;
    t.parts.add(rec.part);
    t.lastTs = Math.max(t.lastTs, rec.ts || 0);
  }

  return { place, commit, capacity };
}

// Decide where a freshly parsed scan goes.
// Returns { status, tray, count, newTray, message, dupOf }
export function decide(parsed, station, scans, settings = {}) {
  return makePlacer(scans, settings).place(parsed, station);
}

export function trayState(count, capacity) {
  if (!count) return 'empty';
  if (count > capacity) return 'over';
  if (count === capacity) return 'full';
  return 'partial';
}

// One row per tray across every station range (the workbook's Master Summary).
export function traySummary(scans, stations, capacity = DEFAULT_CAPACITY) {
  const occ = occupancy(scans, null);
  const rows = [];
  for (const st of stations) {
    for (let n = st.trayStart; n <= st.trayEnd; n++) {
      const t = occ.get(n);
      const count = t ? t.count : 0;
      rows.push({
        tray: n,
        stationId: st.id,
        stationName: st.name,
        operator: st.operator,
        part: t ? t.part : '',
        brand: t ? t.brand : '',
        gen: t ? t.gen : '',
        label: t ? t.label : '',
        count,
        mixed: t ? t.parts.size > 1 : false,
        foreign: t ? t.stationId !== st.id : false,
        lastTs: t ? t.lastTs : 0,
        state: trayState(count, capacity),
      });
    }
  }
  return rows;
}

export function groupCount(scans, key, filter = (s) => s.status === 'placed') {
  const m = new Map();
  for (const s of scans) {
    if (!filter(s)) continue;
    const k = (typeof key === 'function' ? key(s) : s[key]) || '—';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Validate station tray ranges: no overlaps, start <= end.
export function rangeProblems(stations) {
  const problems = [];
  const sorted = [...stations].sort((a, b) => a.trayStart - b.trayStart);
  for (const st of sorted) {
    if (!Number.isInteger(st.trayStart) || !Number.isInteger(st.trayEnd) || st.trayStart < 1 || st.trayEnd < st.trayStart) {
      problems.push(`${st.name}: invalid range ${st.trayStart}–${st.trayEnd}`);
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].trayStart <= sorted[i - 1].trayEnd) problems.push(`${sorted[i - 1].name} and ${sorted[i].name} overlap`);
  }
  return problems;
}
