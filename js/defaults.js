import { DEFAULT_BRAND_RULES } from './parser.js';
import { DEFAULT_CAPACITY } from './trays.js';

// The 13 scanner sheets of the original workbook, 100 trays each.
const SHEETS = [
  ['Scanner 1', 'Ashu'],
  ['Scanner 2', 'Ronny'],
  ['Scanner 3', 'Elvira'],
  ['Scanner 4', 'Sam'],
  ['Scanner 5', 'Ryder'],
  ['Scanner 6', 'Sal'],
  ['Scanner 7', 'Shashank'],
  ['Sam Extra', 'Sam'],
  ['Ronny Extra', 'Ronny'],
  ['Ashu Extra', 'Ashu'],
  ['Shashank Extra', 'Shashank'],
  ['Sal Extra', 'Sal'],
  ['Ryder Extra', 'Ryder'],
];

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function shortId(n = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(n);
  (globalThis.crypto || { getRandomValues: (b) => b.map(() => Math.random() * 256) }).getRandomValues(buf);
  return [...buf].map((b) => chars[b % chars.length]).join('');
}

export function defaultStations() {
  return SHEETS.map(([name, operator], i) => ({
    id: 'st' + (i + 1),
    name,
    operator,
    trayStart: i * 100 + 1,
    trayEnd: i * 100 + 100,
  }));
}

export function newWorkspace(name = 'My Workspace') {
  return {
    id: 'ws_' + shortId(16),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stations: defaultStations(),
    settings: {
      capacity: DEFAULT_CAPACITY,
      allowDuplicateSerials: false,
      brandRules: structuredClone(DEFAULT_BRAND_RULES),
    },
    cloud: null, // { url, key } when synced through Supabase
  };
}
