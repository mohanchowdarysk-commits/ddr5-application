// Excel import/export via xlsx-js-style (SheetJS + cell styles), loaded on demand.

import { traySummary, groupCount, capOf } from './trays.js';
import { loadScript } from './load.js';

export function loadXLSX() {
  return loadScript('vendor/xlsx-js-style.min.js', 'XLSX');
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

// ---- colours (ARGB-less hex) ----
const BRAND_STYLE = {
  Samsung: ['DCEBFB', '1D4F91'],
  'SK Hynix': ['FCE1E1', '9B1C1C'],
  Micron: ['D7F3E8', '0E6B4A'],
  Crucial: ['FDE6DA', '9A3D12'],
  Kingston: ['E6E2FA', '3F31A3'],
  Unknown: ['EEEEEE', '555555'],
};
const GEN_STYLE = { DDR3: ['FBE0EB', '9C2C5A'], DDR4: ['DCEBFB', '1D4F91'], DDR5: ['D9F2D9', '1B6B1B'] };
const GOOD = ['C8EED3', '0F6B2F'];
const WARN = ['FFF1CC', '7A5200'];
const BAD = ['FCDADA', '9B1C1C'];
const MUTED = ['EEEEEE', '666666'];
const STATUS_STYLE = { placed: GOOD, duplicate: BAD, nopart: BAD, full: BAD, shipped: MUTED };

const BORDER = { style: 'thin', color: { rgb: 'D9D9D9' } };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function cellStyle(pair, { bold = false, stripe = false, align } = {}) {
  const s = { border: BORDERS, font: { name: 'Calibri', sz: 11, bold }, alignment: { vertical: 'center' } };
  if (align) s.alignment.horizontal = align;
  if (pair) {
    s.fill = { patternType: 'solid', fgColor: { rgb: pair[0] } };
    s.font.color = { rgb: pair[1] };
  } else if (stripe) {
    s.fill = { patternType: 'solid', fgColor: { rgb: 'F7F7F5' } };
  }
  return s;
}

// Build one styled sheet: title, subtitle, header row, data rows, optional totals row.
// columns: [{ h, w, key(row) -> value, style(row) -> [fill, text] | null, align }]
function buildSheet(XLSX, { title, subtitle, columns, rows, totals }) {
  const ws = {};
  const enc = XLSX.utils.encode_cell;
  const put = (r, c, v, s) => {
    const cell = { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s };
    if (v === '' || v == null) cell.t = 's';
    ws[enc({ r, c })] = cell;
  };
  const last = columns.length - 1;
  put(0, 0, title, { font: { name: 'Calibri', sz: 16, bold: true, color: { rgb: '1F3A5F' } } });
  put(1, 0, subtitle, { font: { name: 'Calibri', sz: 10, italic: true, color: { rgb: '666666' } } });
  const H = 3;
  columns.forEach((col, c) =>
    put(H, c, col.h, {
      fill: { patternType: 'solid', fgColor: { rgb: '1F3A5F' } },
      font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
      alignment: { vertical: 'center', horizontal: col.align || 'left', wrapText: true },
      border: BORDERS,
    })
  );
  rows.forEach((row, i) => {
    columns.forEach((col, c) => {
      const pair = col.style ? col.style(row) : null;
      put(H + 1 + i, c, col.key(row, i), cellStyle(pair, { stripe: i % 2 === 1, bold: !!(pair && col.boldWhenStyled), align: col.align }));
    });
  });
  let end = H + rows.length;
  if (totals) {
    end++;
    columns.forEach((col, c) =>
      put(end, c, totals[c] ?? '', {
        fill: { patternType: 'solid', fgColor: { rgb: 'E8EEF6' } },
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: '1F3A5F' } },
        border: { ...BORDERS, top: { style: 'medium', color: { rgb: '1F3A5F' } } },
        alignment: { horizontal: col.align || 'left' },
      })
    );
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(end, H), c: last } });
  ws['!cols'] = columns.map((c) => ({ wch: c.w || 14 }));
  ws['!rows'] = [{ hpt: 24 }, { hpt: 16 }, { hpt: 8 }, { hpt: 22 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: last } }, { s: { r: 1, c: 0 }, e: { r: 1, c: last } }];
  if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: H, c: 0 }, e: { r: H + rows.length, c: last } }) };
  return ws;
}

function sheetName(name, used) {
  let base = String(name).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 27)} (${i})`;
  used.add(n.toLowerCase());
  return n;
}

export async function exportWorkbook(ws, scans) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const cap = capOf(ws.settings);
  const capLabel = Number.isFinite(cap) ? `${cap} sticks per tray` : 'no tray limit';
  const stamp = fmtTime(Date.now());
  const used = new Set();
  const placed = scans.filter((s) => s.status === 'placed');

  // 1) Tray summary — only trays that hold sticks.
  const trays = traySummary(scans, ws.stations, cap).filter((r) => r.count > 0);
  const trayStatus = (r) => (r.mixed ? 'Mixed parts' : r.count > cap ? 'Over limit' : r.count === cap ? 'FULL' : Number.isFinite(cap) ? 'Partial' : 'Open');
  const trayStatusStyle = (r) => ({ 'Mixed parts': BAD, 'Over limit': BAD, FULL: GOOD, Partial: WARN, Open: null })[trayStatus(r)];
  XLSX.utils.book_append_sheet(
    wb,
    buildSheet(XLSX, {
      title: `${ws.name} — Tray Summary`,
      subtitle: `Exported ${stamp} · ${placed.length} sticks in ${trays.length} trays · ${capLabel}`,
      columns: [
        { h: 'Tray #', w: 8, key: (r) => r.tray, align: 'center' },
        { h: 'Member / Station', w: 20, key: (r) => r.stationName },
        { h: 'Operator', w: 14, key: (r) => r.operator },
        { h: 'Part Number', w: 26, key: (r) => r.part },
        { h: 'Brand', w: 12, key: (r) => r.brand, style: (r) => BRAND_STYLE[r.brand] || BRAND_STYLE.Unknown, boldWhenStyled: true },
        { h: 'Gen', w: 8, key: (r) => r.gen || '—', style: (r) => GEN_STYLE[r.gen], boldWhenStyled: true, align: 'center' },
        { h: 'Label / Description', w: 34, key: (r) => r.label },
        { h: 'Sticks', w: 8, key: (r) => r.count, align: 'right' },
        { h: 'Fill', w: 9, key: (r) => (Number.isFinite(cap) ? `${r.count}/${cap}` : `${r.count}`), align: 'center' },
        { h: 'Status', w: 12, key: trayStatus, style: trayStatusStyle, boldWhenStyled: true, align: 'center' },
      ],
      rows: trays,
      totals: ['TOTAL', `${trays.length} trays`, '', '', '', '', '', placed.length, '', `${trays.filter((r) => r.count >= cap).length} full`],
    }),
    sheetName('Tray Summary', used)
  );

  // 2) Members overview.
  const members = ws.stations
    .map((st) => {
      const mine = scans.filter((s) => s.stationId === st.id);
      const p = mine.filter((s) => s.status === 'placed');
      const t = trays.filter((r) => r.stationId === st.id);
      return {
        st,
        sticks: p.length,
        trays: t.length,
        full: t.filter((r) => r.count >= cap).length,
        problems: mine.filter((s) => ['duplicate', 'nopart', 'full'].includes(s.status)).length,
        shipped: mine.filter((s) => s.status === 'shipped').length,
        total: mine.length,
      };
    })
    .filter((m) => m.total > 0);
  XLSX.utils.book_append_sheet(
    wb,
    buildSheet(XLSX, {
      title: `${ws.name} — Members`,
      subtitle: `Exported ${stamp}`,
      columns: [
        { h: 'Member / Station', w: 22, key: (m) => m.st.name },
        { h: 'Operator', w: 14, key: (m) => m.st.operator },
        { h: 'Tray range', w: 12, key: (m) => `${m.st.trayStart}–${m.st.trayEnd}`, align: 'center' },
        { h: 'Trays used', w: 11, key: (m) => m.trays, align: 'right' },
        { h: 'Full trays', w: 10, key: (m) => m.full, align: 'right', style: (m) => (m.full ? GOOD : null) },
        { h: 'Sticks', w: 9, key: (m) => m.sticks, align: 'right' },
        { h: 'Shipped', w: 9, key: (m) => m.shipped, align: 'right' },
        { h: 'Problems', w: 10, key: (m) => m.problems, align: 'right', style: (m) => (m.problems ? BAD : null), boldWhenStyled: true },
      ],
      rows: members,
      totals: ['TOTAL', '', '', members.reduce((a, m) => a + m.trays, 0), members.reduce((a, m) => a + m.full, 0), members.reduce((a, m) => a + m.sticks, 0), members.reduce((a, m) => a + m.shipped, 0), members.reduce((a, m) => a + m.problems, 0)],
    }),
    sheetName('Members', used)
  );

  // 3) Part totals.
  const parts = groupCount(scans, (s) => s.part).map(([part, n]) => {
    const any = placed.find((s) => s.part === part) || {};
    const inTrays = [...new Set(placed.filter((s) => s.part === part).map((s) => s.tray))].sort((a, b) => a - b);
    return { part, n, brand: any.brand || '', gen: any.gen || '', trays: inTrays.join(', ') };
  });
  XLSX.utils.book_append_sheet(
    wb,
    buildSheet(XLSX, {
      title: `${ws.name} — Part Totals`,
      subtitle: `${parts.length} part numbers · ${placed.length} sticks`,
      columns: [
        { h: 'Part Number', w: 26, key: (r) => r.part },
        { h: 'Brand', w: 12, key: (r) => r.brand, style: (r) => BRAND_STYLE[r.brand] || BRAND_STYLE.Unknown, boldWhenStyled: true },
        { h: 'Gen', w: 8, key: (r) => r.gen || '—', style: (r) => GEN_STYLE[r.gen], boldWhenStyled: true, align: 'center' },
        { h: 'Sticks', w: 9, key: (r) => r.n, align: 'right' },
        { h: 'Trays', w: 30, key: (r) => r.trays },
      ],
      rows: parts,
      totals: ['TOTAL', '', '', placed.length, ''],
    }),
    sheetName('Part Totals', used)
  );

  // 4) One sheet per member with every scan.
  for (const st of ws.stations) {
    const rows = scans.filter((s) => s.stationId === st.id);
    if (!rows.length) continue;
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(XLSX, {
        title: `${st.name} — Trays ${st.trayStart}–${st.trayEnd}`,
        subtitle: `${st.operator ? 'Operator: ' + st.operator + ' · ' : ''}${rows.length} scans · exported ${stamp}`,
        columns: [
          { h: '#', w: 6, key: (s, i) => i + 1, align: 'right' },
          { h: 'QR Scan Input', w: 44, key: (s) => s.raw },
          { h: 'Brand', w: 12, key: (s) => s.brand, style: (s) => BRAND_STYLE[s.brand] || BRAND_STYLE.Unknown, boldWhenStyled: true },
          { h: 'Gen', w: 8, key: (s) => s.gen || '—', style: (s) => GEN_STYLE[s.gen], boldWhenStyled: true, align: 'center' },
          { h: 'Label / Description', w: 30, key: (s) => s.label },
          { h: 'Serial Number', w: 18, key: (s) => s.serial },
          { h: 'Part Number', w: 24, key: (s) => s.part },
          { h: 'Tray #', w: 8, key: (s) => s.tray ?? '', align: 'center' },
          { h: 'Status', w: 16, key: (s) => STATUS_TEXT[s.status] || s.status, style: (s) => STATUS_STYLE[s.status], boldWhenStyled: true },
          { h: 'Notes', w: 24, key: (s) => s.note || '' },
          { h: 'Operator', w: 12, key: (s) => s.operator || '' },
          { h: 'Scanned At', w: 19, key: (s) => fmtTime(s.ts) },
        ],
        rows,
      }),
      sheetName(`${st.name} ${st.trayStart}-${st.trayEnd}`, used)
    );
  }

  const file = stamp.replace(/[: ]/g, '-');
  XLSX.writeFile(wb, `${ws.name.replace(/[^\w-]+/g, '_')}_${file}.xlsx`, { cellStyles: true });
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
    const m = /(\d+)\s*-\s*(\d+)\s*$/.exec(name);
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
