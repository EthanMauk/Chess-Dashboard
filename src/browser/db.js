const DB_NAME = 'chess-longitudinal-browser-v1';
const STORE = 'analysis';
const VERSION = 1;

function parseClockSeconds(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function clockDataFromPgn(pgn, expectedPlies) {
  const text = String(pgn || '');
  const clocks = [...text.matchAll(/\[%clk\s+([^\]]+)\]/gi)]
    .map((match) => parseClockSeconds(match[1]));

  // Chess.com normally emits one %clk annotation after every played move.
  // Only attach clocks positionally when the counts line up exactly so a rare
  // missing annotation cannot shift every later move onto the wrong clock.
  const clocksByPly = clocks.length === expectedPlies ? clocks : [];

  const tc = text.match(/^\[TimeControl\s+"([^"]+)"\]/mi)?.[1] || '';
  const initialMatch = tc.match(/^(\d+)(?:\+\d+)?$/);
  const initialClockSeconds = initialMatch ? Number(initialMatch[1]) : null;

  return { clocksByPly, initialClockSeconds };
}

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
    const recordMoves = record.moveRows || [];
    const { clocksByPly, initialClockSeconds } = clockDataFromPgn(record.pgn, recordMoves.length);

    games.push({
      ...record.gameRow,
      game_number: gameNumber,
      initial_clock_seconds: initialClockSeconds,
    });

    recordMoves.forEach((move, moveIndex) => {
      moves.push({
        ...move,
        game_number: gameNumber,
        clock_seconds: clocksByPly.length ? clocksByPly[moveIndex] : null,
      });
    });
  });

  return { games, moves };
}
