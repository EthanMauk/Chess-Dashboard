import { Chess } from 'chess.js';
import { analysisKey, saveAnalysis, getKnownGameIds, clearAnalysis, loadDashboardRows } from './db';
import { findMissingGames, gameId } from './chesscom';
import { StockfishClient } from './stockfish';
import { hydrateProfileFromRemote } from './remotePersistence';
import { classifyHistoryPhases, summarizePhaseMoves } from './phases';
import { classifyMove, CATEGORIZATION_VERSION } from './categorization';

function cpValue(result) {
  if (!result) return 0;
  // Keep mates outside the ordinary centipawn range while still preferring
  // shorter winning mates and longer losing mates.
  if (result.mate != null) {
    const distance = Math.min(999, Math.abs(Number(result.mate) || 0));
    return result.mate > 0 ? 100000 - distance * 100 : -100000 + distance * 100;
  }
  return Number(result.cp || 0);
}

function moveUci(move) {
  return `${move?.from || ''}${move?.to || ''}${move?.promotion || ''}`.toLowerCase();
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
  return engine.evaluate(fen, nodes, 2);
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

  const phaseRows = classifyHistoryPhases(history);
  const losses = { White: [], Black: [] };
  const counters = {
    White: { practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0, miss: 0, great: 0, best: 0, good: 0, blunder: 0, mistake: 0, inaccuracy: 0 },
    Black: { practical_blunder: 0, conversion_error: 0, missed_opportunity: 0, missed_mate: 0, miss: 0, great: 0, best: 0, good: 0, blunder: 0, mistake: 0, inaccuracy: 0 },
  };
  const moveRows = [];
  let previousMoveQuality = '';

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

    const bestLine = before.lines?.[0] || before;
    const secondLine = before.lines?.[1] || null;
    const secondBestCp = secondLine ? cpValue(secondLine) : null;
    const playedUci = moveUci(move);
    const c = classifyMove({
      beforeCp,
      playedCp,
      rawLoss,
      bestMate,
      playedMate,
      playedUci,
      bestUci: bestLine?.pvMove || null,
      secondBestCp,
      secondBestMate: Boolean(secondLine?.mate != null && secondLine.mate > 0),
      previousOpponentQuality: previousMoveQuality,
    });
    losses[mover].push(rawLoss);
    for (const key of ['practical_blunder', 'conversion_error', 'missed_opportunity', 'missed_mate']) counters[mover][key] += c[key];
    // Primary grading buckets are mutually exclusive. A Miss is counted as a
    // Miss, not again as the underlying mistake/blunder severity.
    counters[mover][c.category] = (counters[mover][c.category] || 0) + 1;
    previousMoveQuality = c.quality_category || c.category || '';

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
      adjusted_loss_cp: c.adjusted_loss_cp ?? '',
      best_move_gap_cp: c.best_move_gap_cp ?? '',
      best_move_uci: bestLine?.pvMove || '',
      second_best_move_uci: secondLine?.pvMove || '',
      second_best_after_cp: secondBestCp ?? '',
      before_is_mate: beforeMate ? 1 : 0,
      before_mate_in: before.mate ?? 0,
      best_after_is_mate: bestMate ? 1 : 0,
      best_mate_in: bestMate ? before.mate : 0,
      played_after_is_mate: playedMate ? 1 : 0,
      played_mate_in: playedMateValue ?? 0,
      category: c.category,
      quality_category: c.quality_category,
      category_reason: c.category_reason,
      is_best_move: c.is_best_move,
      great_move: c.great_move,
      practical_blunder: c.practical_blunder,
      conversion_error: c.conversion_error,
      conversion_error_type: c.conversion_error_type,
      missed_opportunity: c.missed_opportunity,
      missed_opportunity_type: c.missed_opportunity_type,
      missed_opportunity_value_cp: c.missed_opportunity_value_cp,
      missed_mate: c.missed_mate,
      phase: phaseRows[index]?.phase || 'middlegame',
      bishops_remaining: phaseRows[index]?.bishops_remaining ?? '',
      knights_remaining: phaseRows[index]?.knights_remaining ?? '',
      minor_pieces_remaining: phaseRows[index]?.minor_pieces_remaining ?? '',
      heavy_pieces_remaining: phaseRows[index]?.heavy_pieces_remaining ?? '',
      non_pawn_pieces_remaining: phaseRows[index]?.non_pawn_pieces_remaining ?? '',
      pawns_remaining: phaseRows[index]?.pawns_remaining ?? '',
      developed_or_gone_minors: phaseRows[index]?.developed_or_gone_minors ?? '',
      white_developed_or_gone_minors: phaseRows[index]?.white_developed_or_gone_minors ?? '',
      black_developed_or_gone_minors: phaseRows[index]?.black_developed_or_gone_minors ?? '',
      castling_resolved_sides: phaseRows[index]?.castling_resolved_sides ?? '',
      central_pawns_resolved: phaseRows[index]?.central_pawns_resolved ?? '',
      phase_classifier_version: phaseRows[index]?.phase_classifier_version || 'phase-v3',
      categorization_version: c.categorization_version || CATEGORIZATION_VERSION,
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
      misses: c.miss,
      great_moves: c.great,
      best_moves: c.best,
      good_moves: c.good,
      mistakes: c.mistake,
      inaccuracies: c.inaccuracy,
      moves: vals.length,
    };
  }

  const ws = stats('White');
  const bs = stats('Black');
  const ps = playerIsWhite ? ws : bs;
  const os = playerIsWhite ? bs : ws;

  const phaseStats = summarizePhaseMoves(moveRows, playerColor);

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
    player_misses: ps.misses,
    opponent_misses: os.misses,
    player_great_moves: ps.great_moves,
    opponent_great_moves: os.great_moves,
    player_best_moves: ps.best_moves,
    opponent_best_moves: os.best_moves,
    player_good_moves: ps.good_moves,
    opponent_good_moves: os.good_moves,
    player_mistakes: ps.mistakes,
    opponent_mistakes: os.mistakes,
    player_inaccuracies: ps.inaccuracies,
    opponent_inaccuracies: os.inaccuracies,
    player_moves: ps.moves,
    opponent_moves: os.moves,
    total_plies: history.length,
    full_moves: Math.ceil(history.length / 2),
    ...phaseStats,
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
      // Do not silently continue into a historical re-analysis when the shared
      // cache exists but could not be restored. Cross-device sync must either
      // hydrate cleanly or stop with a visible error.
      throw new Error(`Could not restore the shared analysis cache: ${error?.message || 'unknown error'}`);
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
        analyzerVersion: 'browser-v7-unique-opportunity-misses',
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
