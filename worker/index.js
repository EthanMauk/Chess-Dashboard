const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const MAX_RECORDS = 10000;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(username)) return null;
  return username;
}

function normalizeTimeClass(value) {
  return value === 'rapid' || value === 'blitz' ? value : null;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
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

async function readProfile(env, repoPath) {
  const response = await githubRequest(env, repoApiPath(env, repoPath), {
    headers: { accept: 'application/vnd.github.raw+json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = await gunzipText(bytes);
  return JSON.parse(text);
}

function recordQuality(record) {
  return {
    version: String(record?.analyzerVersion || ''),
    nodes: Number(record?.nodes || 0),
    analyzedAt: Number(record?.analyzedAt || 0),
  };
}

function shouldReplaceRecord(previous, incoming) {
  if (!previous) return true;
  const a = recordQuality(previous);
  const b = recordQuality(incoming);

  // A different analyzer version is a deliberate methodology change. Prefer the
  // newer analysis in that case; otherwise preserve the higher-node result.
  if (a.version !== b.version) return b.analyzedAt >= a.analyzedAt;
  if (b.nodes !== a.nodes) return b.nodes > a.nodes;
  return b.analyzedAt >= a.analyzedAt;
}

function normalizeIncomingRecord(record, payloadAnalyzer) {
  return {
    ...record,
    analyzerVersion: record?.analyzerVersion || payloadAnalyzer?.version || 'unknown',
    engine: record?.engine || payloadAnalyzer?.engine || 'unknown',
    nodes: Number(record?.nodes || payloadAnalyzer?.requestedNodes || 0),
    analyzedAt: Number(record?.analyzedAt || Date.now()),
  };
}

function mergeProfilePayload(existing, incoming, username, timeClass) {
  const byGame = new Map();

  for (const rawRecord of existing?.records || []) {
    if (!rawRecord?.gameId) continue;
    const record = normalizeIncomingRecord(rawRecord, existing?.analyzer);
    byGame.set(String(record.gameId), record);
  }

  for (const rawRecord of incoming?.records || []) {
    if (!rawRecord?.gameId) continue;
    const record = normalizeIncomingRecord(rawRecord, incoming?.analyzer);
    const id = String(record.gameId);
    const previous = byGame.get(id);
    if (shouldReplaceRecord(previous, record)) byGame.set(id, record);
  }

  const records = [...byGame.values()].sort(
    (a, b) => Number(a.endTime || 0) - Number(b.endTime || 0) || String(a.gameId).localeCompare(String(b.gameId)),
  );

  const latestAnalyzedAt = records.reduce(
    (latest, record) => Math.max(latest, Number(record.analyzedAt || 0)),
    0,
  );

  return {
    schemaVersion: 2,
    analyzer: incoming?.analyzer || existing?.analyzer || null,
    profile: { username, timeClass },
    dataset: {
      gameCount: records.length,
      moveCount: records.reduce((sum, record) => sum + (record.moveRows?.length || 0), 0),
      latestAnalyzedAt,
    },
    records,
    archivedAt: new Date().toISOString(),
  };
}

async function saveProfile(env, repoPath, payloadText, username, timeClass) {
  // The GitHub Contents API requires the current blob SHA to update a file.
  // A concurrent writer can still produce a 409; the client keeps its local
  // results and can retry on the next Sync, so no analysis is lost.
  const existing = await existingFile(env, repoPath);
  const owner = encodeURIComponent(env.GITHUB_OWNER);
  const repo = encodeURIComponent(env.GITHUB_REPO);
  const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
  const branch = env.GITHUB_BRANCH || 'main';
  const bytes = await gzipText(payloadText);

  const body = {
    message: `${existing ? 'Update' : 'Add'} ${username} ${timeClass} analysis`,
    content: bytesToBase64(bytes),
    branch,
  };
  if (existing?.sha) body.sha = existing.sha;

  const response = await githubRequest(env, `/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub save failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return response.json();
}

function validateServerConfig(env) {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO);
}

function profilePath(username, timeClass) {
  return `profiles/${username}/${timeClass}.json.gz`;
}

async function handleProfileDownload(request, env) {
  if (!validateServerConfig(env)) {
    return json({ error: 'Remote archive is not configured on the server.' }, 503);
  }

  const url = new URL(request.url);
  const username = normalizeUsername(url.searchParams.get('username'));
  const timeClass = normalizeTimeClass(url.searchParams.get('timeClass'));
  if (!username || !timeClass) {
    return json({ error: 'Invalid profile username or time class.' }, 400);
  }

  try {
    const snapshot = await readProfile(env, profilePath(username, timeClass));
    if (!snapshot) {
      return json({ ok: true, found: false, profile: { username, timeClass }, records: [] });
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.has(Number(snapshot?.schemaVersion)) || !Array.isArray(snapshot?.records)) {
      return json({ error: 'Stored profile uses an unsupported schema.' }, 502);
    }
    return json({
      ok: true,
      found: true,
      schemaVersion: snapshot.schemaVersion,
      analyzer: snapshot.analyzer || null,
      profile: { username, timeClass },
      dataset: snapshot.dataset || null,
      records: snapshot.records,
    });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not read the shared profile archive.' }, 502);
  }
}

async function handleProfileUpload(request, env) {
  if (!validateServerConfig(env)) {
    return json({ error: 'Remote archive is not configured on the server.' }, 503);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return json({ error: 'Profile snapshot is larger than the 50 MB archive limit.' }, 413);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const username = normalizeUsername(payload?.profile?.username);
  const timeClass = normalizeTimeClass(payload?.profile?.timeClass);
  if (!username || !timeClass) {
    return json({ error: 'Invalid profile username or time class.' }, 400);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(Number(payload?.schemaVersion)) || !Array.isArray(payload?.records)) {
    return json({ error: 'Unsupported analysis payload.' }, 400);
  }
  if (payload.records.length > MAX_RECORDS) {
    return json({ error: 'Profile contains too many game records.' }, 413);
  }

  // Basic shape validation keeps malformed public submissions out of the corpus.
  for (const record of payload.records) {
    if (!record || !String(record.gameId || '').trim() || !record.gameRow || !Array.isArray(record.moveRows)) {
      return json({ error: 'One or more game records are malformed.' }, 400);
    }
  }

  const repoPath = profilePath(username, timeClass);

  try {
    const existing = await readProfile(env, repoPath);
    const mergedPayload = mergeProfilePayload(existing, payload, username, timeClass);
    const result = await saveProfile(env, repoPath, JSON.stringify(mergedPayload), username, timeClass);
    return json({
      ok: true,
      path: repoPath,
      recordCount: mergedPayload.records.length,
      receivedCount: payload.records.length,
      commit: result?.commit?.sha || null,
    });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not archive the profile to GitHub.' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/profile-analysis') {
      if (request.method === 'GET') return handleProfileDownload(request, env);
      if (request.method === 'POST') return handleProfileUpload(request, env);
      return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    }

    return env.ASSETS.fetch(request);
  },
};
