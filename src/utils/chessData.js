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
      playerMistakes: num(r.player_mistakes),
      opponentMistakes: num(r.opponent_mistakes),
      playerInaccuracies: num(r.player_inaccuracies),
      opponentInaccuracies: num(r.opponent_inaccuracies),
      playerMoves: num(r.player_moves),
      opponentMoves: num(r.opponent_moves),
      totalPlies: num(r.total_plies),
      fullMoves: num(r.full_moves),
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
      isTargetPlayer: bool(r.is_target_player),
      evalBeforeCp: num(r.eval_before_cp),
      bestAfterCp: num(r.best_after_cp),
      playedAfterCp: num(r.played_after_cp),
      rawLossCp: num(r.raw_loss_cp),
      beforeIsMate: bool(r.before_is_mate),
      beforeMateIn: r.before_mate_in,
      bestAfterIsMate: bool(r.best_after_is_mate),
      bestMateIn: r.best_mate_in,
      playedAfterIsMate: bool(r.played_after_is_mate),
      playedMateIn: r.played_mate_in,
      category: String(r.category ?? "ok").toLowerCase(),
      practicalBlunder: bool(r.practical_blunder),
      conversionError: bool(r.conversion_error),
      missedOpportunity: bool(r.missed_opportunity),
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
