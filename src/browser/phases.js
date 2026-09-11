import { Chess } from 'chess.js';

const PHASES = ['opening', 'middlegame', 'endgame'];
export const PHASE_CLASSIFIER_VERSION = 'phase-v3';
const ORIGINAL_MINORS = [
  ['b1', 'w', 'n'], ['g1', 'w', 'n'], ['c1', 'w', 'b'], ['f1', 'w', 'b'],
  ['b8', 'b', 'n'], ['g8', 'b', 'n'], ['c8', 'b', 'b'], ['f8', 'b', 'b'],
];

function boardCounts(chess) {
  const counts = {
    bishops: 0,
    knights: 0,
    rooks: 0,
    queens: 0,
    pawns: 0,
    nonPawnPieces: 0,
    minorPieces: 0,
    heavyPieces: 0,
  };

  for (const rank of chess.board()) {
    for (const piece of rank) {
      if (!piece) continue;
      if (piece.type === 'p') counts.pawns += 1;
      if (piece.type === 'b') counts.bishops += 1;
      if (piece.type === 'n') counts.knights += 1;
      if (piece.type === 'r') counts.rooks += 1;
      if (piece.type === 'q') counts.queens += 1;
      if (piece.type !== 'p' && piece.type !== 'k') counts.nonPawnPieces += 1;
    }
  }

  counts.minorPieces = counts.bishops + counts.knights;
  counts.heavyPieces = counts.rooks + counts.queens;
  return counts;
}

function castlingResolvedSides(chess) {
  const castling = chess.fen().split(' ')[2] || '-';
  let resolved = 0;
  if (!castling.includes('K') && !castling.includes('Q')) resolved += 1;
  if (!castling.includes('k') && !castling.includes('q')) resolved += 1;
  return resolved;
}

function originalMinorResolvedCount(chess, movedMinorStarts, onlyColor = null) {
  let count = 0;
  for (const [square, color, type] of ORIGINAL_MINORS) {
    if (onlyColor && color !== onlyColor) continue;
    const piece = chess.get(square);
    if (movedMinorStarts.has(square) || !piece || piece.color !== color || piece.type !== type) {
      count += 1;
    }
  }
  return count;
}

function centralPawnResolvedCount(chess) {
  const starts = [
    ['d2', 'w'], ['e2', 'w'], ['d7', 'b'], ['e7', 'b'],
  ];
  let count = 0;
  for (const [square, color] of starts) {
    const piece = chess.get(square);
    if (!piece || piece.color !== color || piece.type !== 'p') count += 1;
  }
  return count;
}

function endgameStarted(counts) {
  // User-defined hard rule: once every bishop and knight is gone, the game has
  // simplified enough to be an endgame even if queens and/or rooks remain.
  if (counts.minorPieces === 0) return true;

  // Also catch conventional simplified endings that still retain one or two
  // minor pieces (for example R+B vs R+N).
  if (counts.nonPawnPieces <= 4) return true;

  // Conservative extra simplification rule for low-pawn positions. This avoids
  // calling rich queen/rook middlegames endgames merely because pieces traded.
  if (counts.nonPawnPieces <= 6 && counts.minorPieces <= 2 && counts.pawns <= 8) {
    return true;
  }

  return false;
}

function exceptionalOpeningEnded(counts) {
  // The normal opening classifier has move-number floors so ordinary, efficient
  // development (especially London/Caro structures) does not get mislabeled as
  // middlegame on move 6 or 7. Those floors should not trap a genuinely
  // transformed position in the opening, though.
  //
  // Starting material, excluding kings/pawns:
  //   8 minor pieces + 4 rooks + 2 queens = 14 non-pawn pieces.
  // These rules therefore look for *actual material removal*, not merely pieces
  // leaving their home squares. That makes an early transition possible only
  // after unusually heavy exchanges.
  const nonPawnPiecesRemoved = Math.max(0, 14 - counts.nonPawnPieces);
  const minorPiecesRemoved = Math.max(0, 8 - counts.minorPieces);
  const pawnsRemoved = Math.max(0, 16 - counts.pawns);

  // Five non-pawn pieces gone is already a radically transformed position, even
  // if it happened before the normal move-9 floor.
  if (nonPawnPiecesRemoved >= 5) return true;

  // Four non-pawn pieces plus at least two pawns gone indicates broad
  // simplification rather than routine development.
  if (nonPawnPiecesRemoved >= 4 && pawnsRemoved >= 2) return true;

  // Half the original minor pieces exchanged, together with real pawn
  // simplification, is likewise enough to say the opening has broken down.
  if (minorPiecesRemoved >= 4 && pawnsRemoved >= 2) return true;

  // A queen trade alone does NOT end the opening. But if both queens are gone
  // and additional material has also disappeared, the position can reasonably
  // be treated as an early middlegame.
  if (counts.queens === 0 && nonPawnPiecesRemoved >= 4) return true;

  return false;
}

function openingEnded(chess, plyIndex, movedMinorStarts, counts) {
  const whiteDeveloped = originalMinorResolvedCount(chess, movedMinorStarts, 'w');
  const blackDeveloped = originalMinorResolvedCount(chess, movedMinorStarts, 'b');
  const developedOrGoneMinors = whiteDeveloped + blackDeveloped;
  const resolvedCastling = castlingResolvedSides(chess);
  const centralPawnsResolved = centralPawnResolvedCount(chess);
  const fullMove = Math.floor(plyIndex / 2) + 1;

  // Exceptional path: allow a genuinely chaotic/simplified game to leave the
  // opening before move 9. This path is based on captures/material removal, not
  // ordinary development, so a normal London cannot trigger it just by getting
  // its pieces out efficiently.
  if (exceptionalOpeningEnded(counts)) return true;

  // Normal path: a genuinely completed development cycle can end the opening
  // slightly earlier. Even this cannot trigger before move 9.
  if (
    fullMove >= 9 &&
    whiteDeveloped >= 4 &&
    blackDeveloped >= 4 &&
    resolvedCastling >= 2 &&
    centralPawnsResolved >= 2
  ) {
    return true;
  }

  // Main transition for ordinary London, Caro-Kann, Queen's Gambit, etc.
  if (
    fullMove >= 11 &&
    whiteDeveloped >= 3 &&
    blackDeveloped >= 3 &&
    resolvedCastling >= 1 &&
    centralPawnsResolved >= 2
  ) {
    return true;
  }

  // Some openings deliberately delay castling. Once both sides are mostly
  // developed and the center has changed, do not keep calling the position an
  // opening forever just because no king has committed yet.
  if (
    fullMove >= 13 &&
    whiteDeveloped >= 3 &&
    blackDeveloped >= 3 &&
    centralPawnsResolved >= 2
  ) {
    return true;
  }

  // Handle asymmetric openings where one side is lagging badly but the game has
  // clearly moved on.
  if (fullMove >= 15 && developedOrGoneMinors >= 6) return true;

  // Final safety cap for bizarre openings with repeated piece moves.
  if (fullMove >= 18) return true;

  return false;
}

export function classifyHistoryPhases(history) {
  if (!Array.isArray(history) || !history.length) return [];

  const chess = new Chess(history[0].before);
  const movedMinorStarts = new Set();
  let phase = 'opening';
  const rows = [];

  history.forEach((move, index) => {
    const counts = boardCounts(chess);

    // Endgame has priority and can be reached directly after unusually rapid
    // simplification. Phase transitions are irreversible.
    if (phase !== 'endgame' && endgameStarted(counts)) {
      phase = 'endgame';
    } else if (phase === 'opening' && openingEnded(chess, index, movedMinorStarts, counts)) {
      phase = 'middlegame';
    }

    rows.push({
      phase,
      bishops_remaining: counts.bishops,
      knights_remaining: counts.knights,
      minor_pieces_remaining: counts.minorPieces,
      heavy_pieces_remaining: counts.heavyPieces,
      non_pawn_pieces_remaining: counts.nonPawnPieces,
      pawns_remaining: counts.pawns,
      developed_or_gone_minors: originalMinorResolvedCount(chess, movedMinorStarts),
      white_developed_or_gone_minors: originalMinorResolvedCount(chess, movedMinorStarts, 'w'),
      black_developed_or_gone_minors: originalMinorResolvedCount(chess, movedMinorStarts, 'b'),
      castling_resolved_sides: castlingResolvedSides(chess),
      central_pawns_resolved: centralPawnResolvedCount(chess),
      phase_classifier_version: PHASE_CLASSIFIER_VERSION,
    });

    const startMinor = ORIGINAL_MINORS.find(
      ([square, color, type]) => square === move.from && color === move.color && type === move.piece
    );
    if (startMinor) movedMinorStarts.add(move.from);

    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  });

  return rows;
}

export function phaseDataFromPgn(pgn, expectedPlies = null) {
  try {
    const parsed = new Chess();
    parsed.loadPgn(String(pgn || ''));
    const history = parsed.history({ verbose: true });
    if (expectedPlies != null && history.length !== expectedPlies) return [];
    return classifyHistoryPhases(history);
  } catch {
    return [];
  }
}

export function summarizePhaseMoves(moveRows, playerColor) {
  const summary = {};
  for (const phase of PHASES) {
    summary[phase] = {
      playerLosses: [],
      opponentLosses: [],
      playerBlunders: 0,
      opponentBlunders: 0,
      playerMoves: 0,
      opponentMoves: 0,
    };
  }

  for (const move of moveRows || []) {
    const phase = PHASES.includes(move.phase) ? move.phase : null;
    if (!phase) continue;
    const side = move.color === playerColor ? 'player' : 'opponent';
    const target = summary[phase];
    const raw = move.raw_loss_cp;
    const rawNumber = raw === '' || raw == null ? null : Number(raw);

    if (side === 'player') {
      target.playerMoves += 1;
      if (Number.isFinite(rawNumber)) target.playerLosses.push(rawNumber);
      if (Number(move.practical_blunder || 0)) target.playerBlunders += 1;
    } else {
      target.opponentMoves += 1;
      if (Number.isFinite(rawNumber)) target.opponentLosses.push(rawNumber);
      if (Number(move.practical_blunder || 0)) target.opponentBlunders += 1;
    }
  }

  const meanOrNull = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  const fields = {};
  for (const phase of PHASES) {
    const s = summary[phase];
    fields[`player_${phase}_acpl`] = meanOrNull(s.playerLosses);
    fields[`opponent_${phase}_acpl`] = meanOrNull(s.opponentLosses);
    fields[`player_${phase}_blunders`] = s.playerBlunders;
    fields[`opponent_${phase}_blunders`] = s.opponentBlunders;
    fields[`player_${phase}_moves`] = s.playerMoves;
    fields[`opponent_${phase}_moves`] = s.opponentMoves;
  }

  return fields;
}

export { PHASES };
