export const CATEGORIZATION_VERSION = 'categorization-v7-miss-after-opponent-error';

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

function opponentErrorType(previousOpponentQuality) {
  const quality = String(previousOpponentQuality || '').toLowerCase();
  return ['mistake', 'blunder'].includes(quality) ? quality : '';
}

function missFromOpponentError({ quality, previousOpponentQuality, rawLoss }) {
  const opponentError = opponentErrorType(previousOpponentQuality);

  // A Miss is specifically a failure to capitalize on an opportunity created
  // by the opponent's immediately preceding Mistake or Blunder. The move still
  // needs to be a meaningful error of our own; small inaccuracies stay
  // Inaccuracies rather than becoming Misses.
  if (!opponentError || !['mistake', 'blunder'].includes(quality)) {
    return {
      missedOpportunity: false,
      missedType: '',
      categoryReason: '',
      opportunityValueCp: 0,
    };
  }

  return {
    missedOpportunity: true,
    missedType: opponentError === 'blunder' ? 'after_opponent_blunder' : 'after_opponent_mistake',
    categoryReason: opponentError === 'blunder'
      ? 'failed_to_capitalize_on_opponent_blunder'
      : 'failed_to_capitalize_on_opponent_mistake',
    opportunityValueCp: Number.isFinite(rawLoss) ? rawLoss : 0,
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
  playedUci,
  bestUci,
  secondBestCp,
  secondBestMate,
  previousOpponentQuality = '',
}) {
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

  // Missing a forced mate only becomes a Miss when the opponent's immediately
  // preceding move was itself a Mistake or Blunder. Otherwise it remains a
  // severe move error, which keeps the Miss category tied to opponent-created
  // opportunities.
  if (bestMate && !playedMate) {
    const followsOpponentError = ['mistake', 'blunder'].includes(
      String(previousOpponentQuality || '').toLowerCase(),
    );
    return {
      ...empty,
      category: followsOpponentError ? 'miss' : 'blunder',
      quality_category: 'blunder',
      category_reason: followsOpponentError ? 'missed_forced_mate_after_opponent_error' : 'missed_mate_without_opponent_error',
      practical_blunder: followsOpponentError ? 0 : 1,
      missed_opportunity: followsOpponentError ? 1 : 0,
      missed_opportunity_type: followsOpponentError ? 'mate' : '',
      missed_opportunity_value_cp: followsOpponentError ? 100000 : 0,
      missed_mate: 1,
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
    previousOpponentQuality,
    rawLoss,
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
// No Stockfish search is needed.  This keeps the entire historical dashboard on
// one semantic definition even when the Miss/Blunder taxonomy changes.
export function reclassifyStoredMove(move, previousOpponentQuality = '') {
  const beforeCp = finiteNumber(move?.eval_before_cp ?? move?.best_after_cp);
  const playedCp = finiteNumber(move?.played_after_cp);
  const rawLoss = finiteNumber(move?.raw_loss_cp);
  const secondBestCp = finiteNumber(move?.second_best_after_cp);
  const storedAdjusted = finiteNumber(move?.adjusted_loss_cp);
  const adjusted = storedAdjusted ?? (
    Number.isFinite(rawLoss) && Number.isFinite(beforeCp)
      ? rawLoss * positionFactor(beforeCp)
      : null
  );
  const bestMate = Boolean(Number(move?.best_after_is_mate || 0) || Number(move?.best_mate_in || 0) > 0);
  const playedMate = Boolean(Number(move?.played_after_is_mate || 0) || Number(move?.played_mate_in || 0) > 0);
  const quality = storedQuality(move, adjusted);

  const forcedMateMissed = bestMate && !playedMate;
  const followsOpponentError = Boolean(opponentErrorType(previousOpponentQuality));
  const forcedMateWithoutOpponentError = forcedMateMissed && !followsOpponentError;
  const effectiveQuality = forcedMateWithoutOpponentError ? 'blunder' : quality;
  const miss = forcedMateMissed && followsOpponentError
    ? {
        missedOpportunity: true,
        missedType: 'mate',
        categoryReason: 'missed_forced_mate_after_opponent_error',
        opportunityValueCp: 100000,
      }
    : missFromOpponentError({
        quality: effectiveQuality,
        previousOpponentQuality,
        rawLoss,
      });

  const conversionError =
    !miss.missedOpportunity &&
    !forcedMateMissed &&
    Number.isFinite(beforeCp) &&
    Number.isFinite(playedCp) &&
    Number.isFinite(rawLoss) &&
    Number.isFinite(adjusted) &&
    beforeCp >= 200 &&
    playedCp >= 100 &&
    rawLoss >= 100 &&
    adjusted >= 75;

  const primaryCategory = miss.missedOpportunity ? 'miss' : effectiveQuality;

  return {
    ...move,
    category: primaryCategory,
    quality_category: effectiveQuality,
    category_reason: miss.missedOpportunity
      ? miss.categoryReason
      : forcedMateWithoutOpponentError
        ? 'missed_mate_without_opponent_error'
        : conversionError
          ? 'conversion_leak'
          : effectiveQuality === 'blunder'
            ? 'catastrophic_move_loss'
            : effectiveQuality === 'mistake'
              ? 'major_move_loss'
              : effectiveQuality === 'inaccuracy'
                ? 'moderate_move_loss'
                : effectiveQuality === 'great'
                  ? 'unique_best_move'
                  : effectiveQuality === 'best'
                    ? 'best_or_equivalent_move'
                    : 'acceptable_move',
    practical_blunder: primaryCategory === 'blunder' ? 1 : 0,
    conversion_error: conversionError ? 1 : 0,
    conversion_error_type: conversionError ? 'advantage_leak' : '',
    missed_opportunity: miss.missedOpportunity ? 1 : 0,
    missed_opportunity_type: miss.missedType,
    missed_opportunity_value_cp: miss.opportunityValueCp,
    missed_mate: forcedMateMissed ? 1 : 0,
    categorization_version: CATEGORIZATION_VERSION,
  };
}

export function reclassifyStoredMoves(moves) {
  const result = [];
  let previousQuality = '';

  for (const move of moves || []) {
    const classified = reclassifyStoredMove(move, previousQuality);
    result.push(classified);
    // Moves alternate colors in a legal game, so the immediately preceding move
    // is always the opponent's move. Use underlying severity rather than the
    // display category so an opponent Miss whose severity was a Blunder still
    // counts as the error that created the next opportunity.
    previousQuality = classified.quality_category || classified.category || '';
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
