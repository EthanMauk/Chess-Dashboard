export const CATEGORIZATION_VERSION = 'categorization-v11-missed-mate-severity';

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function positionFactor(beforeCp) {
  // Errors matter most in competitive positions and progressively less once
  // the position is already overwhelmingly decided.
  return 0.30 + 0.70 * Math.max(0, 1 - Math.abs(beforeCp) / 1000);
}

function normalizedQuality(value) {
  return String(value || '').toLowerCase();
}

function opponentErrorType(previousOpponentMove) {
  const quality = normalizedQuality(
    typeof previousOpponentMove === 'string'
      ? previousOpponentMove
      : previousOpponentMove?.quality_category || previousOpponentMove?.category,
  );
  return ['mistake', 'blunder'].includes(quality) ? quality : '';
}

function previousMoveFacts(previousOpponentMove) {
  if (!previousOpponentMove || typeof previousOpponentMove === 'string') {
    return {
      quality: opponentErrorType(previousOpponentMove),
      beforeCp: null,
      playedCp: null,
      rawLoss: null,
      createdMate: false,
    };
  }

  const beforeCp = finiteNumber(previousOpponentMove.eval_before_cp ?? previousOpponentMove.beforeCp);
  const playedCp = finiteNumber(previousOpponentMove.played_after_cp ?? previousOpponentMove.playedCp);
  const rawLoss = finiteNumber(previousOpponentMove.raw_loss_cp ?? previousOpponentMove.rawLoss);
  const beforeMateIn = finiteNumber(previousOpponentMove.before_mate_in ?? previousOpponentMove.beforeMateIn);
  const playedMateIn = finiteNumber(previousOpponentMove.played_mate_in ?? previousOpponentMove.playedMateIn);

  // From the previous mover's perspective, a negative played_mate_in means
  // their move left the opponent (the current mover) with a forced mate. It
  // only CREATED that opportunity if the opponent was not already being mated
  // before the move.
  const createdMate = playedMateIn != null && playedMateIn < 0 && !(beforeMateIn != null && beforeMateIn < 0);

  return {
    quality: opponentErrorType(previousOpponentMove),
    beforeCp,
    playedCp,
    rawLoss,
    createdMate,
  };
}

function missFromOpponentError({
  quality,
  previousOpponentMove,
  rawLoss,
  bestMate = false,
}) {
  const previous = previousMoveFacts(previousOpponentMove);
  if (!previous.quality || !['mistake', 'blunder'].includes(quality)) {
    return {
      missedOpportunity: false,
      missedType: '',
      categoryReason: '',
      opportunityValueCp: 0,
      surrenderedOpportunityCp: 0,
    };
  }

  // Keep Miss deliberately simple: if the opponent's immediately preceding
  // move was a Mistake/Blunder and our reply is itself a Mistake/Blunder, the
  // reply is a Miss. A Miss is its own primary category and is NOT also counted
  // as a practical blunder.
  return {
    missedOpportunity: true,
    missedType: bestMate
      ? 'mate'
      : previous.quality === 'blunder'
        ? 'after_opponent_blunder'
        : 'after_opponent_mistake',
    categoryReason: bestMate
      ? 'missed_forced_mate_after_opponent_error'
      : previous.quality === 'blunder'
        ? 'failed_to_capitalize_on_opponent_blunder'
        : 'failed_to_capitalize_on_opponent_mistake',
    opportunityValueCp: bestMate ? 100000 : (Number.isFinite(rawLoss) ? rawLoss : 0),
    surrenderedOpportunityCp: Number.isFinite(rawLoss) ? rawLoss : 0,
  };
}

function qualityFromAdjustedLoss({ adjusted, effectivelyBest, great }) {
  if (great) return 'great';
  if (effectivelyBest) return 'best';
  if (adjusted < 75) return 'good';
  if (adjusted < 150) return 'inaccuracy';
  if (adjusted < 300) return 'mistake';
  return 'blunder';
}

export function classifyMove({
  beforeCp,
  playedCp,
  rawLoss,
  bestMate,
  playedMate,
  allowedOpponentMate = false,
  beforeLosingMate = false,
  playedUci,
  bestUci,
  secondBestCp,
  secondBestMate,
  previousOpponentMove = null,
  // Backward-compatible input used by older callers/tests.
  previousOpponentQuality = '',
}) {
  const previousContext = previousOpponentMove || previousOpponentQuality;
  const empty = {
    category: 'good',
    quality_category: 'good',
    category_reason: 'ordinary_move',
    practical_blunder: 0,
    conversion_error: 0,
    conversion_error_type: '',
    missed_opportunity: 0,
    missed_opportunity_type: '',
    missed_opportunity_value_cp: 0,
    missed_opportunity_surrendered_cp: 0,
    missed_mate: 0,
    is_best_move: 0,
    great_move: 0,
    adjusted_loss_cp: rawLoss == null ? null : rawLoss,
    best_move_gap_cp: null,
    categorization_version: CATEGORIZATION_VERSION,
  };

  const exactBest = Boolean(bestUci && playedUci && bestUci.toLowerCase() === playedUci.toLowerCase());

  // If the played move keeps a forced mating line, treat it as successful even
  // when it is not the engine's first PV move.
  if (playedMate) {
    return {
      ...empty,
      category: exactBest ? 'best' : 'good',
      quality_category: exactBest ? 'best' : 'good',
      category_reason: exactBest ? 'best_mating_move' : 'equivalent_mating_move',
      is_best_move: exactBest ? 1 : 0,
      adjusted_loss_cp: 0,
    };
  }

  // Missing a forced mate is always a Miss and is always tagged as a missed
  // mate. It is forgiven as a practical blunder only when the player already
  // had at least +3.00 before the opponent's preceding move and, after missing
  // mate, still retains at least half of that pre-existing advantage. In that
  // case it is a conversion error instead. Otherwise it is both a Miss and a
  // practical blunder. Examples: +5 -> mate -> +4 is Miss + missed mate +
  // conversion error; -1 -> mate -> -1 is Miss + missed mate + practical blunder.
  if (bestMate && !playedMate) {
    const previous = previousMoveFacts(previousContext);
    const preOpponentAdvantageCp = Number.isFinite(previous.beforeCp)
      ? -previous.beforeCp
      : null;
    const retainedLargeAdvantage =
      Number.isFinite(preOpponentAdvantageCp) &&
      preOpponentAdvantageCp >= 300 &&
      Number.isFinite(playedCp) &&
      playedCp >= preOpponentAdvantageCp * 0.5;

    return {
      ...empty,
      category: 'miss',
      quality_category: 'blunder',
      category_reason: retainedLargeAdvantage
        ? 'missed_forced_mate_but_retained_large_advantage'
        : 'missed_forced_mate',
      practical_blunder: retainedLargeAdvantage ? 0 : 1,
      conversion_error: retainedLargeAdvantage ? 1 : 0,
      conversion_error_type: retainedLargeAdvantage ? 'missed_mate_retained_advantage' : '',
      missed_opportunity: 1,
      missed_opportunity_type: 'mate',
      missed_opportunity_value_cp: 100000,
      missed_opportunity_surrendered_cp: 0,
      missed_mate: 1,
      is_best_move: 0,
    };
  }

  // Mate scores do not have ordinary CPL, so handle this explicitly. A move
  // that goes from better than -5.00 to a forced mate against us is severe
  // enough to be a Blunder. If it immediately follows an opponent error, it is
  // a Miss only, preserving the mutually-exclusive Miss semantics.
  const mateBlunder = allowedOpponentMate && !beforeLosingMate && Number.isFinite(beforeCp) && beforeCp > -500;
  if (mateBlunder) {
    const miss = missFromOpponentError({
      quality: 'blunder',
      previousOpponentMove: previousContext,
      rawLoss,
      bestMate: false,
    });
    return {
      ...empty,
      category: miss.missedOpportunity ? 'miss' : 'blunder',
      quality_category: 'blunder',
      category_reason: miss.missedOpportunity ? miss.categoryReason : 'blundered_into_forced_mate_from_better_than_minus_5',
      practical_blunder: miss.missedOpportunity ? 0 : 1,
      missed_opportunity: miss.missedOpportunity ? 1 : 0,
      missed_opportunity_type: miss.missedType,
      missed_opportunity_value_cp: miss.opportunityValueCp,
      missed_opportunity_surrendered_cp: miss.surrenderedOpportunityCp,
      missed_mate: 0,
      is_best_move: 0,
    };
  }

  if (rawLoss == null) return empty;

  const factor = positionFactor(beforeCp);
  const adjusted = rawLoss * factor;
  const effectivelyBest = exactBest || rawLoss <= 10;

  let bestGap = null;
  let adjustedBestGap = null;
  let great = false;
  if (Number.isFinite(secondBestCp)) {
    bestGap = Math.max(0, beforeCp - secondBestCp);
    adjustedBestGap = bestGap * factor;
    great = effectivelyBest && (adjustedBestGap >= 125 || (bestMate && !secondBestMate));
  }

  const quality = qualityFromAdjustedLoss({ adjusted, effectivelyBest, great });
  const miss = missFromOpponentError({
    quality,
    previousOpponentMove: previousContext,
    beforeCp,
    playedCp,
    rawLoss,
    bestMate: false,
  });

  const conversionError =
    !miss.missedOpportunity &&
    beforeCp >= 200 &&
    playedCp >= 100 &&
    rawLoss >= 100 &&
    adjusted >= 75;

  const primaryCategory = miss.missedOpportunity ? 'miss' : quality;

  return {
    ...empty,
    category: primaryCategory,
    quality_category: quality,
    category_reason: miss.missedOpportunity
      ? miss.categoryReason
      : conversionError
        ? 'conversion_leak'
        : quality === 'blunder'
          ? 'catastrophic_move_loss'
          : quality === 'mistake'
            ? 'major_move_loss'
            : quality === 'inaccuracy'
              ? 'moderate_move_loss'
              : quality === 'great'
                ? 'unique_best_move'
                : quality === 'best'
                  ? 'best_or_equivalent_move'
                  : 'acceptable_move',
    practical_blunder: primaryCategory === 'blunder' ? 1 : 0,
    conversion_error: conversionError ? 1 : 0,
    conversion_error_type: conversionError ? 'advantage_leak' : '',
    missed_opportunity: miss.missedOpportunity ? 1 : 0,
    missed_opportunity_type: miss.missedType,
    missed_opportunity_value_cp: miss.opportunityValueCp,
    missed_opportunity_surrendered_cp: miss.surrenderedOpportunityCp,
    missed_mate: 0,
    is_best_move: effectivelyBest ? 1 : 0,
    great_move: great ? 1 : 0,
    adjusted_loss_cp: adjusted,
    best_move_gap_cp: bestGap,
    categorization_version: CATEGORIZATION_VERSION,
  };
}

function storedQuality(move, adjusted) {
  const explicit = String(move?.quality_category || '').toLowerCase();
  if (['great', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'].includes(explicit)) {
    return explicit;
  }

  const category = String(move?.category || '').toLowerCase();
  if (['great', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'].includes(category)) {
    return category;
  }

  if (Number(move?.great_move || 0)) return 'great';
  if (Number(move?.is_best_move || 0)) return 'best';
  if (!Number.isFinite(adjusted)) return 'good';
  return qualityFromAdjustedLoss({ adjusted, effectivelyBest: false, great: false });
}

// Reclassify an archived move using engine facts already stored in the move row.
// No Stockfish search is needed. This keeps the entire historical dashboard on
// one semantic definition even when the Miss/Blunder taxonomy changes.
export function reclassifyStoredMove(move, previousOpponentMove = null) {
  const beforeCp = finiteNumber(move?.eval_before_cp ?? move?.best_after_cp);
  const playedCp = finiteNumber(move?.played_after_cp);
  const rawLoss = finiteNumber(move?.raw_loss_cp);
  const storedAdjusted = finiteNumber(move?.adjusted_loss_cp);
  const adjusted = storedAdjusted ?? (
    Number.isFinite(rawLoss) && Number.isFinite(beforeCp)
      ? rawLoss * positionFactor(beforeCp)
      : null
  );
  const beforeMateIn = finiteNumber(move?.before_mate_in);
  const playedMateIn = finiteNumber(move?.played_mate_in);
  const bestMate = Boolean(Number(move?.best_after_is_mate || 0) || (beforeMateIn != null && beforeMateIn > 0));
  const playedMate = Boolean(Number(move?.played_after_is_mate || 0) || (playedMateIn != null && playedMateIn > 0));
  const beforeLosingMate = beforeMateIn != null && beforeMateIn < 0;
  const allowedOpponentMate = playedMateIn != null && playedMateIn < 0;
  const forcedMateMissed = bestMate && !playedMate;
  const mateBlunder = allowedOpponentMate && !beforeLosingMate && Number.isFinite(beforeCp) && beforeCp > -500;

  let quality = storedQuality(move, adjusted);
  if (forcedMateMissed || mateBlunder) quality = 'blunder';

  if (forcedMateMissed) {
    const previous = previousMoveFacts(previousOpponentMove);
    const preOpponentAdvantageCp = Number.isFinite(previous.beforeCp)
      ? -previous.beforeCp
      : null;
    const retainedLargeAdvantage =
      Number.isFinite(preOpponentAdvantageCp) &&
      preOpponentAdvantageCp >= 300 &&
      Number.isFinite(playedCp) &&
      playedCp >= preOpponentAdvantageCp * 0.5;

    return {
      ...move,
      category: 'miss',
      quality_category: 'blunder',
      category_reason: retainedLargeAdvantage
        ? 'missed_forced_mate_but_retained_large_advantage'
        : 'missed_forced_mate',
      practical_blunder: retainedLargeAdvantage ? 0 : 1,
      conversion_error: retainedLargeAdvantage ? 1 : 0,
      conversion_error_type: retainedLargeAdvantage ? 'missed_mate_retained_advantage' : '',
      missed_opportunity: 1,
      missed_opportunity_type: 'mate',
      missed_opportunity_value_cp: 100000,
      missed_opportunity_surrendered_cp: 0,
      missed_mate: 1,
      categorization_version: CATEGORIZATION_VERSION,
    };
  }

  const miss = (quality === 'mistake' || quality === 'blunder')
    ? missFromOpponentError({
        quality,
        previousOpponentMove,
        rawLoss,
        bestMate: false,
      })
    : {
        missedOpportunity: false,
        missedType: '',
        categoryReason: '',
        opportunityValueCp: 0,
        surrenderedOpportunityCp: 0,
      };

  const conversionError =
    !miss.missedOpportunity &&
    !mateBlunder &&
    Number.isFinite(beforeCp) &&
    Number.isFinite(playedCp) &&
    Number.isFinite(rawLoss) &&
    Number.isFinite(adjusted) &&
    beforeCp >= 200 &&
    playedCp >= 100 &&
    rawLoss >= 100 &&
    adjusted >= 75;

  const primaryCategory = miss.missedOpportunity ? 'miss' : quality;

  return {
    ...move,
    category: primaryCategory,
    quality_category: quality,
    category_reason: miss.missedOpportunity
      ? miss.categoryReason
      : mateBlunder
        ? 'blundered_into_forced_mate_from_better_than_minus_5'
        : forcedMateMissed
          ? 'missed_forced_mate'
          : conversionError
            ? 'conversion_leak'
            : quality === 'blunder'
              ? 'catastrophic_move_loss'
              : quality === 'mistake'
                ? 'major_move_loss'
                : quality === 'inaccuracy'
                  ? 'moderate_move_loss'
                  : quality === 'great'
                    ? 'unique_best_move'
                    : quality === 'best'
                      ? 'best_or_equivalent_move'
                      : 'acceptable_move',
    practical_blunder: primaryCategory === 'blunder' ? 1 : 0,
    conversion_error: conversionError ? 1 : 0,
    conversion_error_type: conversionError ? 'advantage_leak' : '',
    missed_opportunity: miss.missedOpportunity ? 1 : 0,
    missed_opportunity_type: miss.missedType,
    missed_opportunity_value_cp: miss.opportunityValueCp,
    missed_opportunity_surrendered_cp: miss.surrenderedOpportunityCp,
    missed_mate: forcedMateMissed ? 1 : 0,
    categorization_version: CATEGORIZATION_VERSION,
  };
}

export function reclassifyStoredMoves(moves) {
  const result = [];
  let previousMove = null;

  for (const move of moves || []) {
    const classified = reclassifyStoredMove(move, previousMove);
    result.push(classified);
    // Legal chess moves alternate colors, so the previous row is always the
    // opponent's immediately preceding move. Keep the whole classified move so
    // Miss logic can measure the opportunity it actually created.
    previousMove = classified;
  }

  return result;
}

export function summarizeCategorizedMoves(moves, playerColor = 'White') {
  const counters = {
    White: { blunder: 0, miss: 0, great: 0, best: 0, good: 0, mistake: 0, inaccuracy: 0, practical: 0, conversion: 0, missedOpportunity: 0, missedMate: 0, moves: 0 },
    Black: { blunder: 0, miss: 0, great: 0, best: 0, good: 0, mistake: 0, inaccuracy: 0, practical: 0, conversion: 0, missedOpportunity: 0, missedMate: 0, moves: 0 },
  };

  for (const move of moves || []) {
    const color = move?.color === 'Black' ? 'Black' : 'White';
    const bucket = counters[color];
    const category = String(move?.category || 'good').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(bucket, category)) bucket[category] += 1;
    bucket.practical += Number(move?.practical_blunder || 0);
    bucket.conversion += Number(move?.conversion_error || 0);
    bucket.missedOpportunity += Number(move?.missed_opportunity || 0);
    bucket.missedMate += Number(move?.missed_mate || 0);
    bucket.moves += 1;
  }

  const player = playerColor === 'Black' ? counters.Black : counters.White;
  const opponent = playerColor === 'Black' ? counters.White : counters.Black;

  return {
    player_practical_blunders: player.practical,
    opponent_practical_blunders: opponent.practical,
    player_conversion_errors: player.conversion,
    opponent_conversion_errors: opponent.conversion,
    player_missed_opportunities: player.missedOpportunity,
    opponent_missed_opportunities: opponent.missedOpportunity,
    player_missed_mates: player.missedMate,
    opponent_missed_mates: opponent.missedMate,
    player_misses: player.miss,
    opponent_misses: opponent.miss,
    player_great_moves: player.great,
    opponent_great_moves: opponent.great,
    player_best_moves: player.best,
    opponent_best_moves: opponent.best,
    player_good_moves: player.good,
    opponent_good_moves: opponent.good,
    player_mistakes: player.mistake,
    opponent_mistakes: opponent.mistake,
    player_inaccuracies: player.inaccuracy,
    opponent_inaccuracies: opponent.inaccuracy,
    player_moves: player.moves,
    opponent_moves: opponent.moves,
  };
}
