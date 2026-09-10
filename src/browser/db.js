const DB_NAME = 'chess-longitudinal-browser-v1';
const STORE = 'analysis';
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('playerClass', ['username', 'timeClass'], { unique: false });
        store.createIndex('endTime', 'endTime', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function analysisKey(username, timeClass, gameId) {
  return `${username.toLowerCase()}|${timeClass}|${gameId}`;
}

export async function saveAnalysis(record) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await txDone(tx);
  db.close();
}

export async function getAnalysisRecords(username, timeClass) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const index = tx.objectStore(STORE).index('playerClass');
  const req = index.getAll([username.toLowerCase(), timeClass]);
  const records = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  return records.sort((a, b) => (a.endTime || 0) - (b.endTime || 0) || a.gameId.localeCompare(b.gameId));
}

export async function getKnownGameIds(username, timeClass) {
  const rows = await getAnalysisRecords(username, timeClass);
  return new Set(rows.map((r) => r.gameId));
}

export async function clearAnalysis(username, timeClass) {
  const rows = await getAnalysisRecords(username, timeClass);
  if (!rows.length) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const row of rows) store.delete(row.key);
  await txDone(tx);
  db.close();
  return rows.length;
}

export async function loadDashboardRows(username, timeClass) {
  const records = await getAnalysisRecords(username, timeClass);
  const games = [];
  const moves = [];

  records.forEach((record, index) => {
    const gameNumber = index + 1;
    games.push({ ...record.gameRow, game_number: gameNumber });
    for (const move of record.moveRows || []) {
      moves.push({ ...move, game_number: gameNumber });
    }
  });

  return { games, moves };
}
