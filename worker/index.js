const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const SCHEMA_VERSION = 2;
const CHUNK_SIZE = 1000;
const LEGACY_SCHEMA_VERSION = 1;
const DEFAULT_ANALYZER_VERSION = 'browser-v1';
const DEFAULT_ENGINE = 'stockfish-18-lite-single';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(username)) return null;
  return username;
}

function normalizeTimeClass(value) {
  return value === 'rapid' || value === 'blitz' ? value : null;
}

function normalizeChunkId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9-]{1,40}$/.test(id) ? id : null;
}

function bytesToBase64(bytes) {
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

async function githubRequest(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'chess-dashboard-archive-worker',
      ...(init.headers || {}),
    },
  });
}

function repoApiPath(env, repoPath, includeRef = true) {
  const owner = encodeURIComponent(env.GITHUB_OWNER);
  const repo = encodeURIComponent(env.GITHUB_REPO);
  const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
  const branch = encodeURIComponent(env.GITHUB_BRANCH || 'main');
  return `/repos/${owner}/${repo}/contents/${encodedPath}${includeRef ? `?ref=${branch}` : ''}`;
}

async function existingFile(env, repoPath) {
  const response = await githubRequest(env, repoApiPath(env, repoPath));
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub lookup failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return response.json();
}

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function readRawBytes(env, repoPath) {
  const response = await githubRequest(env, repoApiPath(env, repoPath), {
    headers: { accept: 'application/vnd.github.raw+json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function readJsonFile(env, repoPath) {
  const bytes = await readRawBytes(env, repoPath);
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readGzipJsonFile(env, repoPath) {
  const bytes = await readRawBytes(env, repoPath);
  if (!bytes) return null;
  return JSON.parse(await gunzipText(bytes));
}

async function saveBytesFile(env, repoPath, bytes, message) {
  // Retry once on a GitHub SHA conflict. This makes simultaneous syncs less
  // likely to lose work; the caller can re-run its merge if a conflict remains.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await existingFile(env, repoPath);
    const owner = encodeURIComponent(env.GITHUB_OWNER);
    const repo = encodeURIComponent(env.GITHUB_REPO);
    const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
    const body = {
      message,
      content: bytesToBase64(bytes),
      branch: env.GITHUB_BRANCH || 'main',
    };
    if (existing?.sha) body.sha = existing.sha;

    const response = await githubRequest(env, `/repos/${owner}/${repo}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.ok) return response.json();
    const text = await response.text();
    if (response.status === 409 && attempt === 0) continue;
    throw new Error(`GitHub save failed (${response.status}): ${text.slice(0, 500)}`);
  }
  throw new Error('GitHub save failed after retry.');
}

async function saveJsonFile(env, repoPath, value, message) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return saveBytesFile(env, repoPath, bytes, message);
}

async function saveGzipJsonFile(env, repoPath, value, message) {
  const bytes = await gzipText(JSON.stringify(value));
  return saveBytesFile(env, repoPath, bytes, message);
}

function profileBase(username, timeClass) {
  return `profiles/${username}/${timeClass}`;
}

function manifestPath(username, timeClass) {
  return `${profileBase(username, timeClass)}/manifest.json`;
}

function chunkPath(username, timeClass, chunkId) {
  return `${profileBase(username, timeClass)}/chunk-${chunkId}.json.gz`;
}

function legacyPath(username, timeClass) {
  return `profiles/${username}/${timeClass}.json.gz`;
}

function makeEmptyManifest(username, timeClass) {
  return {
    schemaVersion: SCHEMA_VERSION,
    chunkSize: CHUNK_SIZE,
    profile: { username, timeClass },
    analyzer: null,
    dataset: { gameCount: 0, moveCount: 0, latestAnalyzedAt: 0 },
    chunks: [],
    records: {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizedRecord(record, analyzer = null) {
  return {
    ...record,
    gameId: String(record?.gameId || ''),
    endTime: Number(record?.endTime || 0),
    nodes: Number(record?.nodes || 0),
    analyzerVersion: String(record?.analyzerVersion || analyzer?.version || DEFAULT_ANALYZER_VERSION),
    engine: String(record?.engine || analyzer?.engine || DEFAULT_ENGINE),
    analyzedAt: Number(record?.analyzedAt || 0),
  };
}

function recordMeta(record, chunkId) {
  return {
    chunk: chunkId,
    endTime: Number(record?.endTime || 0),
    nodes: Number(record?.nodes || 0),
    analyzerVersion: String(record?.analyzerVersion || DEFAULT_ANALYZER_VERSION),
    analyzedAt: Number(record?.analyzedAt || 0),
    moveCount: Array.isArray(record?.moveRows) ? record.moveRows.length : 0,
  };
}

function shouldPrefer(candidate, current) {
  if (!current) return true;
  const aVersion = String(candidate?.analyzerVersion || DEFAULT_ANALYZER_VERSION);
  const bVersion = String(current?.analyzerVersion || DEFAULT_ANALYZER_VERSION);
  const aTime = Number(candidate?.analyzedAt || 0);
  const bTime = Number(current?.analyzedAt || 0);
  if (aVersion !== bVersion) return aTime >= bTime;
  const aNodes = Number(candidate?.nodes || 0);
  const bNodes = Number(current?.nodes || 0);
  if (aNodes !== bNodes) return aNodes > bNodes;
  return aTime >= bTime;
}

function summarizeChunk(chunkId, records, username, timeClass) {
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
    path: chunkPath(username, timeClass, chunkId),
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
  return manifest;
}

async function writeChunk(env, username, timeClass, chunkId, records) {
  const normalized = records
    .map((record) => normalizedRecord(record))
    .filter((record) => record.gameId);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    chunkSize: CHUNK_SIZE,
    profile: { username, timeClass },
    chunkId,
    records: normalized,
    updatedAt: new Date().toISOString(),
  };
  const result = await saveGzipJsonFile(
    env,
    chunkPath(username, timeClass, chunkId),
    payload,
    `Update ${username} ${timeClass} chunk ${chunkId}`,
  );
  return { result, payload };
}

async function readChunk(env, username, timeClass, chunkId) {
  const payload = await readGzipJsonFile(env, chunkPath(username, timeClass, chunkId));
  if (!payload) return null;
  if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload?.records)) {
    throw new Error(`Chunk ${chunkId} uses an unsupported schema.`);
  }
  return payload;
}

async function migrateLegacyProfile(env, username, timeClass, legacy) {
  const records = (legacy?.records || [])
    .map((record) => normalizedRecord(record, legacy?.analyzer))
    .filter((record) => record.gameId)
    .sort((a, b) => a.endTime - b.endTime || a.gameId.localeCompare(b.gameId));

  const manifest = makeEmptyManifest(username, timeClass);
  manifest.analyzer = legacy?.analyzer || null;

  for (let offset = 0, chunkNumber = 1; offset < records.length; offset += CHUNK_SIZE, chunkNumber++) {
    const chunkId = String(chunkNumber).padStart(6, '0');
    const chunkRecords = records.slice(offset, offset + CHUNK_SIZE);
    await writeChunk(env, username, timeClass, chunkId, chunkRecords);
    manifest.chunks.push(summarizeChunk(chunkId, chunkRecords, username, timeClass));
    for (const record of chunkRecords) manifest.records[record.gameId] = recordMeta(record, chunkId);
  }

  rebuildDataset(manifest);
  await saveJsonFile(
    env,
    manifestPath(username, timeClass),
    manifest,
    `Migrate ${username} ${timeClass} analysis to chunked storage`,
  );
  return manifest;
}

async function ensureManifest(env, username, timeClass) {
  const current = await readJsonFile(env, manifestPath(username, timeClass));
  if (current) {
    if (current?.schemaVersion !== SCHEMA_VERSION || !current?.records || !Array.isArray(current?.chunks)) {
      throw new Error('Stored manifest uses an unsupported schema.');
    }
    return current;
  }

  // Backward-compatible one-time migration from the original whole-profile file.
  const legacy = await readGzipJsonFile(env, legacyPath(username, timeClass));
  if (!legacy) return makeEmptyManifest(username, timeClass);
  if (legacy?.schemaVersion !== LEGACY_SCHEMA_VERSION || !Array.isArray(legacy?.records)) {
    throw new Error('Legacy profile uses an unsupported schema.');
  }
  return migrateLegacyProfile(env, username, timeClass, legacy);
}

function validateServerConfig(env) {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO);
}

function parseProfileRequest(request) {
  const url = new URL(request.url);
  const username = normalizeUsername(url.searchParams.get('username'));
  const timeClass = normalizeTimeClass(url.searchParams.get('timeClass'));
  return { url, username, timeClass };
}

async function handleManifestDownload(request, env) {
  if (!validateServerConfig(env)) return json({ error: 'Remote archive is not configured on the server.' }, 503);
  const { username, timeClass } = parseProfileRequest(request);
  if (!username || !timeClass) return json({ error: 'Invalid profile username or time class.' }, 400);

  try {
    const manifest = await ensureManifest(env, username, timeClass);
    const found = Number(manifest?.dataset?.gameCount || 0) > 0;
    return json({ ok: true, found, ...manifest });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not read the shared profile manifest.' }, 502);
  }
}

async function handleChunkDownload(request, env) {
  if (!validateServerConfig(env)) return json({ error: 'Remote archive is not configured on the server.' }, 503);
  const { url, username, timeClass } = parseProfileRequest(request);
  const chunkId = normalizeChunkId(url.searchParams.get('chunk'));
  if (!username || !timeClass || !chunkId) return json({ error: 'Invalid profile, time class, or chunk.' }, 400);

  try {
    const chunk = await readChunk(env, username, timeClass, chunkId);
    if (!chunk) return json({ error: 'Shared analysis chunk not found.' }, 404);
    return json({ ok: true, ...chunk });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not read the shared analysis chunk.' }, 502);
  }
}


async function handleRawManifestStorage(request, env) {
  if (!validateServerConfig(env)) return json({ error: 'Remote archive is not configured on the server.' }, 503);
  const { username, timeClass } = parseProfileRequest(request);
  if (!username || !timeClass) return json({ error: 'Invalid profile username or time class.' }, 400);
  const repoPath = manifestPath(username, timeClass);

  if (request.method === 'GET') {
    try {
      const metadata = await existingFile(env, repoPath);
      if (!metadata) return json({ error: 'Shared profile manifest not found.' }, 404);
      const response = await githubRequest(env, repoApiPath(env, repoPath), {
        headers: { accept: 'application/vnd.github.raw+json' },
      });
      if (!response.ok) {
        const text = await response.text();
        return json({ error: `GitHub manifest read failed (${response.status}): ${text.slice(0, 240)}` }, 502);
      }
      const headers = new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      if (metadata?.sha) headers.set('x-github-sha', metadata.sha);
      return new Response(response.body, { status: 200, headers });
    } catch (error) {
      console.error(error);
      return json({ error: 'Could not stream the shared profile manifest.' }, 502);
    }
  }

  if (request.method === 'PUT') {
    try {
      // The browser already serialized/base64-encoded the file into the exact
      // GitHub Contents API request shape. Stream it through untouched so the
      // Worker spends effectively no CPU processing chess data.
      const response = await githubRequest(env, repoApiPath(env, repoPath, false), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: request.body,
      });
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (error) {
      console.error(error);
      return json({ error: 'Could not write the shared profile manifest.' }, 502);
    }
  }

  return json({ error: 'Method not allowed.' }, 405);
}

async function handleRawChunkStorage(request, env) {
  if (!validateServerConfig(env)) return json({ error: 'Remote archive is not configured on the server.' }, 503);
  const { url, username, timeClass } = parseProfileRequest(request);
  const chunkId = normalizeChunkId(url.searchParams.get('chunk'));
  if (!username || !timeClass || !chunkId) return json({ error: 'Invalid profile, time class, or chunk.' }, 400);
  const repoPath = chunkPath(username, timeClass, chunkId);

  if (request.method === 'GET') {
    try {
      const response = await githubRequest(env, repoApiPath(env, repoPath), {
        headers: { accept: 'application/vnd.github.raw+json' },
      });
      if (response.status === 404) return json({ error: 'Shared analysis chunk not found.' }, 404);
      if (!response.ok) {
        const text = await response.text();
        return json({ error: `GitHub chunk read failed (${response.status}): ${text.slice(0, 240)}` }, 502);
      }
      return new Response(response.body, {
        status: 200,
        headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' },
      });
    } catch (error) {
      console.error(error);
      return json({ error: 'Could not stream the shared analysis chunk.' }, 502);
    }
  }

  if (request.method === 'PUT') {
    try {
      const response = await githubRequest(env, repoApiPath(env, repoPath, false), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: request.body,
      });
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (error) {
      console.error(error);
      return json({ error: 'Could not write the shared analysis chunk.' }, 502);
    }
  }

  return json({ error: 'Method not allowed.' }, 405);
}

async function handleBatchUpload(request, env) {
  if (!validateServerConfig(env)) return json({ error: 'Remote archive is not configured on the server.' }, 503);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 50 * 1024 * 1024) return json({ error: 'Analysis batch is larger than the 50 MB limit.' }, 413);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const username = normalizeUsername(payload?.profile?.username);
  const timeClass = normalizeTimeClass(payload?.profile?.timeClass);
  if (!username || !timeClass) return json({ error: 'Invalid profile username or time class.' }, 400);
  if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload?.records)) {
    return json({ error: 'Unsupported analysis batch.' }, 400);
  }
  if (payload.records.length < 1 || payload.records.length > CHUNK_SIZE) {
    return json({ error: `Analysis batches must contain between 1 and ${CHUNK_SIZE} games.` }, 413);
  }

  try {
    const manifest = await ensureManifest(env, username, timeClass);
    const incoming = payload.records
      .map((record) => normalizedRecord(record, payload?.analyzer))
      .filter((record) => record.gameId);

    const accepted = incoming.filter((record) => shouldPrefer(record, manifest.records?.[record.gameId]));
    if (!accepted.length) {
      return json({ ok: true, acceptedCount: 0, receivedCount: incoming.length, recordCount: manifest.dataset.gameCount, commit: null });
    }

    const chunkCache = new Map();
    const changedChunks = new Set();

    async function getChunkRecords(chunkId) {
      if (chunkCache.has(chunkId)) return chunkCache.get(chunkId);
      const existing = await readChunk(env, username, timeClass, chunkId);
      const records = existing?.records ? [...existing.records] : [];
      chunkCache.set(chunkId, records);
      return records;
    }

    function nextChunkId() {
      const max = manifest.chunks.reduce((m, chunk) => Math.max(m, Number(chunk.id || 0)), 0);
      return String(max + 1).padStart(6, '0');
    }

    let appendChunkId = manifest.chunks.length ? manifest.chunks[manifest.chunks.length - 1].id : null;

    for (const record of accepted) {
      const oldMeta = manifest.records?.[record.gameId];
      if (oldMeta?.chunk) {
        const records = await getChunkRecords(oldMeta.chunk);
        const index = records.findIndex((item) => String(item.gameId) === record.gameId);
        if (index >= 0) records[index] = record;
        else records.push(record);
        changedChunks.add(oldMeta.chunk);
        continue;
      }

      if (!appendChunkId) appendChunkId = nextChunkId();
      let records = await getChunkRecords(appendChunkId);
      if (records.length >= CHUNK_SIZE) {
        // Reflect a newly-created chunk in manifest.chunks immediately so the
        // next generated ID cannot collide within this same batch.
        if (!manifest.chunks.some((chunk) => chunk.id === appendChunkId)) {
          manifest.chunks.push({ id: appendChunkId, count: records.length });
        }
        appendChunkId = nextChunkId();
        records = await getChunkRecords(appendChunkId);
      }
      records.push(record);
      changedChunks.add(appendChunkId);
    }

    let lastCommit = null;
    for (const chunkId of [...changedChunks].sort()) {
      const records = await getChunkRecords(chunkId);
      const { result } = await writeChunk(env, username, timeClass, chunkId, records);
      lastCommit = result?.commit?.sha || lastCommit;

      // Replace the manifest metadata for this chunk from its actual contents.
      for (const [gameId, meta] of Object.entries(manifest.records || {})) {
        if (meta?.chunk === chunkId) delete manifest.records[gameId];
      }
      for (const record of records) manifest.records[record.gameId] = recordMeta(record, chunkId);
      const summary = summarizeChunk(chunkId, records, username, timeClass);
      const summaryIndex = manifest.chunks.findIndex((chunk) => chunk.id === chunkId);
      if (summaryIndex >= 0) manifest.chunks[summaryIndex] = summary;
      else manifest.chunks.push(summary);
    }

    manifest.chunks.sort((a, b) => Number(a.id) - Number(b.id));
    manifest.analyzer = payload?.analyzer || manifest.analyzer || null;
    rebuildDataset(manifest);
    const manifestSave = await saveJsonFile(
      env,
      manifestPath(username, timeClass),
      manifest,
      `Update ${username} ${timeClass} analysis manifest`,
    );
    lastCommit = manifestSave?.commit?.sha || lastCommit;

    return json({
      ok: true,
      acceptedCount: accepted.length,
      receivedCount: incoming.length,
      recordCount: manifest.dataset.gameCount,
      chunkCount: manifest.chunks.length,
      commit: lastCommit,
    });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not archive the analysis batch to GitHub.' }, 502);
  }
}

// Compatibility endpoint for old clients. It reconstructs a whole-profile
// response from chunks. New clients use manifest + selective chunk downloads.
async function handleLegacyCompatibleDownload(request, env) {
  if (!validateServerConfig(env)) return json({ error: 'Remote archive is not configured on the server.' }, 503);
  const { username, timeClass } = parseProfileRequest(request);
  if (!username || !timeClass) return json({ error: 'Invalid profile username or time class.' }, 400);

  try {
    const manifest = await ensureManifest(env, username, timeClass);
    if (!manifest.dataset.gameCount) return json({ ok: true, found: false, records: [] });
    const records = [];
    for (const chunk of manifest.chunks) {
      const payload = await readChunk(env, username, timeClass, chunk.id);
      records.push(...(payload?.records || []));
    }
    records.sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0) || String(a.gameId).localeCompare(String(b.gameId)));
    return json({ ok: true, found: true, schemaVersion: SCHEMA_VERSION, analyzer: manifest.analyzer, profile: manifest.profile, dataset: manifest.dataset, records });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not read the shared profile archive.' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/profile-analysis/storage/manifest') {
      return handleRawManifestStorage(request, env);
    }
    if (url.pathname === '/api/profile-analysis/storage/chunk') {
      return handleRawChunkStorage(request, env);
    }
    if (url.pathname === '/api/profile-analysis/manifest') {
      if (request.method === 'GET') return handleManifestDownload(request, env);
      return json({ error: 'Method not allowed.' }, 405);
    }
    if (url.pathname === '/api/profile-analysis/chunk') {
      if (request.method === 'GET') return handleChunkDownload(request, env);
      return json({ error: 'Method not allowed.' }, 405);
    }
    if (url.pathname === '/api/profile-analysis/batch') {
      if (request.method === 'POST') {
        return json({ error: 'This uploader is outdated. Refresh the dashboard before archiving.' }, 426);
      }
      return json({ error: 'Method not allowed.' }, 405);
    }
    if (url.pathname === '/api/profile-analysis') {
      if (request.method === 'GET') return handleLegacyCompatibleDownload(request, env);
      return json({ error: 'This client is outdated. Refresh the dashboard before uploading.' }, 426);
    }

    return env.ASSETS.fetch(request);
  },
};
