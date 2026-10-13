/**
 * DDR Tray Scanner — team sync backend that lives in YOUR Google Sheet.
 *
 * Setup (about 5 minutes, free):
 *   1. Create a Google Sheet (https://sheet.new) and name it, e.g. "DDR Tray Scanner Data".
 *   2. Extensions → Apps Script. Delete everything there, paste this whole file, click Save.
 *   3. Deploy → New deployment → gear icon → "Web app".
 *        Execute as: Me      Who has access: Anyone
 *      Click Deploy, then Authorize access (choose your account → Advanced → Go to … → Allow).
 *   4. Copy the "Web app URL" and paste it into the app: Settings → Team sharing.
 *
 * The app already put your private SECRET below. Anyone without it is refused.
 * All data stays in this spreadsheet, in your Google Drive:
 *   Scans    – one row per scan (readable, filterable, like the old Excel)
 *   Projects – project settings and members
 *   Log      – the change history the app syncs from (don't edit by hand)
 */

const SECRET = '__SECRET__';

const VERSION = 1;
const PAGE_LIMIT = 3000;
const LOG = 'Log';
const SCANS = 'Scans';
const PROJECTS = 'Projects';
const LOG_COLS = ['Rev', 'Project', 'Kind', 'Id', 'Data', 'Saved At'];
const SCAN_COLS = ['Scanned At', 'Tray', 'Part Number', 'Brand', 'Gen', 'Label', 'Serial', 'Status', 'Operator', 'Note', 'Raw Scan', 'Project', 'Station', 'Id', 'Device', 'Ts'];
const SCAN_ID_COL = 14;
const PROJECT_COLS = ['Project Id', 'Name', 'Updated At', 'Members', 'Settings'];

function doGet(e) {
  return handle_(e && e.parameter ? e.parameter : {}, null);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'Bad request body' });
  }
  return handle_(body, body);
}

function handle_(p, body) {
  try {
    if (!p || p.secret !== SECRET || SECRET.indexOf('__') === 0) return out_({ ok: false, error: 'Wrong secret' });
    if (p.action === 'ping') {
      const ss = sheets_();
      return out_({ ok: true, version: VERSION, sheetUrl: ss.url, sheetName: ss.name });
    }
    if (p.action === 'pull') return out_(pull_(String(p.ws || ''), Number(p.since || 0), Math.min(Number(p.limit || PAGE_LIMIT), PAGE_LIMIT)));
    if (p.action === 'push') return out_(push_(String(body.ws || ''), body.ops || []));
    return out_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const make = (name, cols, textCols) => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      // Plain-text columns so serials like 00123 or scans starting with "=" are stored exactly.
      for (const c of textCols) sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
    return sh;
  };
  return {
    url: ss.getUrl(),
    name: ss.getName(),
    log: make(LOG, LOG_COLS, [2, 3, 4, 5, 6]),
    scans: make(SCANS, SCAN_COLS, [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    projects: make(PROJECTS, PROJECT_COLS, [1, 2, 3, 4, 5]),
  };
}

// Changes for one project after revision `since`. Revision = Log row number - 1.
function pull_(ws, since, limit) {
  const s = sheets_();
  const total = s.log.getLastRow() - 1;
  if (since >= total) return { ok: true, rev: total, ops: [], more: false };
  const n = Math.min(limit, total - since);
  const vals = s.log.getRange(since + 2, 1, n, 5).getValues();
  const ops = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (String(v[1]) !== ws) continue;
    ops.push({ rev: since + 1 + i, kind: String(v[2]), id: String(v[3]), data: v[4] ? JSON.parse(String(v[4])) : null });
  }
  return { ok: true, rev: since + n, ops: ops, more: since + n < total };
}

function push_(ws, ops) {
  if (!ws) throw new Error('Missing project id');
  if (!ops.length) return { ok: true, rev: 0 };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const s = sheets_();
    const start = s.log.getLastRow(); // header + existing rows; next row = start + 1
    const now = new Date().toISOString();
    const rows = ops.map((op, i) => {
      const id = op.kind === 'workspace' ? ws : String(op.id || (op.row && op.row.id) || '');
      return [start + i, ws, String(op.kind), id, op.kind === 'delete' ? '' : JSON.stringify(op.row), now];
    });
    s.log.getRange(start + 1, 1, rows.length, LOG_COLS.length).setValues(rows);
    let warning = '';
    try {
      mirror_(s, ws, ops);
    } catch (err) {
      warning = 'Readable sheets not updated: ' + err; // the Log is the source of truth
    }
    return { ok: true, rev: start + rows.length - 1, warning: warning };
  } finally {
    lock.releaseLock();
  }
}

function text_(v) {
  return v == null ? '' : String(v);
}

function scanValues_(r) {
  const at = Utilities.formatDate(new Date(Number(r.ts)), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  return [at, r.tray == null ? '' : r.tray, text_(r.part), text_(r.brand), text_(r.gen), text_(r.label), text_(r.serial), text_(r.status), text_(r.operator), text_(r.note), text_(r.raw), text_(r.ws_id), text_(r.station_id), text_(r.id), text_(r.device), Number(r.ts) || ''];
}

// Keep the human-readable Scans and Projects sheets in step with the Log.
function mirror_(s, ws, ops) {
  const sh = s.scans;
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, SCAN_ID_COL, last - 1, 1).getValues() : [];
  const rowOf = {};
  for (let i = 0; i < ids.length; i++) rowOf[String(ids[i][0])] = i + 2;
  const appends = [];
  const appendIdx = {};
  const deletes = [];
  for (const op of ops) {
    if (op.kind === 'upsert') {
      const vals = scanValues_(op.row);
      const id = String(op.row.id);
      if (rowOf[id]) sh.getRange(rowOf[id], 1, 1, vals.length).setValues([vals]);
      else if (appendIdx[id] != null) appends[appendIdx[id]] = vals;
      else {
        appendIdx[id] = appends.length;
        appends.push(vals);
      }
    } else if (op.kind === 'delete') {
      const id = String(op.id);
      if (rowOf[id]) deletes.push(rowOf[id]);
      if (appendIdx[id] != null) appends[appendIdx[id]] = null;
    } else if (op.kind === 'workspace') {
      const r = op.row;
      const vals = [ws, text_(r.name), new Date().toISOString(), JSON.stringify(r.stations || []), JSON.stringify(r.settings || {})];
      const p = s.projects;
      const pl = p.getLastRow();
      const pids = pl > 1 ? p.getRange(2, 1, pl - 1, 1).getValues() : [];
      let found = 0;
      for (let i = 0; i < pids.length; i++) if (String(pids[i][0]) === ws) found = i + 2;
      if (found) p.getRange(found, 1, 1, vals.length).setValues([vals]);
      else p.getRange(pl + 1, 1, 1, vals.length).setValues([vals]);
    }
  }
  const rows = appends.filter(function (r) { return r; });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, SCAN_COLS.length).setValues(rows);
  deletes.sort(function (a, b) { return b - a; });
  for (const r of deletes) sh.deleteRow(r);
}
