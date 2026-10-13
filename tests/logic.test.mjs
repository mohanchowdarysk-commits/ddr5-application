import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScan, parsePart, detectBrand } from '../js/parser.js';
import { decide, makePlacer, traySummary, rangeProblems } from '../js/trays.js';

test('part number after (P), stopping at (M)', () => {
  const r = parseScan('(L)16GB 2Rx8 PC4-2666V DDR4 (S)S12345678 (P)M393A2K43DB2-CTD (M)SAMSUNG');
  assert.equal(r.part, 'M393A2K43DB2-CTD');
  assert.equal(r.label, '16GB 2Rx8 PC4-2666V DDR4');
  assert.equal(r.serial, 'S12345678');
  assert.equal(r.brand, 'Samsung');
  assert.equal(r.gen, 'DDR4');
  assert.equal(r.genInferred, false);
});

test('part number after (P) without (M) takes first word', () => {
  assert.equal(parsePart('(S)ABC (P)HMA84GR7CJR4N-VK extra words'), 'HMA84GR7CJR4N-VK');
});

test('plain scan: first word, or second word when first is 1–2 chars', () => {
  assert.equal(parsePart('MTA36ASF4G72PZ-2G9E2 16GB'), 'MTA36ASF4G72PZ-2G9E2');
  assert.equal(parsePart('1P KSM32RD8/16HDR 123'), 'KSM32RD8/16HDR');
  assert.equal(parsePart('  M321R4GA3BB6-CQK  '), 'M321R4GA3BB6-CQK');
});

test('©MLCC marker is stripped', () => {
  assert.equal(parsePart('©MLCC M393A4K40DB3-CWE'), 'M393A4K40DB3-CWE');
});

test('brands, including the KSM fix', () => {
  assert.equal(detectBrand('KSM32RD8/16HDR', ''), 'Kingston');
  assert.equal(detectBrand('HMA84GR7CJR4N-VK', ''), 'SK Hynix');
  assert.equal(detectBrand('HMCG88AGBRA190N', ''), 'SK Hynix');
  assert.equal(detectBrand('MTA18ASF2G72PZ-2G3B1', ''), 'Micron');
  assert.equal(detectBrand('CT16G4DFRA32A', ''), 'Crucial');
  assert.equal(detectBrand('XYZ123', 'crucial ballistix'), 'Crucial');
  assert.equal(detectBrand('ABC', ''), 'Unknown');
});

test('generation inferred from part number when not in text', () => {
  assert.deepEqual([parseScan('M393B2G70BH0-CK0').gen, parseScan('M393B2G70BH0-CK0').genInferred], ['DDR3', true]);
  assert.equal(parseScan('M321R4GA3BB6-CQK').gen, 'DDR5');
  assert.equal(parseScan('HMT41GR7AFR4C-PB').gen, 'DDR3');
  assert.equal(parseScan('KSM48E40BD8KM-32HM').gen, 'DDR5');
  assert.equal(parseScan('KVR16N11/8').gen, 'DDR3');
  assert.equal(parseScan('CT32G4RFD4266').gen, 'DDR4');
  assert.equal(parseScan('ZZZ').gen, '');
});

const st1 = { id: 'st1', name: 'S1', trayStart: 1, trayEnd: 3 };
const st2 = { id: 'st2', name: 'S2', trayStart: 101, trayEnd: 200 };

function run(lines, station, settings = { capacity: 2 }) {
  const scans = [];
  const placer = makePlacer(scans, settings);
  let ts = 1;
  for (const raw of lines) {
    const p = parseScan(raw);
    const d = placer.place(p, station);
    const rec = { id: String(ts), stationId: station.id, ...p, tray: d.tray, status: d.status, ts: ts++ };
    placer.commit(rec);
    scans.push(rec);
  }
  return scans;
}

test('same part fills a tray, then opens a new one (capacity 2)', () => {
  const scans = run(['(S)a (P)AAA', '(S)b (P)AAA', '(S)c (P)AAA', '(S)d (P)BBB'], st1);
  assert.deepEqual(scans.map((s) => s.tray), [1, 1, 2, 3]);
  assert.ok(scans.every((s) => s.status === 'placed'));
});

test('station runs out of trays', () => {
  const scans = run(['(P)A1', '(P)A2', '(P)A3', '(P)A4'], st1);
  assert.deepEqual(scans.map((s) => s.status), ['placed', 'placed', 'placed', 'full']);
});

test('duplicate serial is rejected, unless allowed', () => {
  const scans = run(['(S)X1 (P)AAA', '(S)X1 (P)AAA'], st2);
  assert.equal(scans[1].status, 'duplicate');
  const ok = run(['(S)X1 (P)AAA', '(S)X1 (P)AAA'], st2, { capacity: 50, allowDuplicateSerials: true });
  assert.equal(ok[1].status, 'placed');
});

test('missing part number', () => {
  assert.equal(run(['   (S)only-serial (P)'], st1)[0].status, 'nopart');
});

test('decide matches the placer; deleting a scan frees the slot without moving others', () => {
  const scans = run(['(P)AAA', '(P)BBB', '(P)CCC'], st1);
  const remaining = scans.filter((s) => s.part !== 'BBB');
  assert.deepEqual(remaining.map((s) => s.tray), [1, 3]);
  assert.equal(decide(parseScan('(P)DDD'), st1, remaining, { capacity: 2 }).tray, 2);
});

test('tray summary and range checks', () => {
  const scans = run(['(P)AAA', '(P)AAA'], st1);
  const rows = traySummary(scans, [st1], 2);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].state, 'full');
  assert.equal(rows[1].state, 'empty');
  assert.deepEqual(rangeProblems([st1, { id: 'x', name: 'X', trayStart: 3, trayEnd: 9 }]), ['S1 and X overlap']);
});

test('no tray limit (capacity 0): one tray per part number', async () => {
  const { capOf } = await import('../js/trays.js');
  assert.equal(capOf({ capacity: 0 }), Infinity);
  assert.equal(capOf({}), 50);
  const lines = Array.from({ length: 120 }, (_, i) => `(S)n${i} (P)${i % 2 ? 'AAA' : 'BBB'}`);
  const scans = run(lines, st1, { capacity: 0 });
  assert.deepEqual([...new Set(scans.map((s) => s.tray))].sort(), [1, 2]);
  assert.ok(scans.every((s) => s.status === 'placed'));
  const rows = traySummary(scans, [st1], Infinity);
  assert.deepEqual(rows.map((r) => r.state), ['partial', 'partial', 'empty']);
});

test('members get consecutive tray ranges', async () => {
  const { stationsForMembers } = await import('../js/defaults.js');
  const st = stationsForMembers(['Ashu', 'Ronny'], 40);
  assert.deepEqual(st.map((s) => [s.name, s.operator, s.trayStart, s.trayEnd]), [['Ashu', 'Ashu', 1, 40], ['Ronny', 'Ronny', 41, 80]]);
  assert.deepEqual(rangeProblems(st), []);
});
