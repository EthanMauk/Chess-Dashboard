import {
  analysisKey,
  getAnalysisRecords,
  saveAnalysis,
} from './db';

const SCHEMA_VERSION = 2;
const CHUNK_SIZE = 1000;
const ANALYZER_VERSION = 'browser-v1';
const ENGINE_ID = 'stockfish-18-lite-single';
const UPLOAD_BATCH_SIZE = 1000;

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function recordVersion(record) {
  return String(record?.analyzerVersion || ANALYZER_VERSION);
}

function recordMeta(record, chunkId = null) {
  const meta = {
    nodes: Number(record?.nodes || 0),
    analyzedAt: Number(record?.analyzedAt || 0),
    analyzerVersion: recordVersion(record),
  };
  if (chunkId) {
    meta.chunk = chunkId;
    meta.endTime = Number(record?.endTime || 0);
    meta.moveCount = Array.isArray(record?.moveRows) ? record.moveRows.length : Number(record?.moveCount || 0);
  }
  return meta;
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

function bytesToBase64(bytes) {
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

async function gzipJson(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function emptyManifest(username, timeClass) {
  return {
    ok: true,
    found: false,
    schemaVersion: SCHEMA_VERSION,
    chunkSize: CHUNK_SIZE,
    profile: { username, timeClass },
    analyzer: null,
    dataset: { gameCount: 0, moveCount: 0, latestAnalyzedAt: 0 },
    chunks: [],
    records: {},
    updatedAt: new Date(0).toISOString(),
    storageSha: null,
  };
}

async function fetchRawManifest({ username, timeClass, signal }) {
  const query = new URLSearchParams({ username, timeClass });
  const response = await fetch(`/api/profile-analysis/storage/manifest?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(detail || `Shared manifest lookup failed (${response.status}).`);
  }
  const manifest = await response.json();
  manifest.storageSha = response.headers.get('x-github-sha') || null;
  manifest.ok = true;
  manifest.found = Number(manifest?.dataset?.gameCount || 0) > 0;
  return manifest;
}

export async function fetchProfileManifest({ username, timeClass, signal }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Cannot load a shared profile without a username.');

  // Fast path: the Worker streams the manifest from GitHub and does not parse or
  // rebuild it. This keeps Worker CPU usage tiny even for large profiles.
  const raw = await fetchRawManifest({ username: normalizedUsername, timeClass, signal });
  if (raw) return raw;

  // Compatibility path for a profile that only has the old whole-profile file.
  // Calling the legacy manifest endpoint performs the one-time migration. Fresh
  // profiles simply return an empty manifest here.
  const query = new URLSearchParams({ username: normalizedUsername, timeClass });
  const response = await fetch(`/api/profile-analysis/manifest?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const migrated = (await readJsonResponse(response, 'Shared manifest lookup failed')) || emptyManifest(normalizedUsername, timeClass);

  if (Number(migrated?.dataset?.gameCount || 0) > 0) {
    const afterMigration = await fetchRawManifest({ username: normalizedUsername, timeClass, signal });
    if (afterMigration) return afterMigration;
  }

  return { ...emptyManifest(normalizedUsername, timeClass), ...migrated, storageSha: null };
}

async function fetchProfileChunk({ username, timeClass, chunk, signal }) {
  const query = new URLSearchParams({
    username: normalizeUsername(username),
    timeClass,
    chunk: String(chunk),
  });
  const response = await fetch(`/api/profile-analysis/storage/chunk?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/gzip' },
    signal,
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(detail || `Shared chunk lookup failed (${response.status}).`);
  }
  return gunzipJson(new Uint8Array(await response.arrayBuffer()));
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

  // Never allow the analyzer to start from a partially restored shared cache.
  // If the manifest says a game is archived, that game must be present locally
  // after hydration. Otherwise a second device could mistakenly re-analyze old
  // history simply because one chunk failed to restore.
  const remoteIds = Object.keys(manifest.records);
  const finalLocal = await getAnalysisRecords(normalizedUsername, timeClass);
  const finalIds = new Set(finalLocal.map((record) => String(record.gameId)));
  const missingAfterHydration = remoteIds.filter((gameId) => !finalIds.has(gameId));

  if (missingAfterHydration.length) {
    throw new Error(
      `Shared cache hydration incomplete: ${missingAfterHydration.length.toLocaleString()} of ${remoteIds.length.toLocaleString()} archived game(s) could not be restored. Analysis was not started.`
    );
  }

  onProgress?.({
    phase: 'shared-cache',
    message: `Hydrated ${remoteIds.length.toLocaleString()} archived ${timeClass} game(s) from remote cache.`,
    sharedGames: added + updated,
    remoteGames: remoteIds.length,
    hydrationComplete: true,
  });

  return {
    found: true,
    added,
    updated,
    available: Number(manifest?.dataset?.gameCount || remoteIds.length),
    hydrated: remoteIds.length,
    chunksFetched,
    analyzer: manifest.analyzer || null,
  };
}

function compactRecord(record) {
  return {
    gameId: String(record.gameId),
    endTime: Number(record.endTime || 0),
    pgn: record.pgn || '',
    gameRow: record.gameRow,
    moveRows: record.moveRows,
    nodes: Number(record.nodes || 0),
    analyzerVersion: recordVersion(record),
    engine: record.engine || ENGINE_ID,
    analyzedAt: Number(record.analyzedAt || 0),
  };
}

function makeChunkId() {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `u${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

function summarizeChunk(chunkId, records) {
  let minEndTime = null;
  let maxEndTime = null;
  let moveCount = 0;
  for (const record of records) {
    const t = Number(record?.endTime || 0);
    if (t) {
      minEndTime = minEndTime == null ? t : Math.min(minEndTime, t);
      maxEndTime = maxEndTime == null ? t : Math.max(maxEndTime, t);
    }
    moveCount += Array.isArray(record?.moveRows) ? record.moveRows.length : 0;
  }
  return {
    id: chunkId,
    count: records.length,
    moveCount,
    minEndTime,
    maxEndTime,
    updatedAt: new Date().toISOString(),
  };
}

function rebuildDataset(manifest) {
  const metas = Object.values(manifest.records || {});
  manifest.dataset = {
    gameCount: metas.length,
    moveCount: metas.reduce((sum, meta) => sum + Number(meta?.moveCount || 0), 0),
    latestAnalyzedAt: metas.reduce((latest, meta) => Math.max(latest, Number(meta?.analyzedAt || 0)), 0),
  };
  manifest.updatedAt = new Date().toISOString();
}

function cleanManifestForStorage(manifest, username, timeClass, analyzer) {
  const stored = {
    schemaVersion: SCHEMA_VERSION,
    chunkSize: CHUNK_SIZE,
    profile: { username, timeClass },
    analyzer,
    dataset: manifest.dataset,
    chunks: manifest.chunks || [],
    records: manifest.records || {},
    updatedAt: manifest.updatedAt || new Date().toISOString(),
  };
  return stored;
}

async function uploadPreparedFile({ endpoint, username, timeClass, chunk, contentBase64, message, sha }) {
  const query = new URLSearchParams({ username, timeClass });
  if (chunk) query.set('chunk', chunk);
  const githubBody = {
    message,
    content: contentBase64,
    branch: 'main',
  };
  if (sha) githubBody.sha = sha;

  const response = await fetch(`${endpoint}?${query.toString()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // This body is already in the exact GitHub Contents API shape. The Worker
    // streams it upstream rather than parsing/recompressing the chess data.
    body: JSON.stringify(githubBody),
  });
  return readJsonResponse(response, 'Remote archive write failed');
}

async function uploadSnapshotAttempt({ normalizedUsername, timeClass, nodes, localRecords }) {
  const manifest = await fetchProfileManifest({ username: normalizedUsername, timeClass });
  const remoteIndex = manifest?.records || {};

  const pending = localRecords
    .filter((record) => {
      const remote = remoteIndex[String(record.gameId)];
      return !remote || shouldPrefer(record, remote);
    })
    .map(compactRecord)
    .sort((a, b) => a.endTime - b.endTime || a.gameId.localeCompare(b.gameId));

  if (!pending.length) {
    return {
      ok: true,
      skipped: true,
      recordCount: Number(manifest?.dataset?.gameCount || Object.keys(remoteIndex).length),
      uploadedCount: 0,
      batches: 0,
    };
  }

  const nextManifest = {
    ...manifest,
    chunks: [...(manifest.chunks || [])],
    records: { ...(manifest.records || {}) },
  };
  delete nextManifest.ok;
  delete nextManifest.found;
  delete nextManifest.storageSha;

  let uploadedCount = 0;
  let lastCommit = null;
  let batches = 0;

  for (let i = 0; i < pending.length; i += UPLOAD_BATCH_SIZE) {
    const batch = pending.slice(i, i + UPLOAD_BATCH_SIZE);
    const chunkId = makeChunkId();
    const chunkPayload = {
      schemaVersion: SCHEMA_VERSION,
      chunkSize: CHUNK_SIZE,
      profile: { username: normalizedUsername, timeClass },
      chunkId,
      records: batch,
      updatedAt: new Date().toISOString(),
    };

    // Expensive serialization + gzip happens in the user's browser, not in the
    // 10 ms Cloudflare Worker CPU budget.
    const compressed = await gzipJson(chunkPayload);
    const chunkWrite = await uploadPreparedFile({
      endpoint: '/api/profile-analysis/storage/chunk',
      username: normalizedUsername,
      timeClass,
      chunk: chunkId,
      contentBase64: bytesToBase64(compressed),
      message: `Archive ${normalizedUsername} ${timeClass} chunk ${chunkId}`,
    });
    lastCommit = chunkWrite?.commit?.sha || lastCommit;

    for (const record of batch) nextManifest.records[record.gameId] = recordMeta(record, chunkId);
    nextManifest.chunks.push(summarizeChunk(chunkId, batch));
    uploadedCount += batch.length;
    batches += 1;
  }

  const analyzer = {
    version: ANALYZER_VERSION,
    engine: ENGINE_ID,
    requestedNodes: Number(nodes || 0),
  };
  nextManifest.analyzer = analyzer;
  rebuildDataset(nextManifest);

  const storedManifest = cleanManifestForStorage(nextManifest, normalizedUsername, timeClass, analyzer);
  const manifestWrite = await uploadPreparedFile({
    endpoint: '/api/profile-analysis/storage/manifest',
    username: normalizedUsername,
    timeClass,
    contentBase64: textToBase64(JSON.stringify(storedManifest)),
    message: `Update ${normalizedUsername} ${timeClass} analysis manifest`,
    sha: manifest.storageSha || null,
  });
  lastCommit = manifestWrite?.commit?.sha || lastCommit;

  return {
    ok: true,
    recordCount: storedManifest.dataset.gameCount,
    uploadedCount,
    batches,
    commit: lastCommit,
  };
}

export async function uploadProfileSnapshot({ username, timeClass, nodes }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Cannot archive a profile without a username.');

  const localRecords = await getAnalysisRecords(normalizedUsername, timeClass);
  if (!localRecords.length) return { ok: true, skipped: true, recordCount: 0, uploadedCount: 0 };

  // A manifest SHA conflict means another device archived the same profile
  // between our read and write. Refetch once, recalculate pending records, and
  // retry. Any already-uploaded immutable chunk is merely an orphan and cannot
  // corrupt the live manifest.
  try {
    return await uploadSnapshotAttempt({ normalizedUsername, timeClass, nodes, localRecords });
  } catch (error) {
    if (!/409|sha|conflict/i.test(String(error?.message || ''))) throw error;
    return uploadSnapshotAttempt({ normalizedUsername, timeClass, nodes, localRecords });
  }
}
