// Scan parsing: turns a raw barcode/QR string into brand, gen, label, serial, part.
// Mirrors the formulas of the original DDR_MultiScanner workbook (columns C–G),
// with a few fixes noted inline.

export const BRANDS = ['Samsung', 'SK Hynix', 'Micron', 'Crucial', 'Kingston', 'Unknown'];

// Rules are checked in two passes: every rule's `prefixes` first (part number
// starts with), then every rule's `contains` in order (the workbook's original
// behaviour). The prefix pass fixes cases like Kingston "KSM32..." which the
// workbook tagged Samsung because it contains "M3".
export const DEFAULT_BRAND_RULES = [
  { brand: 'Samsung', prefixes: ['M3', 'M4', 'M5', 'K4'], contains: ['M3', 'K4', 'M4', 'M5'], rawContains: [] },
  { brand: 'SK Hynix', prefixes: ['HMT', 'HMA', 'HMCG', 'HMC', 'HX'], contains: ['HMT', 'HMA', 'HMCG', 'HX'], rawContains: [] },
  { brand: 'Micron', prefixes: ['MTA', 'MTC', 'MT'], contains: ['MT'], rawContains: [] },
  { brand: 'Crucial', prefixes: ['CT'], contains: ['CT'], rawContains: ['crucial'] },
  { brand: 'Kingston', prefixes: ['KVR', 'KSM', 'KF'], contains: ['KVR', 'KSM', 'KF'], rawContains: [] },
];

const MLCC = /©mlcc/gi;

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Label fields are tagged with a letter in brackets: (L) label, (S) serial,
// (P) part, (M)/(c)/… extra info. A field runs until the next tag.
const NEXT_TAG = /\([A-Za-z]\)/;

function untilNextTag(s) {
  const m = NEXT_TAG.exec(s);
  return m ? { text: s.slice(0, m.index), tagged: true } : { text: s, tagged: false };
}

// Text after `tag` up to the next tag (case-insensitive).
function between(raw, tag) {
  const i = raw.toUpperCase().indexOf(tag);
  if (i < 0) return '';
  return collapse(untilNextTag(raw.slice(i + tag.length)).text);
}

// The first characters of a JEDEC module serial number identify the maker.
export const SERIAL_MAKERS = [
  { prefix: '80CE', brand: 'Samsung' },
  { prefix: '802C', brand: 'Micron' },
  { prefix: '80AD', brand: 'SK Hynix' },
  { prefix: '0198', brand: 'Kingston' },
  { prefix: '859B', brand: 'Crucial' },
];

export function brandFromSerial(serial) {
  const s = String(serial || '').trim().toUpperCase();
  if (!/^[0-9A-F]{12,}$/.test(s)) return '';
  const m = SERIAL_MAKERS.find((x) => s.startsWith(x.prefix));
  return m ? m.brand : '';
}

export function parsePart(raw) {
  const s = String(raw || '').replace(MLCC, '');
  const upper = s.toUpperCase();
  const p = upper.indexOf('(P)');
  if (p < 0) {
    const t = collapse(s);
    if (!t) return '';
    const tokens = t.split(' ');
    // Workbook: if the first word is 1–2 chars (e.g. a "1P" prefix), use the second word.
    if (tokens.length > 1 && tokens[0].length <= 2) return tokens[1];
    return tokens[0];
  }
  // Up to the next tag such as (M) or (c); without one, the first word (workbook rule).
  const seg = untilNextTag(s.slice(p + 3, p + 3 + 80));
  const rest = collapse(seg.text);
  if (seg.tagged) return rest;
  return rest.split(' ')[0] || '';
}

export function detectBrand(part, raw, rules = DEFAULT_BRAND_RULES) {
  const P = String(part || '').toUpperCase();
  const R = String(raw || '').toUpperCase();
  if (P) {
    for (const r of rules) if (r.prefixes.some((x) => x && P.startsWith(x.toUpperCase()))) return r.brand;
  }
  for (const r of rules) {
    if (P && r.contains.some((x) => x && P.includes(x.toUpperCase()))) return r.brand;
    if ((r.rawContains || []).some((x) => x && R.includes(x.toUpperCase()))) return r.brand;
  }
  return 'Unknown';
}

// Generation from text (workbook logic: DDR5, then DDR3, then DDR4), else
// inferred from well-known part number patterns.
export function detectGen(part, raw) {
  const P = String(part || '').toUpperCase();
  const R = String(raw || '').toUpperCase();
  for (const g of ['DDR5', 'DDR3', 'DDR4']) {
    if (R.includes(g) || P.includes(g)) return { gen: g, inferred: false };
  }
  // JEDEC module names on the label: PC5-6400B = DDR5, PC4-3200AA = DDR4, PC3L-12800R = DDR3.
  const pc = /(?:^|[^A-Z0-9])PC([345])L?-\d{4,5}/.exec(R);
  if (pc) return { gen: 'DDR' + pc[1], inferred: false };
  const g = inferGen(P);
  return g ? { gen: g, inferred: true } : { gen: '', inferred: false };
}

function speedGen(n) {
  if (n <= 18) return 'DDR3';
  if (n <= 36) return 'DDR4';
  return 'DDR5';
}

export function inferGen(P) {
  let m;
  if ((m = P.match(/^M\d{3}([ABR])/))) return { A: 'DDR4', B: 'DDR3', R: 'DDR5' }[m[1]];
  if (P.startsWith('HMT')) return 'DDR3';
  if (P.startsWith('HMA')) return 'DDR4';
  if (P.startsWith('HMC')) return 'DDR5';
  if (P.startsWith('MTC')) return 'DDR5';
  if (/^MTA\d+A/.test(P)) return 'DDR4';
  if (/^MT\d+[JK]/.test(P)) return 'DDR3';
  if ((m = P.match(/^CT\d+G([345])/))) return 'DDR' + m[1];
  if ((m = P.match(/^(?:KSM|KVR|KF)(\d{2})/))) return speedGen(Number(m[1]));
  return '';
}

// The serial number's maker code is the most reliable source; part-number rules
// fill in when there is no serial (Crucial modules carry Micron's maker code).
function pickBrand(part, text, serial, rules) {
  const byPart = part || /crucial/i.test(text) ? detectBrand(part, text, rules) : 'Unknown';
  const bySerial = brandFromSerial(serial);
  if (!bySerial) return byPart;
  if (byPart === 'Crucial' && bySerial === 'Micron') return byPart;
  return bySerial;
}

export function parseScan(raw, rules = DEFAULT_BRAND_RULES) {
  // Control characters (GS/RS separators some 2D codes use, line breaks) become spaces.
  const text = String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const part = parsePart(text).toUpperCase();
  const label = between(text, '(L)');
  const serial = between(text, '(S)');
  const { gen, inferred } = detectGen(part, text);
  return {
    raw: text,
    part,
    label,
    serial,
    gen,
    genInferred: inferred,
    brand: pickBrand(part, text, serial, rules),
  };
}
