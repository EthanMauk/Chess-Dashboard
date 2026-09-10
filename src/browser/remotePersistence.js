import {
  analysisKey,
  getAnalysisRecords,
  saveAnalysis,
} from './db';

const SCHEMA_VERSION = 2;
const ANALYZER_VERSION = 'browser-v1';
const ENGINE_ID = 'stockfish-18-lite-single';
const UPLOAD_BATCH_SIZE = 1000;

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function recordVersion(record) {
  return String(record?.analyzerVersion || ANALYZER_VERSION);
}

function recordMeta(record) {
  return {
    nodes: Number(record?.nodes || 0),
    analyzedAt: Number(record?.analyzedAt || 0),
    analyzerVersion: recordVersion(record),
  };
}

// Prefer a different analyzer version when it is newer in time; within the same
// analyzer version, preserve the deeper Stockfish search. Equal-depth ties use
// the newest analysis. This prevents a later 5k scan from replacing a 30k scan.
function shouldPrefer(candidate, current) {
  if (!current) return true;
  const a = recordMeta(candidate);
  const b = recordMeta(current);
  if (a.analyzerVersion !== b.analyzerVersion) return a.analyzedAt >= b.analyzedAt;
  if (a.nodes !== b.nodes) return a.nodes > b.nodes;
  return a.analyzedAt >= b.analyzedAt;
}

async function readJsonResponse(response, fallbackMessage) {
  let result = null;
  try {
    result = await response.json();
  } catch {
    // Fall through to the generic error below.
  }
  if (!response.ok) {
    throw new Error(result?.error || `${fallbackMessage} (${response.status}).`);
  }
  return result;
}

export async function fetchProfileManifest({ username, timeClass, signal }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Cannot load a shared profile without a username.');

  const query = new URLSearchParams({ username: normalizedUsername, timeClass });
  const response = await fetch(`/api/profile-analysis/manifest?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  return (await readJsonResponse(response, 'Shared manifest lookup failed')) || {
    ok: true,
    found: false,
    records: {},
    chunks: [],
  };
}

async function fetchProfileChunk({ username, timeClass, chunk, signal }) {
  const query = new URLSearchParams({
    username: normalizeUsername(username),
    timeClass,
    chunk: String(chunk),
  });
  const response = await fetch(`/api/profile-analysis/chunk?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  return readJsonResponse(response, 'Shared chunk lookup failed');
}

export async function hydrateProfileFromRemote({ username, timeClass, signal, onProgress }) {
  const normalizedUsername = normalizeUsername(username);
  const manifest = await fetchProfileManifest({ username: normalizedUsername, timeClass, signal });

  if (!manifest?.found || !manifest?.records || !Object.keys(manifest.records).length) {
    return { found: false, added: 0, updated: 0, available: 0, chunksFetched: 0 };
  }

  const localRecords = await getAnalysisRecords(normalizedUsername, timeClass);
  const localById = new Map(localRecords.map((record) => [String(record.gameId), record]));
  const neededByChunk = new Map();

  for (const [gameId, meta] of Object.entries(manifest.records)) {
    const local = localById.get(gameId);
    const remoteCandidate = {
      nodes: meta?.nodes,
      analyzedAt: meta?.analyzedAt,
      analyzerVersion: meta?.analyzerVersion,
    };
    if (!local || shouldPrefer(remoteCandidate, local)) {
      const chunkId = String(meta?.chunk || '');
      if (!chunkId) continue;
      if (!neededByChunk.has(chunkId)) neededByChunk.set(chunkId, new Set());
      neededByChunk.get(chunkId).add(gameId);
    }
  }

  let added = 0;
  let updated = 0;
  let chunksFetched = 0;
  const chunkEntries = [...neededByChunk.entries()];

  for (let chunkIndex = 0; chunkIndex < chunkEntries.length; chunkIndex++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const [chunkId, wantedIds] = chunkEntries[chunkIndex];
    const chunk = await fetchProfileChunk({
      username: normalizedUsername,
      timeClass,
      chunk: chunkId,
      signal,
    });
    chunksFetched += 1;

    for (const record of chunk?.records || []) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const id = String(record?.gameId || '').trim();
      if (!id || !wantedIds.has(id) || !record?.gameRow || !Array.isArray(record?.moveRows)) continue;

      const previous = localById.get(id);
      if (previous && !shouldPrefer(record, previous)) continue;

      const hydrated = {
        key: analysisKey(normalizedUsername, timeClass, id),
        username: normalizedUsername,
        timeClass,
        gameId: id,
        endTime: Number(record.endTime || 0),
        pgn: record.pgn || '',
        gameRow: record.gameRow,
        moveRows: record.moveRows,
        nodes: Number(record.nodes || 0),
        analyzerVersion: recordVersion(record),
        engine: record.engine || ENGINE_ID,
        analyzedAt: Number(record.analyzedAt || Date.now()),
      };
      await saveAnalysis(hydrated);
      localById.set(id, hydrated);
      if (previous) updated += 1;
      else added += 1;
    }

    onProgress?.({
      phase: 'shared-cache',
      message: `Loaded shared cache chunk ${chunkIndex + 1}/${chunkEntries.length} · ${(added + updated).toLocaleString()} game(s) hydrated...`,
      sharedGames: added + updated,
    });
  }

  return {
    found: true,
    added,
    updated,
    available: Number(manifest?.dataset?.gameCount || Object.keys(manifest.records).length),
    chunksFetched,
    analyzer: manifest.analyzer || null,
  };
}

function compactRecord(record) {
  return {
    gameId: record.gameId,
    endTime: record.endTime,
    pgn: record.pgn,
    gameRow: record.gameRow,
    moveRows: record.moveRows,
    nodes: Number(record.nodes || 0),
    analyzerVersion: recordVersion(record),
    engine: record.engine || ENGINE_ID,
    analyzedAt: Number(record.analyzedAt || 0),
  };
}

export async function uploadProfileSnapshot({ username, timeClass, nodes }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Cannot archive a profile without a username.');

  const localRecords = await getAnalysisRecords(normalizedUsername, timeClass);
  if (!localRecords.length) return { ok: true, skipped: true, recordCount: 0, uploadedCount: 0 };

  // The manifest contains only compact per-game metadata, so we can determine
  // what GitHub already has without downloading every move-level chunk.
  const manifest = await fetchProfileManifest({ username: normalizedUsername, timeClass });
  const remoteIndex = manifest?.records || {};

  const pending = localRecords
    .filter((record) => {
      const remote = remoteIndex[String(record.gameId)];
      return !remote || shouldPrefer(record, remote);
    })
    .map(compactRecord);

  if (!pending.length) {
    return {
      ok: true,
      skipped: true,
      recordCount: Number(manifest?.dataset?.gameCount || Object.keys(remoteIndex).length),
      uploadedCount: 0,
      batches: 0,
    };
  }

  let uploadedCount = 0;
  let recordCount = Number(manifest?.dataset?.gameCount || Object.keys(remoteIndex).length);
  let lastCommit = null;
  let batches = 0;

  for (let i = 0; i < pending.length; i += UPLOAD_BATCH_SIZE) {
    const batch = pending.slice(i, i + UPLOAD_BATCH_SIZE);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      chunkSize: UPLOAD_BATCH_SIZE,
      analyzer: {
        version: ANALYZER_VERSION,
        engine: ENGINE_ID,
        requestedNodes: Number(nodes || 0),
      },
      profile: { username: normalizedUsername, timeClass },
      records: batch,
    };

    const response = await fetch('/api/profile-analysis/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await readJsonResponse(response, 'Remote archive batch failed');
    uploadedCount += Number(result?.acceptedCount || 0);
    recordCount = Number(result?.recordCount || recordCount);
    lastCommit = result?.commit || lastCommit;
    batches += 1;
  }

  return { ok: true, recordCount, uploadedCount, batches, commit: lastCommit };
}
