// Excel import/export via SheetJS (loaded on demand).

import { traySummary, groupCount } from './trays.js';
import { loadScript } from './load.js';

export function loadXLSX() {
  return loadScript('vendor/xlsx.full.min.js', 'XLSX');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STATUS_TEXT = {
  placed: 'Placed',
  duplicate: 'Duplicate serial',
  nopart: 'No part # detected',
  full: 'All trays full',
  shipped: 'Shipped',
};

export async function exportWorkbook(ws, scans) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const cap = ws.settings.capacity;

  const summary = traySummary(scans, ws.stations, cap).map((r) => ({
    'Tray #': r.tray,
    Scanner: r.stationName,
    Operator: r.operator,
    'Part Number': r.part,
    Brand: r.brand,
    Gen: r.gen,
    'Label / Description': r.label,
    Sticks: r.count,
    Status: r.count === 0 ? 'Empty' : r.count >= cap ? 'FULL' : `${r.count}/${cap}`,
    Warning: r.mixed ? 'Mixed part numbers' : '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Master Summary');

  const parts = groupCount(scans, (s) => s.part).map(([part, n]) => {
    const any = scans.find((s) => s.part === part && s.status === 'placed');
    return { 'Part Number': part, Brand: any ? any.brand : '', Gen: any ? any.gen : '', Sticks: n };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(parts), 'Part Totals');

  const used = new Set();
  for (const st of ws.stations) {
    const rows = scans
      .filter((s) => s.stationId === st.id)
      .map((s, i) => ({
        '#': i + 1,
        'QR Scan Input': s.raw,
        Brand: s.brand,
        Gen: s.gen,
        'Label / Description': s.label,
        'Serial Number': s.serial,
        'Part Number': s.part,
        'Tray #': s.tray ?? '',
        Status: STATUS_TEXT[s.status] || s.status,
        Notes: s.note || '',
        Operator: s.operator || '',
        'Scanned At': fmtTime(s.ts),
      }));
    if (!rows.length) continue;
    let name = `${st.trayStart}-${st.trayEnd}`.slice(0, 31);
    while (used.has(name)) name = (name + '_').slice(0, 31);
    used.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }

  const stamp = fmtTime(Date.now()).replace(/[: ]/g, '-');
  XLSX.writeFile(wb, `${ws.name.replace(/[^\w-]+/g, '_')}_${stamp}.xlsx`);
}

// Read scan strings from a workbook: the original DDR_MultiScanner layout
// (sheets named "1-100", "101-200", … with scans in column B from row 5) or a
// file exported by this app (column "QR Scan Input").
// Returns [{ sheet, trayStart, trayEnd, scans: [raw, ...] }]
export async function readScansFromWorkbook(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
  const out = [];
  for (const name of wb.SheetNames) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(name);
    if (!m) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    let col = 1;
    let start = 4;
    const headerIdx = rows.findIndex((r) => r.some((c) => /QR Scan Input/i.test(String(c))));
    if (headerIdx >= 0) {
      col = rows[headerIdx].findIndex((c) => /QR Scan Input/i.test(String(c)));
      start = headerIdx + 1;
    }
    const scans = [];
    for (let i = start; i < rows.length; i++) {
      const v = String(rows[i][col] ?? '').trim();
      if (v) scans.push(v);
    }
    out.push({ sheet: name, trayStart: Number(m[1]), trayEnd: Number(m[2]), scans });
  }
  return out;
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function scansToCsv(scans, stations) {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const head = ['Scanned At', 'Scanner', 'Operator', 'Tray', 'Part Number', 'Brand', 'Gen', 'Label', 'Serial', 'Status', 'Notes', 'Raw Scan'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [head.join(',')];
  for (const s of scans) {
    const st = byId.get(s.stationId);
    lines.push([fmtTime(s.ts), st ? st.name : s.stationId, s.operator, s.tray ?? '', s.part, s.brand, s.gen, s.label, s.serial, STATUS_TEXT[s.status] || s.status, s.note, s.raw].map(esc).join(','));
  }
  return lines.join('\n');
}

export { fmtTime, STATUS_TEXT };
