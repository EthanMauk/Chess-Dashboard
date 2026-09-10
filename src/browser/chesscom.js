const API = 'https://api.chess.com/pub/player';

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 404) throw new Error('Chess.com player or archive not found.');
    if (response.status === 429) throw new Error('Chess.com rate limit reached. Try again shortly.');
    throw new Error(`Chess.com request failed (${response.status}).`);
  }
  return response.json();
}

export function gameId(game) {
  if (game.uuid) return game.uuid;
  if (game.url) return game.url;
  return `${game.end_time || 0}:${game.pgn?.slice(0, 80) || ''}`;
}

export async function findMissingGames(username, timeClass, knownIds, onArchive, signal) {
  const player = encodeURIComponent(username.toLowerCase());
  const archiveData = await getJson(`${API}/${player}/games/archives`);
  const archives = Array.isArray(archiveData.archives) ? archiveData.archives : [];
  const missing = [];
  let checkedGames = 0;

  for (const archiveUrl of [...archives].reverse()) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const data = await getJson(archiveUrl);
    const eligible = (data.games || []).filter(
      (g) =>
        g.rated === true &&
        String(g.time_class || '').toLowerCase() === timeClass &&
        String(g.rules || 'chess').toLowerCase() === 'chess'
    );
    const monthMissing = eligible.filter((g) => !knownIds.has(gameId(g)));
    checkedGames += eligible.length;
    const parts = archiveUrl.split('/');
    const label = `${parts.at(-2)}-${parts.at(-1)}`;
    onArchive?.({ month: label, games: eligible.length, missing: monthMissing.length });
    missing.push(...monthMissing);

    if (monthMissing.length) continue;
    if (!eligible.length) continue;
    break;
  }

  missing.sort((a, b) => Number(a.end_time || 0) - Number(b.end_time || 0));
  return { missing, checkedGames };
}
