import {
  analysisKey,
  getAnalysisRecords,
  getKnownGameIds,
  saveAnalysis,
} from './db';

export const ANALYZER_VERSION = 'browser-v1';
export const ENGINE_ID = 'stockfish-18-lite-single';

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

export async function fetchProfileSnapshot({ username, timeClass, signal }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Cannot load a shared profile without a username.');

  const query = new URLSearchParams({ username: normalizedUsername, timeClass });
  const response = await fetch(`/api/profile-analysis?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  let result = null;
  try {
    result = await response.json();
  } catch {
    // Fall through to generic HTTP error handling.
  }

  if (!response.ok) {
    throw new Error(result?.error || `Shared archive lookup failed (${response.status}).`);
  }

  return result || { ok: true, found: false, records: [] };
}

export async function hydrateProfileFromRemote({ username, timeClass, signal, onProgress }) {
  const normalizedUsername = normalizeUsername(username);
  const snapshot = await fetchProfileSnapshot({ username: normalizedUsername, timeClass, signal });

  if (!snapshot?.found || !Array.isArray(snapshot.records) || !snapshot.records.length) {
    return { found: false, added: 0, available: 0 };
  }

  // Never silently mix results produced by a different analysis algorithm.
  // When ANALYZER_VERSION changes, normal Sync will recompute those games once.
  const compatibleRecords = snapshot.records.filter((record) => {
    const version = record?.analyzerVersion || snapshot?.analyzer?.version;
    return version === ANALYZER_VERSION;
  });

  if (!compatibleRecords.length) {
    return {
      found: true,
      added: 0,
      available: 0,
      incompatible: snapshot.records.length,
      analyzer: snapshot.analyzer || null,
    };
  }

  const known = await getKnownGameIds(normalizedUsername, timeClass);
  let added = 0;

  for (let i = 0; i < compatibleRecords.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const record = compatibleRecords[i];
    const id = String(record?.gameId || '').trim();
    if (!id || known.has(id) || !record?.gameRow || !Array.isArray(record?.moveRows)) continue;

    await saveAnalysis({
      key: analysisKey(normalizedUsername, timeClass, id),
      username: normalizedUsername,
      timeClass,
      gameId: id,
      endTime: Number(record.endTime || 0),
      pgn: record.pgn || '',
      gameRow: record.gameRow,
      moveRows: record.moveRows,
      nodes: Number(record.nodes || 0),
      analyzedAt: Number(record.analyzedAt || Date.now()),
    });
    known.add(id);
    added += 1;

    if (added % 100 === 0) {
      onProgress?.({
        phase: 'shared-cache',
        message: `Loaded ${added.toLocaleString()} shared analyzed games...`,
        sharedGames: added,
      });
    }
  }

  return {
    found: true,
    added,
    available: compatibleRecords.length,
    analyzer: snapshot.analyzer || null,
  };
}

export async function uploadProfileSnapshot({ username, timeClass, nodes }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Cannot archive a profile without a username.');

  const records = await getAnalysisRecords(normalizedUsername, timeClass);
  if (!records.length) return { ok: true, skipped: true, recordCount: 0 };

  const compactRecords = records.map((record) => ({
    gameId: record.gameId,
    endTime: record.endTime,
    pgn: record.pgn,
    gameRow: record.gameRow,
    moveRows: record.moveRows,
    nodes: record.nodes,
    analyzedAt: record.analyzedAt,
    analyzerVersion: record.analyzerVersion || ANALYZER_VERSION,
    engine: record.engine || ENGINE_ID,
  }));

  const latestAnalyzedAt = compactRecords.reduce(
    (latest, record) => Math.max(latest, Number(record.analyzedAt || 0)),
    0,
  );

  const payload = {
    schemaVersion: 2,
    analyzer: {
      version: ANALYZER_VERSION,
      engine: ENGINE_ID,
      requestedNodes: Number(nodes || 0),
    },
    profile: {
      username: normalizedUsername,
      timeClass,
    },
    dataset: {
      gameCount: compactRecords.length,
      moveCount: compactRecords.reduce((sum, record) => sum + (record.moveRows?.length || 0), 0),
      latestAnalyzedAt,
    },
    records: compactRecords,
  };

  const response = await fetch('/api/profile-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let result = null;
  try {
    result = await response.json();
  } catch {
    // Fall through to generic HTTP error handling.
  }

  if (!response.ok) {
    throw new Error(result?.error || `Remote archive failed (${response.status}).`);
  }

  return result || { ok: true, recordCount: compactRecords.length };
}
