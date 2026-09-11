import {
  PHASE_CLASSIFIER_VERSION,
  PHASES,
  phaseDataFromPgn,
  summarizePhaseMoves,
} from './phases';
import { reclassifyStoredMoves, summarizeCategorizedMoves } from './categorization';

const DB_NAME = 'chess-longitudinal-browser-v1';
const STORE = 'analysis';
const PHASE_CACHE_STORE = 'phaseCache';
const VERSION = 2;
const PHASE_CACHE_BATCH_SIZE = 12;

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
      if (!db.objectStoreNames.contains(PHASE_CACHE_STORE)) {
        const phaseStore = db.createObjectStore(PHASE_CACHE_STORE, { keyPath: 'key' });
        phaseStore.createIndex('playerClass', ['username', 'timeClass'], { unique: false });
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

async function getAllFromIndex(db, storeName, indexName, key) {
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).index(indexName).getAll(key);
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  return rows;
}

function embeddedPhasesAreCurrent(recordMoves) {
  return Array.isArray(recordMoves) && recordMoves.length > 0 && recordMoves.every((move) =>
    String(move?.phase_classifier_version || '') === PHASE_CLASSIFIER_VERSION &&
    PHASES.includes(String(move?.phase || '').toLowerCase())
  );
}

function cachedPhasesAreCurrent(cache, expectedMoveCount) {
  return Boolean(
    cache &&
    String(cache.phaseClassifierVersion || '') === PHASE_CLASSIFIER_VERSION &&
    Number(cache.moveCount) === Number(expectedMoveCount) &&
    Array.isArray(cache.phaseRows) &&
    cache.phaseRows.length === expectedMoveCount
  );
}

function phaseOverlay(move, phaseRow) {
  if (!phaseRow) return move;
  return {
    ...move,
    phase: phaseRow.phase || move.phase || '',
    bishops_remaining: phaseRow.bishops_remaining ?? move.bishops_remaining ?? '',
    knights_remaining: phaseRow.knights_remaining ?? move.knights_remaining ?? '',
    minor_pieces_remaining: phaseRow.minor_pieces_remaining ?? move.minor_pieces_remaining ?? '',
    heavy_pieces_remaining: phaseRow.heavy_pieces_remaining ?? move.heavy_pieces_remaining ?? '',
    non_pawn_pieces_remaining: phaseRow.non_pawn_pieces_remaining ?? move.non_pawn_pieces_remaining ?? '',
    pawns_remaining: phaseRow.pawns_remaining ?? move.pawns_remaining ?? '',
    developed_or_gone_minors: phaseRow.developed_or_gone_minors ?? move.developed_or_gone_minors ?? '',
    white_developed_or_gone_minors: phaseRow.white_developed_or_gone_minors ?? move.white_developed_or_gone_minors ?? '',
    black_developed_or_gone_minors: phaseRow.black_developed_or_gone_minors ?? move.black_developed_or_gone_minors ?? '',
    castling_resolved_sides: phaseRow.castling_resolved_sides ?? move.castling_resolved_sides ?? '',
    central_pawns_resolved: phaseRow.central_pawns_resolved ?? move.central_pawns_resolved ?? '',
    phase_classifier_version: phaseRow.phase_classifier_version || PHASE_CLASSIFIER_VERSION,
  };
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  try {
    const records = await getAllFromIndex(
      db,
      STORE,
      'playerClass',
      [username.toLowerCase(), timeClass],
    );
    return records.sort((a, b) =>
      (a.endTime || 0) - (b.endTime || 0) || String(a.gameId).localeCompare(String(b.gameId))
    );
  } finally {
    db.close();
  }
}

async function getPhaseCacheRecords(username, timeClass) {
  const db = await openDb();
  try {
    return await getAllFromIndex(
      db,
      PHASE_CACHE_STORE,
      'playerClass',
      [username.toLowerCase(), timeClass],
    );
  } finally {
    db.close();
  }
}

async function savePhaseCacheBatch(records) {
  if (!records.length) return;
  const db = await openDb();
  const tx = db.transaction(PHASE_CACHE_STORE, 'readwrite');
  const store = tx.objectStore(PHASE_CACHE_STORE);
  for (const record of records) store.put(record);
  await txDone(tx);
  db.close();
}

export async function getKnownGameIds(username, timeClass) {
  const rows = await getAnalysisRecords(username, timeClass);
  return new Set(rows.map((r) => r.gameId));
}

export async function clearAnalysis(username, timeClass) {
  const [rows, phaseRows] = await Promise.all([
    getAnalysisRecords(username, timeClass),
    getPhaseCacheRecords(username, timeClass),
  ]);
  if (!rows.length && !phaseRows.length) return 0;

  const db = await openDb();
  const tx = db.transaction([STORE, PHASE_CACHE_STORE], 'readwrite');
  const analysisStore = tx.objectStore(STORE);
  const phaseStore = tx.objectStore(PHASE_CACHE_STORE);
  for (const row of rows) analysisStore.delete(row.key);
  for (const row of phaseRows) phaseStore.delete(row.key);
  await txDone(tx);
  db.close();
  return rows.length;
}

// Rebuild only stale/missing phase metadata. This intentionally runs separately
// from loadDashboardRows so the profile can render immediately. It never runs
// Stockfish and never mutates the archived engine-analysis records.
//
// Stale games are interleaved across the full history instead of processed
// strictly oldest -> newest. That lets every phase chart bucket receive data
// quickly. Each saved batch also reports its freshly computed game summaries so
// React can update the phase graphs immediately instead of waiting for the
// entire profile backfill to finish.
export async function backfillPhaseCache(username, timeClass, { signal, onProgress } = {}) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!normalizedUsername) return { updated: 0, total: 0, failed: 0 };

  const [records, cacheRows] = await Promise.all([
    getAnalysisRecords(normalizedUsername, timeClass),
    getPhaseCacheRecords(normalizedUsername, timeClass),
  ]);
  const cacheByKey = new Map(cacheRows.map((row) => [row.key, row]));

  const staleByBand = Array.from({ length: Math.min(20, Math.max(1, records.length)) }, () => []);
  records.forEach((record, index) => {
    const recordMoves = record.moveRows || [];
    if (!recordMoves.length || embeddedPhasesAreCurrent(recordMoves)) return;

    const cache = cacheByKey.get(record.key);
    const cacheCurrent = cachedPhasesAreCurrent(cache, recordMoves.length);
    const hasCachedSummary = cacheCurrent && cache?.phaseStats && typeof cache.phaseStats === 'object';
    if (hasCachedSummary) return;

    const band = Math.min(
      staleByBand.length - 1,
      Math.floor((index * staleByBand.length) / Math.max(1, records.length)),
    );
    staleByBand[band].push({ record, gameNumber: index + 1, cacheCurrent, cache });
  });

  // Round-robin through chart bands: game ~1, ~52, ~103, ... before returning
  // for the second stale game in each band. The whole graph therefore starts
  // filling almost immediately during a first-time migration.
  const stale = [];
  for (let depth = 0; ; depth += 1) {
    let added = false;
    for (const band of staleByBand) {
      if (band[depth]) {
        stale.push(band[depth]);
        added = true;
      }
    }
    if (!added) break;
  }

  if (!stale.length) return { updated: 0, total: 0, failed: 0 };

  let updated = 0;
  let failed = 0;
  let pending = [];
  let pendingUpdates = [];

  for (let i = 0; i < stale.length; i += 1) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const { record, gameNumber, cacheCurrent, cache } = stale[i];
    const recordMoves = record.moveRows || [];
    const moveCount = recordMoves.length;

    // If the phase rows are already current and only the compact game summary
    // is missing, reuse them. Otherwise classify the stored PGN once.
    const phaseRows = cacheCurrent
      ? cache.phaseRows
      : phaseDataFromPgn(record.pgn, moveCount);

    if (phaseRows.length === moveCount && moveCount > 0) {
      const movesWithPhase = recordMoves.map((move, moveIndex) =>
        phaseOverlay(move, phaseRows[moveIndex])
      );
      const categorizedMoves = reclassifyStoredMoves(movesWithPhase);
      const phaseStats = summarizePhaseMoves(
        categorizedMoves,
        record.gameRow?.player_color || 'White',
      );

      pending.push({
        key: record.key,
        username: normalizedUsername,
        timeClass,
        gameId: String(record.gameId),
        phaseClassifierVersion: PHASE_CLASSIFIER_VERSION,
        moveCount,
        phaseRows,
        phaseStats,
        cachedAt: Date.now(),
      });
      pendingUpdates.push({ gameNumber, phaseStats });
      updated += 1;
    } else {
      failed += 1;
    }

    const shouldFlush = pending.length >= PHASE_CACHE_BATCH_SIZE || i === stale.length - 1;
    if (shouldFlush) {
      await savePhaseCacheBatch(pending);
      const updates = pendingUpdates;
      pending = [];
      pendingUpdates = [];
      onProgress?.({
        current: i + 1,
        total: stale.length,
        percent: ((i + 1) / stale.length) * 100,
        updated,
        failed,
        updates,
      });
      // Let React paint and keep the page interactive during the one-time
      // migration of a large existing profile.
      await yieldToBrowser();
    }
  }

  return { updated, total: stale.length, failed };
}

export async function loadDashboardRows(username, timeClass) {
  const [records, cacheRows] = await Promise.all([
    getAnalysisRecords(username, timeClass),
    getPhaseCacheRecords(username, timeClass),
  ]);
  const cacheByKey = new Map(cacheRows.map((row) => [row.key, row]));
  const games = [];
  const moves = [];
  let stalePhaseGames = 0;

  records.forEach((record, index) => {
    const gameNumber = index + 1;
    const recordMoves = record.moveRows || [];
    const { clocksByPly, initialClockSeconds } = clockDataFromPgn(record.pgn, recordMoves.length);

    const cache = cacheByKey.get(record.key);
    const cachedCurrent = cachedPhasesAreCurrent(cache, recordMoves.length);
    const embeddedCurrent = embeddedPhasesAreCurrent(recordMoves);
    let movesWithPhase;

    if (cachedCurrent) {
      movesWithPhase = recordMoves.map((move, moveIndex) => phaseOverlay(move, cache.phaseRows[moveIndex]));
    } else if (embeddedCurrent) {
      movesWithPhase = recordMoves;
    } else {
      // Fast initial render: use the stored analysis rows as-is and let
      // backfillPhaseCache derive the current phase labels in the background.
      movesWithPhase = recordMoves;
      stalePhaseGames += 1;
    }

    // Categorization is deliberately recalculated from the already-stored
    // engine facts. This keeps old and newly synced games on the same Miss vs
    // Blunder definition without another Stockfish pass.
    const categorizedMoves = reclassifyStoredMoves(movesWithPhase);
    const playerColor = record.gameRow?.player_color || 'White';
    const categoryStats = summarizeCategorizedMoves(categorizedMoves, playerColor);
    const phaseStats = (cachedCurrent || embeddedCurrent)
      ? summarizePhaseMoves(categorizedMoves, playerColor)
      : {};

    games.push({
      ...record.gameRow,
      ...categoryStats,
      ...phaseStats,
      game_number: gameNumber,
      initial_clock_seconds: initialClockSeconds,
    });

    categorizedMoves.forEach((move, moveIndex) => {
      moves.push({
        ...move,
        game_number: gameNumber,
        clock_seconds: clocksByPly.length ? clocksByPly[moveIndex] : null,
      });
    });
  });

  return {
    games,
    moves,
    phaseCache: {
      version: PHASE_CLASSIFIER_VERSION,
      staleGames: stalePhaseGames,
      readyGames: Math.max(0, records.length - stalePhaseGames),
    },
  };
}
