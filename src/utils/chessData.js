import Papa from "papaparse";

export function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: (result) => {
        if (result.errors?.length) {
          reject(new Error(result.errors[0].message));
          return;
        }
        resolve(result.data);
      },
      error: reject,
    });
  });
}

export function isGamesRows(rows) {
  return Array.isArray(rows) && rows.length > 0 && (
    "player_acpl" in rows[0] ||
    "player_rating" in rows[0] ||
    "opponent_acpl" in rows[0]
  );
}

export function isMovesRows(rows) {
  return Array.isArray(rows) && rows.length > 0 &&
    "ply" in rows[0] &&
    "san" in rows[0] &&
    "category" in rows[0];
}

export function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function nullableNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return String(v ?? "").trim().toLowerCase() === "true" ||
         String(v ?? "").trim() === "1";
}

export function playerResult(result, playerColor) {
  const r = String(result ?? "").trim();
  const c = String(playerColor ?? "").toLowerCase();

  if (r === "1/2-1/2") return "draw";
  if ((r === "1-0" && c === "white") || (r === "0-1" && c === "black")) {
    return "win";
  }
  if ((r === "1-0" && c === "black") || (r === "0-1" && c === "white")) {
    return "loss";
  }
  return "unknown";
}

export function normalizeGames(rows) {
  return rows
    .filter((r) => r && r.date != null && r.game_number != null)
    .map((r) => ({
      gameNumber: num(r.game_number),
      date: String(r.date),
      white: String(r.white ?? ""),
      black: String(r.black ?? ""),
      resultRaw: String(r.result ?? ""),
      playerColor: String(r.player_color ?? ""),
      result: playerResult(r.result, r.player_color),
      playerRating: num(r.player_rating),
      opponentRating: num(r.opponent_rating),
      playerAcpl: num(r.player_acpl),
      opponentAcpl: num(r.opponent_acpl),
      playerRawBlunders: num(r.player_raw_blunders),
      opponentRawBlunders: num(r.opponent_raw_blunders),
      playerPracticalBlunders: num(r.player_practical_blunders),
      opponentPracticalBlunders: num(r.opponent_practical_blunders),
      playerConversionErrors: num(r.player_conversion_errors),
      opponentConversionErrors: num(r.opponent_conversion_errors),
      playerMissedOpportunities: num(r.player_missed_opportunities),
      opponentMissedOpportunities: num(r.opponent_missed_opportunities),
      playerMissedMates: num(r.player_missed_mates),
      opponentMissedMates: num(r.opponent_missed_mates),
      playerMisses: num(r.player_misses ?? r.player_missed_opportunities),
      opponentMisses: num(r.opponent_misses ?? r.opponent_missed_opportunities),
      playerGreatMoves: num(r.player_great_moves),
      opponentGreatMoves: num(r.opponent_great_moves),
      playerBestMoves: num(r.player_best_moves),
      opponentBestMoves: num(r.opponent_best_moves),
      playerGoodMoves: num(r.player_good_moves),
      opponentGoodMoves: num(r.opponent_good_moves),
      playerMistakes: num(r.player_mistakes),
      opponentMistakes: num(r.opponent_mistakes),
      playerInaccuracies: num(r.player_inaccuracies),
      opponentInaccuracies: num(r.opponent_inaccuracies),
      playerOpeningAcpl: nullableNum(r.player_opening_acpl),
      opponentOpeningAcpl: nullableNum(r.opponent_opening_acpl),
      playerMiddlegameAcpl: nullableNum(r.player_middlegame_acpl),
      opponentMiddlegameAcpl: nullableNum(r.opponent_middlegame_acpl),
      playerEndgameAcpl: nullableNum(r.player_endgame_acpl),
      opponentEndgameAcpl: nullableNum(r.opponent_endgame_acpl),
      playerOpeningBlunders: num(r.player_opening_blunders),
      opponentOpeningBlunders: num(r.opponent_opening_blunders),
      playerMiddlegameBlunders: num(r.player_middlegame_blunders),
      opponentMiddlegameBlunders: num(r.opponent_middlegame_blunders),
      playerEndgameBlunders: num(r.player_endgame_blunders),
      opponentEndgameBlunders: num(r.opponent_endgame_blunders),
      playerOpeningMoves: num(r.player_opening_moves),
      opponentOpeningMoves: num(r.opponent_opening_moves),
      playerMiddlegameMoves: num(r.player_middlegame_moves),
      opponentMiddlegameMoves: num(r.opponent_middlegame_moves),
      playerEndgameMoves: num(r.player_endgame_moves),
      opponentEndgameMoves: num(r.opponent_endgame_moves),
      playerMoves: num(r.player_moves),
      opponentMoves: num(r.opponent_moves),
      totalPlies: num(r.total_plies),
      fullMoves: num(r.full_moves),
      initialClockSeconds: r.initial_clock_seconds == null || r.initial_clock_seconds === '' ? null : num(r.initial_clock_seconds),
    }))
    .sort((a, b) => a.gameNumber - b.gameNumber);
}

export function normalizeMoves(rows) {
  return rows
    .filter((r) => r && r.game_number != null && r.ply != null)
    .map((r) => ({
      gameNumber: num(r.game_number),
      date: String(r.date ?? ""),
      white: String(r.white ?? ""),
      black: String(r.black ?? ""),
      result: String(r.result ?? ""),
      ply: num(r.ply),
      fullMove: num(r.full_move),
      color: String(r.color ?? ""),
      san: String(r.san ?? ""),
      clockSeconds: r.clock_seconds == null || r.clock_seconds === '' ? null : num(r.clock_seconds),
      phase: String(r.phase ?? '').toLowerCase(),
      bishopsRemaining: nullableNum(r.bishops_remaining),
      knightsRemaining: nullableNum(r.knights_remaining),
      minorPiecesRemaining: nullableNum(r.minor_pieces_remaining),
      heavyPiecesRemaining: nullableNum(r.heavy_pieces_remaining),
      nonPawnPiecesRemaining: nullableNum(r.non_pawn_pieces_remaining),
      pawnsRemaining: nullableNum(r.pawns_remaining),
      developedOrGoneMinors: nullableNum(r.developed_or_gone_minors),
      castlingResolvedSides: nullableNum(r.castling_resolved_sides),
      isTargetPlayer: bool(r.is_target_player),
      evalBeforeCp: num(r.eval_before_cp),
      bestAfterCp: num(r.best_after_cp),
      playedAfterCp: num(r.played_after_cp),
      rawLossCp: num(r.raw_loss_cp),
      adjustedLossCp: r.adjusted_loss_cp == null || r.adjusted_loss_cp === '' ? null : num(r.adjusted_loss_cp),
      bestMoveGapCp: r.best_move_gap_cp == null || r.best_move_gap_cp === '' ? null : num(r.best_move_gap_cp),
      bestMoveUci: String(r.best_move_uci ?? ''),
      secondBestMoveUci: String(r.second_best_move_uci ?? ''),
      secondBestAfterCp: r.second_best_after_cp == null || r.second_best_after_cp === '' ? null : num(r.second_best_after_cp),
      beforeIsMate: bool(r.before_is_mate),
      beforeMateIn: r.before_mate_in,
      bestAfterIsMate: bool(r.best_after_is_mate),
      bestMateIn: r.best_mate_in,
      playedAfterIsMate: bool(r.played_after_is_mate),
      playedMateIn: r.played_mate_in,
      category: String(r.category ?? "good").toLowerCase(),
      qualityCategory: String(r.quality_category ?? r.category ?? "good").toLowerCase(),
      categoryReason: String(r.category_reason ?? ''),
      isBestMove: bool(r.is_best_move),
      greatMove: bool(r.great_move),
      practicalBlunder: bool(r.practical_blunder),
      conversionError: bool(r.conversion_error),
      conversionErrorType: String(r.conversion_error_type ?? ''),
      missedOpportunity: bool(r.missed_opportunity),
      missedOpportunityType: String(r.missed_opportunity_type ?? ''),
      missedOpportunityValueCp: r.missed_opportunity_value_cp == null || r.missed_opportunity_value_cp === '' ? null : num(r.missed_opportunity_value_cp),
      missedMate: bool(r.missed_mate),
    }))
    .sort((a, b) => a.gameNumber - b.gameNumber || a.ply - b.ply);
}

export function formatDate(date) {
  if (!date) return "";
  const d = new Date(date.replaceAll(".", "-"));
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString();
}

export function resultClass(result) {
  return result === "win"
    ? "win"
    : result === "loss"
      ? "loss"
      : result === "draw"
        ? "draw"
        : "";
}
