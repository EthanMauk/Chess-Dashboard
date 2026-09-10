import { Chess } from 'chess.js';
import { analysisKey, saveAnalysis, getKnownGameIds, clearAnalysis, loadDashboardRows } from './db';
import { findMissingGames, gameId } from './chesscom';
import { StockfishClient } from './stockfish';
import { hydrateProfileFromRemote } from './remotePersistence';

function cpValue(result) {
  if (result.mate != null) return result.mate > 0 ? 100000 : -100000;
  return Number(result.cp || 0);
}

function classifyMove({ beforeCp, playedCp, rawLoss, bestMate, playedMate }) {
  if (bestMate && !playedMate) {
    if (playedCp >= 300) {
      return { category: 'missed_mate', practical_blunder: 0, conversion_error: 0, missed_opportunity: 1, missed_mate: 1 };
    }
    return { category: 'blunder', practical_blunder: 1, conversion_error: 0, missed_opportunity: 0, missed_mate: 1 };
  }
  if (playedMate) {
    return { category: 'ok', practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0 };
  }
  if (rawLoss == null) {
    return { category: 'ok', practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0 };
  }

  const factor = 0.30 + 0.70 * Math.max(0, 1 - Math.abs(beforeCp) / 1000);
  const adjusted = rawLoss * factor;
  if (adjusted >= 300) return { category: 'blunder', practical_blunder: 1, conversion_error: 0, missed_opportunity: 0, missed_mate: 0 };
  if (adjusted >= 150) return { category: 'mistake', practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0 };
  if (adjusted >= 75) return { category: 'inaccuracy', practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0 };
  return { category: 'ok', practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0 };
}

function mean(values) {
  const valid = values.filter((x) => Number.isFinite(x));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

function dateFromGame(game, headers) {
  if (headers.Date) return headers.Date.replaceAll('.', '-');
  if (game.end_time) return new Date(game.end_time * 1000).toISOString().slice(0, 10);
  return '';
}

async function evaluateFen(engine, fen, nodes) {
  const board = new Chess(fen);
  if (board.isCheckmate()) return { cp: null, mate: -1, depth: 0 };
  if (board.isGameOver()) return { cp: 0, mate: null, depth: 0 };
  return engine.evaluate(fen, nodes);
}

export async function analyzeGamePayload(game, username, engine, nodes, onMove, signal) {
  const chess = new Chess();
  chess.loadPgn(game.pgn || '');
  const headers = chess.getHeaders();
  const history = chess.history({ verbose: true });
  if (!history.length) throw new Error('Game has no moves.');

  const whiteName = game.white?.username || headers.White || '';
  const blackName = game.black?.username || headers.Black || '';
  const playerIsWhite = whiteName.toLowerCase() === username.toLowerCase();
  const playerColor = playerIsWhite ? 'White' : 'Black';
  const result = headers.Result || '*';

  const fens = [history[0].before, ...history.map((m) => m.after)];
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    evals.push(await evaluateFen(engine, fens[i], nodes));
    onMove?.(i, fens.length - 1);
  }

  const losses = { White: [], Black: [] };
  const counters = {
    White: { practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0, blunder: 0, mistake: 0, inaccuracy: 0, ok: 0, missed_mate_category: 0 },
    Black: { practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0, blunder: 0, mistake: 0, inaccuracy: 0, ok: 0, missed_mate_category: 0 },
  };
  const moveRows = [];

  history.forEach((move, index) => {
    const mover = move.color === 'w' ? 'White' : 'Black';
    const before = evals[index];
    const afterSide = evals[index + 1];
    const beforeCp = cpValue(before);
    const playedCp = -cpValue(afterSide);
    const beforeMate = before.mate != null;
    const bestMate = before.mate != null && before.mate > 0;
    const playedMateValue = afterSide.mate == null ? null : -afterSide.mate;
    const playedMate = playedMateValue != null && playedMateValue > 0;
    const rawLoss = (beforeMate || afterSide.mate != null)
      ? null
      : Math.max(0, beforeCp - playedCp);

    const c = classifyMove({ beforeCp, playedCp, rawLoss, bestMate, playedMate });
    losses[mover].push(rawLoss);
    for (const key of ['practical_blunder', 'conversion_error', 'missed_opportunity', 'missed_mate']) counters[mover][key] += c[key];
    if (c.category === 'missed_mate') counters[mover].missed_mate_category += 1;
    else counters[mover][c.category] = (counters[mover][c.category] || 0) + 1;

    moveRows.push({
      game_number: 0,
      date: dateFromGame(game, headers),
      white: whiteName,
      black: blackName,
      result,
      ply: index + 1,
      full_move: Math.floor(index / 2) + 1,
      color: mover,
      san: move.san,
      is_target_player: mover === playerColor ? 1 : 0,
      eval_before_cp: beforeCp,
      best_after_cp: beforeCp,
      played_after_cp: playedCp,
      raw_loss_cp: rawLoss ?? '',
      before_is_mate: beforeMate ? 1 : 0,
      before_mate_in: before.mate ?? 0,
      best_after_is_mate: bestMate ? 1 : 0,
      best_mate_in: bestMate ? before.mate : 0,
      played_after_is_mate: playedMate ? 1 : 0,
      played_mate_in: playedMateValue ?? 0,
      category: c.category,
      practical_blunder: c.practical_blunder,
      conversion_error: c.conversion_error,
      missed_opportunity: c.missed_opportunity,
      missed_mate: c.missed_mate,
    });
  });

  function stats(color) {
    const vals = losses[color];
    const c = counters[color];
    return {
      acpl: mean(vals),
      raw_blunders: vals.filter((x) => Number.isFinite(x) && x >= 200).length,
      practical_blunders: c.practical_blunder,
      conversion_errors: c.conversion_error,
      missed_opportunities: c.missed_opportunity,
      missed_mates: c.missed_mate,
      mistakes: c.mistake,
      inaccuracies: c.inaccuracy,
      moves: vals.length,
    };
  }

  const ws = stats('White');
  const bs = stats('Black');
  const ps = playerIsWhite ? ws : bs;
  const os = playerIsWhite ? bs : ws;

  const gameRow = {
    game_number: 0,
    date: dateFromGame(game, headers),
    white: whiteName,
    black: blackName,
    result,
    player_color: playerColor,
    player_rating: Number(playerIsWhite ? game.white?.rating : game.black?.rating) || 0,
    opponent_rating: Number(playerIsWhite ? game.black?.rating : game.white?.rating) || 0,
    player_acpl: ps.acpl,
    opponent_acpl: os.acpl,
    player_raw_blunders: ps.raw_blunders,
    opponent_raw_blunders: os.raw_blunders,
    player_practical_blunders: ps.practical_blunders,
    opponent_practical_blunders: os.practical_blunders,
    player_conversion_errors: ps.conversion_errors,
    opponent_conversion_errors: os.conversion_errors,
    player_missed_opportunities: ps.missed_opportunities,
    opponent_missed_opportunities: os.missed_opportunities,
    player_missed_mates: ps.missed_mates,
    opponent_missed_mates: os.missed_mates,
    player_mistakes: ps.mistakes,
    opponent_mistakes: os.mistakes,
    player_inaccuracies: ps.inaccuracies,
    opponent_inaccuracies: os.inaccuracies,
    player_moves: ps.moves,
    opponent_moves: os.moves,
    total_plies: history.length,
    full_moves: Math.ceil(history.length / 2),
  };

  return { gameRow, moveRows };
}

export async function browserSync({ username, timeClass, nodes = 12000, fullRescan = false, onProgress, signal }) {
  username = username.trim().toLowerCase();
  if (!username) throw new Error('Username is required.');

  if (fullRescan) await clearAnalysis(username, timeClass);

  let sharedCache = { found: false, added: 0, available: 0 };
  if (!fullRescan) {
    onProgress?.({
      phase: 'shared-cache',
      message: 'Checking the shared analysis cache...',
      current: 0,
      total: 0,
      percent: 0,
    });
    try {
      sharedCache = await hydrateProfileFromRemote({
        username,
        timeClass,
        signal,
        onProgress,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.warn('Shared analysis cache was unavailable; continuing locally.', error);
      onProgress?.({
        phase: 'shared-cache',
        message: 'Shared cache unavailable; checking this browser instead...',
        current: 0,
        total: 0,
        percent: 0,
      });
    }
  }

  const known = await getKnownGameIds(username, timeClass);
  const archives = [];
  onProgress?.({
    phase: 'fetching',
    message: sharedCache.added
      ? `Loaded ${sharedCache.added.toLocaleString()} shared analyzed game(s). Checking Chess.com for newer games...`
      : `Checking rated ${timeClass} games...`,
    archives,
    current: 0,
    total: 0,
    percent: 0,
    sharedGames: sharedCache.added,
  });

  const scan = await findMissingGames(
    username,
    timeClass,
    known,
    (archive) => {
      archives.push(archive);
      onProgress?.({ phase: 'scanning', message: `Checked ${archive.month}`, archives: [...archives], current: 0, total: 0, percent: 0 });
    },
    signal,
  );

  const queue = scan.missing;
  onProgress?.({ phase: 'analyzing', message: `${queue.length} game(s) require analysis.`, archives: [...archives], missingGames: queue.length, current: 0, total: queue.length, percent: queue.length ? 0 : 100 });

  if (!queue.length) {
    const rows = await loadDashboardRows(username, timeClass);
    return { ...rows, syncMeta: { analyzedGames: 0, sharedGames: sharedCache.added } };
  }

  const engine = new StockfishClient();
  const started = performance.now();
  try {
    await engine.init();
    for (let i = 0; i < queue.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const game = queue[i];
      const gameStart = performance.now();
      let analyzed;
      try {
        analyzed = await analyzeGamePayload(
          game,
          username,
          engine,
          nodes,
          (ply, plies) => {
            const gameFraction = plies ? Math.min(1, ply / plies) : 0;
            const overall = ((i + gameFraction) / queue.length) * 100;
            onProgress?.({
              phase: 'analyzing',
              message: `Game ${i + 1}/${queue.length} · position ${Math.min(ply + 1, plies + 1)}/${plies + 1}`,
              archives: [...archives],
              missingGames: queue.length,
              current: i,
              total: queue.length,
              percent: overall,
              rate: i > 0 ? i / ((performance.now() - started) / 1000) : null,
            });
          },
          signal,
        );
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error?.message === 'Game has no moves.') {
          const current = i + 1;
          const elapsedSec = (performance.now() - started) / 1000;
          const rate = current / Math.max(elapsedSec, 0.001);
          const etaSeconds = (queue.length - current) / Math.max(rate, 0.001);
          onProgress?.({
            phase: 'analyzing',
            message: `Skipped empty game ${current}/${queue.length}`,
            archives: [...archives],
            missingGames: queue.length,
            current,
            total: queue.length,
            percent: (current / queue.length) * 100,
            rate,
            etaMinutes: etaSeconds / 60,
          });
          continue;
        }
        throw error;
      }

      const id = gameId(game);
      await saveAnalysis({
        key: analysisKey(username, timeClass, id),
        username,
        timeClass,
        gameId: id,
        endTime: Number(game.end_time || 0),
        pgn: game.pgn || '',
        gameRow: analyzed.gameRow,
        moveRows: analyzed.moveRows,
        nodes,
        analyzerVersion: 'browser-v1',
        engine: 'stockfish-18-lite-single',
        analyzedAt: Date.now(),
      });

      const elapsedSec = (performance.now() - started) / 1000;
      const current = i + 1;
      const rate = current / Math.max(elapsedSec, 0.001);
      const etaSeconds = (queue.length - current) / Math.max(rate, 0.001);
      onProgress?.({
        phase: 'analyzing',
        message: `Saved game ${current}/${queue.length} · ${(performance.now() - gameStart) / 1000 < 1 ? '<1' : ((performance.now() - gameStart) / 1000).toFixed(1)}s`,
        archives: [...archives],
        missingGames: queue.length,
        current,
        total: queue.length,
        percent: (current / queue.length) * 100,
        rate,
        etaMinutes: etaSeconds / 60,
      });
    }
  } finally {
    engine.terminate();
  }

  const rows = await loadDashboardRows(username, timeClass);
  return { ...rows, syncMeta: { analyzedGames: queue.length, sharedGames: sharedCache.added } };
}


export { loadDashboardRows, clearAnalysis } from './db';
