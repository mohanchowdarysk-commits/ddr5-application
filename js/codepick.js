// Decides what to add when the camera sees one or more codes on a label.
// DDR labels often carry several codes (part number, serial, a 2D code).
// Pure logic so it can be unit-tested; the camera feeds it what it sees.

import { parseScan, detectBrand, DEFAULT_BRAND_RULES } from './parser.js';

const TAGGED = /\((P|S|L)\)/i;

// A code whose text looks like a memory part number we recognise.
export function looksLikePart(text, rules = DEFAULT_BRAND_RULES) {
  const t = String(text || '').trim().toUpperCase();
  if (!t || /\s/.test(t) || t.length < 6) return false;
  return rules.some((r) => r.prefixes.some((p) => p && t.startsWith(p.toUpperCase()))) && detectBrand(t, '', rules) !== 'Unknown';
}

// codes: distinct texts currently visible (most recent frames).
// Returns { action: 'add', raw, how } | { action: 'wait', reason } | { action: 'ask', raw, reason }
export function pickCodes(codes, { rules = DEFAULT_BRAND_RULES, aloneMs = 0 } = {}) {
  const texts = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  if (!texts.length) return { action: 'wait', reason: 'none' };

  // 1) A code that already carries tagged fields — (P) part, (S) serial, (L) label.
  const tagged = texts.filter((t) => TAGGED.test(t));
  if (tagged.length) {
    const best = tagged.find((t) => /\(P\)/i.test(t) && parseScan(t, rules).part) || tagged[0];
    return { action: 'add', raw: best, how: 'tagged' };
  }

  // A free-text code such as "M393A2K43DB2-CTD 16GB 2Rx8" — the workbook took its first word as the part.
  const sentence = texts.find((t) => /\s/.test(t) && looksLikePart(parseScan(t, rules).part, rules));
  if (sentence) return { action: 'add', raw: sentence, how: 'text' };

  const parts = texts.filter((t) => looksLikePart(t, rules));
  const others = texts.filter((t) => !parts.includes(t));

  // 2) Part-number barcode + another barcode (the serial) on the same label.
  if (parts.length === 1 && others.length >= 1) {
    const serial = others.sort((a, b) => b.length - a.length)[0];
    return { action: 'add', raw: `(S)${serial} (P)${parts[0]}`, how: 'combined' };
  }
  if (parts.length > 1) return { action: 'ask', raw: parts[0], reason: 'several part numbers are visible — show one label at a time' };

  // 3) Only a part number: give the serial barcode a moment to come into view.
  if (parts.length === 1) {
    return aloneMs >= 900 ? { action: 'add', raw: parts[0], how: 'part-only' } : { action: 'wait', reason: 'part-only' };
  }

  // 4) Only codes we don't recognise as part numbers (often just the serial).
  if (aloneMs >= 1500) return { action: 'ask', raw: texts[0], reason: 'no part number found in this code' };
  return { action: 'wait', reason: 'unknown' };
}
