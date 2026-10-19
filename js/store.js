// Local persistence in IndexedDB. Every browser keeps its own copy, so a
// workspace is private to the device unless it is explicitly synced.

const DB_NAME = 'ddr-tray-scanner';
const DB_VERSION = 1;

let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('scans')) {
        const s = db.createObjectStore('scans', { keyPath: 'id' });
        s.createIndex('ws', 'wsId');
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const o = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        o.createIndex('ws', 'wsId');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Database is blocked by another tab. Close other tabs and reload.'));
  });
  return dbPromise;
}

export async function listWorkspaces() {
  const db = await openDb();
  return req(db.transaction('workspaces').objectStore('workspaces').getAll());
}

export async function getWorkspace(id) {
  const db = await openDb();
  return req(db.transaction('workspaces').objectStore('workspaces').get(id));
}

export async function putWorkspace(ws) {
  const db = await openDb();
  const tx = db.transaction('workspaces', 'readwrite');
  tx.objectStore('workspaces').put(ws);
  return txDone(tx);
}

export async function deleteWorkspace(id) {
  const db = await openDb();
  const tx = db.transaction(['workspaces', 'scans', 'outbox'], 'readwrite');
  tx.objectStore('workspaces').delete(id);
  for (const name of ['scans', 'outbox']) {
    const idx = tx.objectStore(name).index('ws');
    const cur = idx.openKeyCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        tx.objectStore(name).delete(c.primaryKey);
        c.continue();
      }
    };
  }
  return txDone(tx);
}

export async function getScans(wsId) {
  const db = await openDb();
  return req(db.transaction('scans').objectStore('scans').index('ws').getAll(IDBKeyRange.only(wsId)));
}

export async function countScans(wsId) {
  const db = await openDb();
  return req(db.transaction('scans').objectStore('scans').index('ws').count(IDBKeyRange.only(wsId)));
}

export async function putScans(scans) {
  if (!scans.length) return;
  const db = await openDb();
  const tx = db.transaction('scans', 'readwrite');
  const st = tx.objectStore('scans');
  for (const s of scans) st.put(s);
  return txDone(tx);
}

export async function deleteScans(ids) {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction('scans', 'readwrite');
  const st = tx.objectStore('scans');
  for (const id of ids) st.delete(id);
  return txDone(tx);
}

// Outbox: pending changes for a synced workspace, flushed in order.
export async function outboxAdd(items) {
  if (!items.length) return;
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  for (const it of items) tx.objectStore('outbox').add(it);
  return txDone(tx);
}

export async function outboxList(wsId) {
  const db = await openDb();
  const all = await req(db.transaction('outbox').objectStore('outbox').index('ws').getAll(IDBKeyRange.only(wsId)));
  return all.sort((a, b) => a.seq - b.seq);
}

export async function outboxRemove(seqs) {
  if (!seqs.length) return;
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  for (const s of seqs) tx.objectStore('outbox').delete(s);
  return txDone(tx);
}
