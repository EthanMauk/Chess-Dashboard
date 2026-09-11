export const CATEGORIZATION_VERSION = 'categorization-v6-unique-opportunities';

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

function missFromOpportunity({
  beforeCp,
  playedCp,
  rawLoss,
  bestMate,
  playedMate,
  secondBestCp,
}) {
  // A forced mating line is the clearest possible missed opportunity.
  if (bestMate && !playedMate) {
    return {
      missedOpportunity: true,
      missedType: 'mate',
      categoryReason: 'missed_forced_mate',
      missedMate: true,
      opportunityValueCp: 100000,
    };
  }

  if (
    rawLoss == null ||
    !Number.isFinite(beforeCp) ||
    !Number.isFinite(playedCp) ||
    !Number.isFinite(secondBestCp)
  ) {
    return {
      missedOpportunity: false,
      missedType: '',
      categoryReason: '',
      missedMate: false,
      opportunityValueCp: 0,
    };
  }

  // A Miss requires evidence that the opportunity/resource was NARROW.  The
  // second-best move therefore has to fail to preserve the same practical
  // result as the best move.  This is the key distinction from an ordinary
  // blunder: if many moves keep the advantage and the played move alone ruins
  // it, the move is a Blunder, not a Miss.
  const bestGap = Math.max(0, beforeCp - secondBestCp);

  // Winning chance: one move retains a clearly winning position, while the
  // second-best move no longer keeps even a clear advantage.
  if (
    beforeCp >= 250 &&
    secondBestCp < 100 &&
    playedCp < 75 &&
    rawLoss >= 175 &&
    bestGap >= 150
  ) {
    return {
      missedOpportunity: true,
      missedType: 'winning_chance',
      categoryReason: 'missed_unique_winning_chance',
      missedMate: false,
      opportunityValueCp: rawLoss,
    };
  }

  // Clear advantage: the best move keeps a real edge but the second-best move
  // does not.  A large collapse is therefore failure to find the narrow chance.
  if (
    beforeCp >= 125 &&
    secondBestCp < 50 &&
    playedCp < 25 &&
    rawLoss >= 125 &&
    bestGap >= 100
  ) {
    return {
      missedOpportunity: true,
      missedType: 'advantage',
      categoryReason: 'missed_unique_advantage',
      missedMate: false,
      opportunityValueCp: rawLoss,
    };
  }

  // Smaller but still concrete chance: a roughly +1 opportunity exists only
  // through the best move; alternatives fall back to equality or worse.
  if (
    beforeCp >= 75 &&
    secondBestCp < 0 &&
    playedCp < 25 &&
    rawLoss >= 100 &&
    bestGap >= 100
  ) {
    return {
      missedOpportunity: true,
      missedType: 'unique_chance',
      categoryReason: 'missed_unique_chance',
      missedMate: false,
      opportunityValueCp: rawLoss,
    };
  }

  // Equalizing defense: the best move keeps the game roughly playable, while
  // the second-best move already drops into a clearly worse position.
  if (
    beforeCp >= -75 &&
    beforeCp < 75 &&
    secondBestCp <= -150 &&
    playedCp <= -200 &&
    rawLoss >= 150 &&
    bestGap >= 100
  ) {
    return {
      missedOpportunity: true,
      missedType: 'defense',
      categoryReason: 'missed_unique_equalizing_defense',
      missedMate: false,
      opportunityValueCp: rawLoss,
    };
  }

  // Defensive resource from an already worse position.  Again the resource
  // must be narrow: the second-best move is substantially worse than the best.
  if (
    beforeCp > -250 &&
    beforeCp < -75 &&
    secondBestCp <= -350 &&
    playedCp <= -450 &&
    rawLoss >= 225 &&
    bestGap >= 125
  ) {
    return {
      missedOpportunity: true,
      missedType: 'defensive_resource',
      categoryReason: 'missed_unique_defensive_resource',
      missedMate: false,
      opportunityValueCp: rawLoss,
    };
  }

  return {
    missedOpportunity: false,
    missedType: '',
    categoryReason: '',
    missedMate: false,
    opportunityValueCp: 0,
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

  // A forced mate that is abandoned is always a Miss, even though ordinary CPL
  // is undefined for mate transitions.
  if (bestMate && !playedMate) {
    return {
      ...empty,
      category: 'miss',
      quality_category: 'blunder',
      category_reason: 'missed_forced_mate',
      missed_opportunity: 1,
      missed_opportunity_type: 'mate',
      missed_opportunity_value_cp: 100000,
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
  const miss = missFromOpportunity({
    beforeCp,
    playedCp,
    rawLoss,
    bestMate,
    playedMate,
    secondBestCp,
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
    missed_mate: miss.missedMate ? 1 : 0,
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
export function reclassifyStoredMove(move) {
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

  const miss = missFromOpportunity({
    beforeCp,
    playedCp,
    rawLoss,
    bestMate,
    playedMate,
    secondBestCp,
  });

  const conversionError =
    !miss.missedOpportunity &&
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
    missed_mate: miss.missedMate ? 1 : 0,
    categorization_version: CATEGORIZATION_VERSION,
  };
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
