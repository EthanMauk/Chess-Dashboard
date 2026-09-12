import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  Upload,
  RefreshCw,
  Database,
  Trophy,
  Target,
  TrendingUp,
  Gauge,
} from "lucide-react";

import Metric from "./components/Metric";
import ChartCard, { ChartTooltip, PhaseBlunderTooltip } from "./components/ChartCard";
import RangeLineChart from "./components/RangeLineChart";
import GameRow from "./components/GameRow";
import {
  parseCSV,
  isGamesRows,
  isMovesRows,
  normalizeGames,
  normalizeMoves,
  num,
} from "./utils/chessData";
import { quartiles, quartileAverages } from "./utils/statistics";
import { browserSync, loadDashboardRows } from "./browser/analyzer";
import { backfillPhaseCache } from "./browser/db";
import { hydrateProfileFromRemote, uploadProfileSnapshot } from "./browser/remotePersistence";
import packageJson from "../package.json";
import "./styles.css";

const USERNAME_STORAGE_KEY = "chess-dashboard-username";
const TIME_CLASS_STORAGE_KEY = "chess-dashboard-time-class";
const ENGINE_NODES_STORAGE_KEY = "chess-dashboard-browser-nodes";
const APP_VERSION = packageJson.version;

function parseGameDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const normalized = text.replaceAll(".", "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatWindowDate(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function utcDateParts(timestamp) {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function timestampWithDatePart(timestamp, part, rawValue) {
  const current = utcDateParts(timestamp);
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return timestamp;

  let year = current.year;
  let month = current.month;
  let day = current.day;

  if (part === "year") year = value;
  if (part === "month") month = value;
  if (part === "day") day = value;

  day = Math.min(day, daysInUtcMonth(year, month));
  return Date.UTC(year, month - 1, day);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function gameResultScore(result) {
  if (result === "win") return 1;
  if (result === "draw") return 0.5;
  if (result === "loss") return 0;
  return null;
}

function regressionSlopePerGame(rows, xKey, yKey) {
  const points = rows
    .map((row) => ({ x: Number(row[xKey]), y: Number(row[yKey]) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (points.length < 2) return 0;

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    const dx = point.x - meanX;
    numerator += dx * (point.y - meanY);
    denominator += dx * dx;
  }

  return denominator ? numerator / denominator : 0;
}

function medianFinite(values) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function representativeClimbEndpoints(sample) {
  if (!sample.length) {
    return {
      windowSize: 0,
      startRating: 0,
      endRating: 0,
      startGame: 0,
      endGame: 0,
      startTime: NaN,
      endTime: NaN,
    };
  }

  // The detector intentionally finds a regime boundary, which can land on a
  // one-game trough or spike. Measure climb magnitude from robust local levels
  // around each edge instead of treating those individual games as the true
  // start/end rating. Use ~8% of the regime, capped at 20 games.
  const windowSize = Math.min(
    20,
    Math.max(1, Math.floor(sample.length / 3)),
    Math.max(3, Math.round(sample.length * 0.08))
  );
  const startWindow = sample.slice(0, Math.min(windowSize, sample.length));
  const endWindow = sample.slice(Math.max(0, sample.length - windowSize));

  const midpoint = (rows, key) => medianFinite(rows.map((row) => row[key]));
  const timestampMedian = (rows) => medianFinite(
    rows.map((row) => parseGameDate(row.date)).filter((value) => Number.isFinite(value))
  );

  return {
    windowSize,
    startRating: midpoint(startWindow, "playerRating"),
    endRating: midpoint(endWindow, "playerRating"),
    startGame: midpoint(startWindow, "gameNumber"),
    endGame: midpoint(endWindow, "gameNumber"),
    startTime: timestampMedian(startWindow),
    endTime: timestampMedian(endWindow),
  };
}

function climbStateLabel({ score, endVsMean, recentSlopePer100, newTerritoryGain }) {
  if (endVsMean < 0 && recentSlopePer100 < -10) return "Floundering";
  if (endVsMean < 0 || recentSlopePer100 <= 10) return "Flatlining";
  if (score >= 85 && recentSlopePer100 >= 40 && newTerritoryGain >= 50) return "Flying";
  return "Climbing";
}


function detectEstablishedRatingHistoryStart(chronological) {
  if (!chronological.length) {
    return {
      startIndex: 0,
      startGame: null,
      startDate: NaN,
      blockSize: 0,
      detected: false,
      placementGamesExcluded: 0,
      excludedPlacementPeak: NaN,
    };
  }

  // Placement ratings are provisional and should not define an account's
  // long-term ceiling. Find the first sustained upward regime and treat that
  // as the beginning of established rating history. This deliberately avoids
  // an arbitrary "ignore the first N games" rule: an account that truly
  // climbs immediately can establish history immediately, while an account
  // that falls through placement can keep that whole stabilization period out
  // of the prior-peak/new-territory calculation.
  if (chronological.length < 24) {
    return {
      startIndex: 0,
      startGame: Number(chronological[0]?.gameNumber) || null,
      startDate: parseGameDate(chronological[0]?.date),
      blockSize: chronological.length,
      detected: false,
      placementGamesExcluded: 0,
      excludedPlacementPeak: NaN,
    };
  }

  const blockSize = Math.round(clampNumber(chronological.length / 80, 12, 25));
  const step = Math.max(4, Math.floor(blockSize / 2));
  const windowSize = blockSize * 3;
  const MIN_SLOPE_PER_100 = 20;
  const MIN_TOTAL_GAIN = 30;

  let startIndex = 0;
  let detected = false;

  for (let candidate = 0; candidate + windowSize <= chronological.length; candidate += step) {
    const firstBlock = chronological.slice(candidate, candidate + blockSize);
    const secondBlock = chronological.slice(candidate + blockSize, candidate + (2 * blockSize));
    const thirdBlock = chronological.slice(candidate + (2 * blockSize), candidate + windowSize);
    const window = chronological.slice(candidate, candidate + windowSize);

    const medians = [firstBlock, secondBlock, thirdBlock].map((rows) =>
      medianFinite(rows.map((row) => row.playerRating))
    );
    if (medians.some((value) => !Number.isFinite(value))) continue;

    const slopePer100 = regressionSlopePerGame(window, "gameNumber", "playerRating") * 100;
    const totalGain = medians[2] - medians[0];
    const risingTransitions = Number(medians[1] > medians[0]) + Number(medians[2] > medians[1]);

    // Two consecutive rising block medians plus a meaningful regression slope
    // make this a sustained climb rather than a short placement bounce.
    if (
      slopePer100 >= MIN_SLOPE_PER_100
      && totalGain >= MIN_TOTAL_GAIN
      && risingTransitions === 2
    ) {
      startIndex = candidate;
      detected = true;
      break;
    }
  }

  // If there is not enough evidence for an established climb yet, do not let
  // provisional placement highs suppress new-territory credit. In that case
  // established history effectively begins with the current detected climb
  // when calculateClimbMetrics applies the prior-peak check.
  const placementGamesExcluded = detected ? startIndex : 0;
  const excludedPlacementRatings = placementGamesExcluded > 0
    ? chronological
        .slice(0, placementGamesExcluded)
        .map((game) => Number(game.playerRating))
        .filter((rating) => Number.isFinite(rating))
    : [];

  return {
    startIndex,
    startGame: Number(chronological[startIndex]?.gameNumber) || null,
    startDate: parseGameDate(chronological[startIndex]?.date),
    blockSize,
    detected,
    placementGamesExcluded,
    excludedPlacementPeak: excludedPlacementRatings.length
      ? Math.max(...excludedPlacementRatings)
      : NaN,
  };
}

function detectCurrentClimbWindow(chronological) {
  const DAY = 24 * 60 * 60 * 1000;
  const HARD_GAP_DAYS = 90;
  const CLIMB_SLOPE_THRESHOLD = 10;
  const FLAT_BLOCKS_TO_BREAK = 3;
  const POSITIVE_BLOCKS_TO_END_PLATEAU = 2;

  if (!chronological.length) {
    return {
      sample: [],
      eraStartGame: null,
      startGame: null,
      endGame: null,
      startDate: null,
      endDate: null,
      durationDays: 0,
      ratingGain: 0,
      recentSlopePer100: 0,
      blockSize: 0,
      isActiveClimb: false,
      hardGapDaysBefore: 0,
    };
  }

  // A gap longer than 90 days is always a hard boundary between climbs.
  let eraStartIndex = 0;
  let hardGapDaysBefore = 0;
  for (let index = 1; index < chronological.length; index += 1) {
    const previousTime = parseGameDate(chronological[index - 1].date);
    const currentTime = parseGameDate(chronological[index].date);
    if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) continue;

    const gapDays = (currentTime - previousTime) / DAY;
    if (gapDays > HARD_GAP_DAYS) {
      eraStartIndex = index;
      hardGapDaysBefore = gapDays;
    }
  }

  const era = chronological.slice(eraStartIndex);
  if (era.length < 2) {
    const only = era[0] || chronological[chronological.length - 1];
    return {
      sample: era,
      eraStartGame: Number(only?.gameNumber) || null,
      startGame: Number(only?.gameNumber) || null,
      endGame: Number(only?.gameNumber) || null,
      startDate: parseGameDate(only?.date),
      endDate: parseGameDate(only?.date),
      durationDays: 1,
      ratingGain: 0,
      recentSlopePer100: 0,
      blockSize: era.length,
      isActiveClimb: false,
      hardGapDaysBefore,
    };
  }

  // Work backwards in small regression blocks. Three consecutive flat/down
  // blocks are treated as a real regime break; one or two are allowed as an
  // internal plateau so normal stalls do not chop a climb into pieces.
  const blockSize = Math.round(clampNumber(era.length / 30, 15, 30));
  const blocks = [];
  let blockEnd = era.length;
  while (blockEnd > 0) {
    const blockStart = Math.max(0, blockEnd - blockSize);
    const rows = era.slice(blockStart, blockEnd);
    blocks.unshift({
      start: blockStart,
      end: blockEnd,
      slopePer100: regressionSlopePerGame(rows, "gameNumber", "playerRating") * 100,
    });
    blockEnd = blockStart;
  }

  const latestBlock = blocks[blocks.length - 1];
  const isActiveClimb = latestBlock.slopePer100 > CLIMB_SLOPE_THRESHOLD;
  let startBlockIndex = 0;

  if (isActiveClimb) {
    let weakStreak = 0;
    for (let index = blocks.length - 2; index >= 0; index -= 1) {
      if (blocks[index].slopePer100 <= CLIMB_SLOPE_THRESHOLD) weakStreak += 1;
      else weakStreak = 0;

      if (weakStreak >= FLAT_BLOCKS_TO_BREAK) {
        startBlockIndex = index + FLAT_BLOCKS_TO_BREAK;
        break;
      }
    }
  } else {
    // If the newest regime is already flat/down, do not keep crediting an old
    // climb forever. Find where this terminal plateau began.
    let positiveStreak = 0;
    for (let index = blocks.length - 2; index >= 0; index -= 1) {
      if (blocks[index].slopePer100 > CLIMB_SLOPE_THRESHOLD) positiveStreak += 1;
      else positiveStreak = 0;

      if (positiveStreak >= POSITIVE_BLOCKS_TO_END_PLATEAU) {
        startBlockIndex = Math.min(blocks.length - 1, index + POSITIVE_BLOCKS_TO_END_PLATEAU);
        break;
      }
    }
  }

  const startIndex = blocks[startBlockIndex]?.start ?? 0;
  const sample = era.slice(startIndex);
  const first = sample[0];
  const last = sample[sample.length - 1];
  const firstTime = parseGameDate(first?.date);
  const lastTime = parseGameDate(last?.date);
  const durationDays = Number.isFinite(firstTime) && Number.isFinite(lastTime)
    ? Math.max(1, Math.floor((lastTime - firstTime) / DAY) + 1)
    : 0;
  const baseline = representativeClimbEndpoints(sample);

  // A detected climb can begin at the bottom of a temporary crash. In that
  // case, counting the entire rebound as fresh climbing overstates the actual
  // rating territory gained. Use the immediately preceding local level as a
  // floor for the climb's starting baseline, but never reach across a 90-day
  // activity-era boundary.
  const priorWindowSize = Math.min(baseline.windowSize, startIndex);
  const priorWindow = priorWindowSize > 0
    ? era.slice(Math.max(0, startIndex - priorWindowSize), startIndex)
    : [];
  const preClimbBaselineRating = priorWindow.length
    ? medianFinite(priorWindow.map((row) => row.playerRating))
    : NaN;
  const effectiveStartRating = Number.isFinite(preClimbBaselineRating)
    ? Math.max(baseline.startRating, preClimbBaselineRating)
    : baseline.startRating;
  const recoveredEloExcluded = Math.max(0, effectiveStartRating - baseline.startRating);
  const ratingGain = baseline.endRating - effectiveStartRating;

  return {
    sample,
    eraStartGame: Number(era[0]?.gameNumber) || null,
    startGame: Number(first?.gameNumber) || null,
    endGame: Number(last?.gameNumber) || null,
    startDate: firstTime,
    endDate: lastTime,
    durationDays,
    ratingGain,
    baselineWindowSize: baseline.windowSize,
    baselineStartRating: baseline.startRating,
    baselineEndRating: baseline.endRating,
    preClimbBaselineRating,
    effectiveStartRating,
    recoveredEloExcluded,
    baselineStartGame: baseline.startGame,
    baselineEndGame: baseline.endGame,
    baselineStartTime: baseline.startTime,
    baselineEndTime: baseline.endTime,
    recentSlopePer100: latestBlock.slopePer100,
    blockSize,
    isActiveClimb,
    hardGapDaysBefore,
  };
}

function calculateClimbMetrics(allGames) {
  const chronological = [...allGames]
    .filter((game) => Number.isFinite(Number(game.gameNumber)) && Number.isFinite(Number(game.playerRating)))
    .sort((a, b) => Number(a.gameNumber) - Number(b.gameNumber));

  if (!chronological.length) {
    return {
      score: 0,
      label: "No data",
      sampleSize: 0,
      pacePer100: 0,
      calendarPacePer30: 0,
      hasCalendar30DayWindow: false,
      calendar30DayStartRating: NaN,
      calendar30DayEndRating: NaN,
      calendar30DayStartDate: null,
      calendar30DayEndDate: null,
      pressurePct: 0,
      positiveWindowPct: 0,
      positiveWindowSize: 0,
      maxDrawdown: 0,
      cadenceScore: 0,
      volumeRegularityScore: 0,
      activeWeekPct: 0,
      longestGapDays: 0,
      velocityScore: 0,
      calendarVelocityScore: 0,
      pressureScore: 0,
      consistencyScore: 0,
      drawdownScore: 0,
      climbStartGame: null,
      climbEndGame: null,
      climbStartDate: null,
      climbEndDate: null,
      climbDurationDays: 0,
      climbRatingGain: 0,
      recentSlopePer100: 0,
      isActiveClimb: false,
      hardGapDaysBefore: 0,
      detectorBlockSize: 0,
      baselineWindowSize: 0,
      baselineStartRating: 0,
      baselineEndRating: 0,
      preClimbBaselineRating: NaN,
      effectiveStartRating: 0,
      recoveredEloExcluded: 0,
      priorAccountPeak: 0,
      establishedHistoryStartGame: null,
      establishedHistoryStartDate: null,
      establishedHistoryDetected: false,
      placementGamesExcluded: 0,
      excludedPlacementPeak: NaN,
      newTerritoryGain: 0,
      recoveryGain: 0,
      meanClimbRating: 0,
      endVsMean: 0,
      rawScore: 0,
      scoreCap: 100,
      gainScore: 0,
      newTerritoryScore: 0,
    };
  }

  const detected = detectCurrentClimbWindow(chronological);
  const sample = detected.sample.length ? detected.sample : chronological.slice(-100);
  const baseline = representativeClimbEndpoints(sample);
  const baselineGameSpan = Math.max(1, baseline.endGame - baseline.startGame);
  const effectiveStartRating = Number.isFinite(detected.effectiveStartRating)
    ? detected.effectiveStartRating
    : baseline.startRating;
  const freshRatingGain = baseline.endRating - effectiveStartRating;

  // Distinguish rating recovery from genuinely new account territory, but do
  // not let provisional placement ratings define the account's lifetime peak.
  // Established history begins at the first sustained climb detected anywhere
  // on the account. Ratings before that point are still graphed and analyzed;
  // they are excluded only from the historical-peak/new-territory test.
  const establishedHistory = detectEstablishedRatingHistoryStart(chronological);
  const detectedStartIndexRaw = chronological.findIndex(
    (game) => Number(game.gameNumber) === Number(detected.startGame)
  );
  const detectedStartIndex = detectedStartIndexRaw >= 0 ? detectedStartIndexRaw : 0;
  const establishedStartIndex = establishedHistory.detected
    ? establishedHistory.startIndex
    : detectedStartIndex;
  const preClimbGames = detectedStartIndex > establishedStartIndex
    ? chronological.slice(establishedStartIndex, detectedStartIndex)
    : [];
  const preClimbRatings = preClimbGames
    .map((game) => Number(game.playerRating))
    .filter((rating) => Number.isFinite(rating));
  const priorAccountPeak = preClimbRatings.length
    ? Math.max(...preClimbRatings)
    : effectiveStartRating;
  const newTerritoryGain = Math.max(
    0,
    Math.min(freshRatingGain, baseline.endRating - priorAccountPeak)
  );
  const recoveryGain = Math.max(0, freshRatingGain - newTerritoryGain);

  const sampleRatings = sample
    .map((game) => Number(game.playerRating))
    .filter((rating) => Number.isFinite(rating));
  const meanClimbRating = sampleRatings.length
    ? sampleRatings.reduce((sum, rating) => sum + rating, 0) / sampleRatings.length
    : baseline.endRating;
  const endVsMean = baseline.endRating - meanClimbRating;
  const pacePer100 = (freshRatingGain / baselineGameSpan) * 100;

  const pressureSamples = sample
    .map((game) => {
      const playerRating = Number(game.playerRating);
      const opponentRating = Number(game.opponentRating);
      const actual = gameResultScore(game.result);
      if (!Number.isFinite(playerRating) || !Number.isFinite(opponentRating) || actual == null) return null;
      const expected = 1 / (1 + (10 ** ((opponentRating - playerRating) / 400)));
      return actual - expected;
    })
    .filter((value) => Number.isFinite(value));

  const pressurePct = pressureSamples.length
    ? (pressureSamples.reduce((sum, value) => sum + value, 0) / pressureSamples.length) * 100
    : 0;

  const windowSize = sample.length >= 50
    ? 50
    : Math.max(10, Math.floor(sample.length / 2));
  let positiveWindows = 0;
  let totalWindows = 0;
  if (sample.length >= windowSize && windowSize >= 2) {
    for (let start = 0; start + windowSize - 1 < sample.length; start += 1) {
      const first = Number(sample[start].playerRating);
      const last = Number(sample[start + windowSize - 1].playerRating);
      if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
      totalWindows += 1;
      if (last > first) positiveWindows += 1;
    }
  }
  const positiveWindowPct = totalWindows ? (positiveWindows / totalWindows) * 100 : 50;

  let peakRating = Number(sample[0]?.playerRating) || 0;
  let maxDrawdown = 0;
  for (const game of sample) {
    const rating = Number(game.playerRating);
    if (!Number.isFinite(rating)) continue;
    peakRating = Math.max(peakRating, rating);
    maxDrawdown = Math.max(maxDrawdown, peakRating - rating);
  }

  const DAY = 24 * 60 * 60 * 1000;
  const datedSample = sample
    .map((game) => ({
      ...game,
      timestamp: parseGameDate(game.date),
    }))
    .filter((game) => Number.isFinite(game.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp || Number(a.gameNumber) - Number(b.gameNumber));

  // Literal 30-day rating change. Do not extrapolate a shorter detected climb
  // to a 30-day pace: that badly inflates short rebound regimes. Rating is
  // treated as persistent between games, so the start value is the latest
  // recorded rating on or before the exact 30-day cutoff.
  const datedChronological = chronological
    .map((game) => ({
      ...game,
      timestamp: parseGameDate(game.date),
      rating: Number(game.playerRating),
    }))
    .filter((game) => Number.isFinite(game.timestamp) && Number.isFinite(game.rating))
    .sort((a, b) => a.timestamp - b.timestamp || Number(a.gameNumber) - Number(b.gameNumber));

  let calendarPacePer30 = 0;
  let hasCalendar30DayWindow = false;
  let calendar30DayStartRating = NaN;
  let calendar30DayEndRating = NaN;
  let calendar30DayStartDate = null;
  let calendar30DayEndDate = null;

  if (datedChronological.length >= 2) {
    const latest = datedChronological[datedChronological.length - 1];
    const targetTime = latest.timestamp - (30 * DAY);
    let start = null;
    for (let index = datedChronological.length - 1; index >= 0; index -= 1) {
      if (datedChronological[index].timestamp <= targetTime) {
        start = datedChronological[index];
        break;
      }
    }

    if (start) {
      hasCalendar30DayWindow = true;
      calendar30DayStartRating = start.rating;
      calendar30DayEndRating = latest.rating;
      calendar30DayStartDate = start.timestamp;
      calendar30DayEndDate = latest.timestamp;
      calendarPacePer30 = latest.rating - start.rating;
    }
  }

  let volumeRegularityScore = 50;
  let activeWeekPct = 50;
  let longestGapDays = 0;
  let cadenceScore = 50;

  if (datedSample.length >= 2) {
    const firstDay = Math.floor(datedSample[0].timestamp / DAY) * DAY;
    const lastDay = Math.floor(datedSample[datedSample.length - 1].timestamp / DAY) * DAY;
    const calendarDays = Math.max(1, Math.round((lastDay - firstDay) / DAY) + 1);

    const dailyCounts = Array(calendarDays).fill(0);
    for (const game of datedSample) {
      const dayIndex = clampNumber(Math.floor((game.timestamp - firstDay) / DAY), 0, calendarDays - 1);
      dailyCounts[dayIndex] += 1;
    }

    const dailyMean = dailyCounts.reduce((sum, value) => sum + value, 0) / dailyCounts.length;
    if (dailyMean > 0) {
      const dailyVariance = dailyCounts.reduce(
        (sum, value) => sum + ((value - dailyMean) ** 2),
        0
      ) / dailyCounts.length;
      const dailyCv = Math.sqrt(dailyVariance) / dailyMean;
      volumeRegularityScore = 100 / (1 + (dailyCv ** 2));
    }

    const totalWeeks = Math.max(1, Math.ceil(calendarDays / 7));
    const activeWeeks = new Set();
    const activeDayIndexes = [];
    for (let index = 0; index < dailyCounts.length; index += 1) {
      if (dailyCounts[index] <= 0) continue;
      activeDayIndexes.push(index);
      activeWeeks.add(Math.floor(index / 7));
    }
    activeWeekPct = (activeWeeks.size / totalWeeks) * 100;

    for (let index = 1; index < activeDayIndexes.length; index += 1) {
      longestGapDays = Math.max(
        longestGapDays,
        Math.max(0, activeDayIndexes[index] - activeDayIndexes[index - 1] - 1)
      );
    }

    // Gaps below the 90-day hard boundary remain part of the same climb, but
    // still reduce cadence progressively instead of being ignored.
    let gapScore = 100;
    if (longestGapDays > 14) gapScore -= (Math.min(longestGapDays, 30) - 14) * 1.25;
    if (longestGapDays > 30) gapScore -= (Math.min(longestGapDays, 60) - 30) * 1.0;
    if (longestGapDays > 60) gapScore -= (Math.min(longestGapDays, 90) - 60) * 1.5;
    gapScore = clampNumber(gapScore, 0, 100);

    cadenceScore = clampNumber(
      (volumeRegularityScore * 0.50)
        + (activeWeekPct * 0.30)
        + (gapScore * 0.20),
      0,
      100
    );
  }

  // Distance has two meanings: recovery-adjusted gain inside the regime and
  // genuinely new account territory above the pre-climb lifetime peak. New
  // territory receives more weight so a comeback to an old rating is not
  // scored like breaking into a level the account has never held before.
  const gainScore = clampNumber((Math.max(0, freshRatingGain) / 300) * 100, 0, 100);
  const newTerritoryScore = clampNumber((newTerritoryGain / 250) * 100, 0, 100);
  const velocityScore = clampNumber(50 + (pacePer100 * 0.5), 0, 100);
  const calendarVelocityScore = hasCalendar30DayWindow
    ? clampNumber(50 + (calendarPacePer30 * 0.5), 0, 100)
    : 50;
  const pressureScore = clampNumber(50 + (pressurePct * 5), 0, 100);
  const consistencyScore = clampNumber(positiveWindowPct, 0, 100);
  const drawdownScore = clampNumber(100 - ((maxDrawdown / 120) * 100), 0, 100);

  const rawScore = clampNumber(
    (newTerritoryScore * 0.20)
      + (gainScore * 0.10)
      + (velocityScore * 0.20)
      + (calendarVelocityScore * 0.15)
      + (cadenceScore * 0.15)
      + (pressureScore * 0.10)
      + (consistencyScore * 0.05)
      + (drawdownScore * 0.05),
    0,
    100
  );

  // The detected regime may still be historically a climb even when the
  // account is currently ending below the mean level of that regime. Keep the
  // regime classification, but prevent an ending trough/flatline from carrying
  // an elite climb score. A clearly negative local slope while below the mean
  // is treated as floundering; otherwise a below-mean finish is flatlining.
  let scoreCap = 100;
  if (endVsMean < 0) {
    scoreCap = detected.recentSlopePer100 < -10 ? 45 : 60;
  } else if (detected.recentSlopePer100 <= 10) {
    scoreCap = 70;
  }
  const score = Math.min(rawScore, scoreCap);
  const label = climbStateLabel({
    score,
    endVsMean,
    recentSlopePer100: detected.recentSlopePer100,
    newTerritoryGain,
  });

  return {
    score,
    rawScore,
    scoreCap,
    label,
    sampleSize: sample.length,
    pacePer100,
    calendarPacePer30,
    hasCalendar30DayWindow,
    calendar30DayStartRating,
    calendar30DayEndRating,
    calendar30DayStartDate,
    calendar30DayEndDate,
    pressurePct,
    positiveWindowPct,
    positiveWindowSize: windowSize,
    maxDrawdown,
    cadenceScore,
    volumeRegularityScore,
    activeWeekPct,
    longestGapDays,
    gainScore,
    newTerritoryScore,
    velocityScore,
    calendarVelocityScore,
    pressureScore,
    consistencyScore,
    drawdownScore,
    climbStartGame: detected.startGame,
    climbEndGame: detected.endGame,
    climbStartDate: detected.startDate,
    climbEndDate: detected.endDate,
    climbDurationDays: detected.durationDays,
    climbRatingGain: freshRatingGain,
    priorAccountPeak,
    establishedHistoryStartGame: establishedHistory.startGame,
    establishedHistoryStartDate: establishedHistory.startDate,
    establishedHistoryDetected: establishedHistory.detected,
    placementGamesExcluded: establishedHistory.detected ? establishedHistory.placementGamesExcluded : detectedStartIndex,
    excludedPlacementPeak: establishedHistory.excludedPlacementPeak,
    newTerritoryGain,
    recoveryGain,
    meanClimbRating,
    endVsMean,
    recentSlopePer100: detected.recentSlopePer100,
    isActiveClimb: detected.isActiveClimb,
    hardGapDaysBefore: detected.hardGapDaysBefore,
    detectorBlockSize: detected.blockSize,
    baselineWindowSize: baseline.windowSize,
    baselineStartRating: baseline.startRating,
    baselineEndRating: baseline.endRating,
    preClimbBaselineRating: detected.preClimbBaselineRating,
    effectiveStartRating,
    recoveredEloExcluded: detected.recoveredEloExcluded || 0,
  };
}

function phaseStatsToGamePatch(stats = {}) {
  return {
    playerOpeningAcpl: stats.player_opening_acpl ?? null,
    opponentOpeningAcpl: stats.opponent_opening_acpl ?? null,
    playerMiddlegameAcpl: stats.player_middlegame_acpl ?? null,
    opponentMiddlegameAcpl: stats.opponent_middlegame_acpl ?? null,
    playerEndgameAcpl: stats.player_endgame_acpl ?? null,
    opponentEndgameAcpl: stats.opponent_endgame_acpl ?? null,
    playerOpeningBlunders: Number(stats.player_opening_blunders || 0),
    opponentOpeningBlunders: Number(stats.opponent_opening_blunders || 0),
    playerMiddlegameBlunders: Number(stats.player_middlegame_blunders || 0),
    opponentMiddlegameBlunders: Number(stats.opponent_middlegame_blunders || 0),
    playerEndgameBlunders: Number(stats.player_endgame_blunders || 0),
    opponentEndgameBlunders: Number(stats.opponent_endgame_blunders || 0),
    playerOpeningMoves: Number(stats.player_opening_moves || 0),
    opponentOpeningMoves: Number(stats.opponent_opening_moves || 0),
    playerMiddlegameMoves: Number(stats.player_middlegame_moves || 0),
    opponentMiddlegameMoves: Number(stats.opponent_middlegame_moves || 0),
    playerEndgameMoves: Number(stats.player_endgame_moves || 0),
    opponentEndgameMoves: Number(stats.opponent_endgame_moves || 0),
  };
}

export default function App() {
  const [games, setGames] = useState([]);
  const [moves, setMoves] = useState([]);
  const [expandedGame, setExpandedGame] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [gamePage, setGamePage] = useState(1);
  const GAMES_PER_PAGE = 15;
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem(USERNAME_STORAGE_KEY)?.trim() || "ProtoX09";
    } catch {
      return "ProtoX09";
    }
  });
  const [timeClass, setTimeClass] = useState(() => {
    try {
      const saved = localStorage.getItem(TIME_CLASS_STORAGE_KEY);
      return saved === "blitz" ? "blitz" : "rapid";
    } catch {
      return "rapid";
    }
  });
  const [engineNodes, setEngineNodes] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(ENGINE_NODES_STORAGE_KEY));
      return [5000, 12000, 30000].includes(saved) ? saved : 12000;
    } catch {
      return 12000;
    }
  });
  const [syncing, setSyncing] = useState(false);
  const [syncJob, setSyncJob] = useState(null);
  const [chartRangeSelection, setChartRangeSelection] = useState(null);
  const [chartWindowMode, setChartWindowMode] = useState("games");
  const [chartWindowRanges, setChartWindowRanges] = useState({});
  const abortRef = useRef(null);
  const phaseRefreshTokenRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(USERNAME_STORAGE_KEY, username);
    } catch {
      // Local storage is optional; the dashboard still works without it.
    }
  }, [username]);

  useEffect(() => {
    try {
      localStorage.setItem(TIME_CLASS_STORAGE_KEY, timeClass);
    } catch {
      // Local storage is optional.
    }
  }, [timeClass]);

  useEffect(() => {
    try {
      localStorage.setItem(ENGINE_NODES_STORAGE_KEY, String(engineNodes));
    } catch {
      // Local storage is optional.
    }
  }, [engineNodes]);

  useEffect(() => {
    if (!chartRangeSelection) return undefined;

    const clearRangeOutsideCharts = (event) => {
      if (event.target?.closest?.(".range-chart-shell")) return;
      setChartRangeSelection(null);
    };

    document.addEventListener("pointerdown", clearRangeOutsideCharts);
    return () => document.removeEventListener("pointerdown", clearRangeOutsideCharts);
  }, [chartRangeSelection]);

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    setError("");
    setStatus("Loading CSV files...");

    try {
      let nextGames = games;
      let nextMoves = moves;

      for (const file of files) {
        const rows = await parseCSV(file);

        if (isMovesRows(rows)) {
          nextMoves = normalizeMoves(rows);
        } else if (isGamesRows(rows)) {
          nextGames = normalizeGames(rows);
        } else {
          throw new Error(
            `${file.name} does not match the expected games or moves schema.`
          );
        }
      }

      setGames(nextGames);
      setMoves(nextMoves);
      setExpandedGame(null);
      setStatus("");

      if (!nextGames.length && nextMoves.length) {
        setError("Moves loaded, but no games CSV is loaded yet.");
      }
    } catch (e) {
      setError(e.message || "Could not load CSV.");
      setStatus("");
    }
  }

  async function refreshPhaseCacheInBackground(player, selectedTimeClass, signal = null) {
    const normalizedPlayer = String(player || "").trim().toLowerCase();
    if (!normalizedPlayer) return;
    const refreshToken = ++phaseRefreshTokenRef.current;

    try {
      const result = await backfillPhaseCache(normalizedPlayer, selectedTimeClass, {
        signal,
        onProgress: ({ updates = [] }) => {
          if (!updates.length || signal?.aborted || refreshToken !== phaseRefreshTokenRef.current) return;
          const updatesByGame = new Map(updates.map((item) => [item.gameNumber, item.phaseStats]));
          setGames((currentGames) => currentGames.map((game) => {
            const phaseStats = updatesByGame.get(game.gameNumber);
            return phaseStats
              ? { ...game, ...phaseStatsToGamePatch(phaseStats) }
              : game;
          }));
        },
      });
      if (!result.updated || signal?.aborted || refreshToken !== phaseRefreshTokenRef.current) return;

      const refreshed = await loadDashboardRows(normalizedPlayer, selectedTimeClass);
      if (signal?.aborted || refreshToken !== phaseRefreshTokenRef.current) return;
      setGames(normalizeGames(refreshed.games || []));
      setMoves(normalizeMoves(refreshed.moves || []));
    } catch (phaseError) {
      if (phaseError?.name !== "AbortError") {
        console.warn("Phase cache backfill was unavailable:", phaseError);
      }
    }
  }

  async function loadPlayerData(player, selectedTimeClass = timeClass) {
    const normalizedPlayer = player.trim().toLowerCase();
    const data = await loadDashboardRows(normalizedPlayer, selectedTimeClass);
    const nextGames = normalizeGames(data.games || []);
    const nextMoves = normalizeMoves(data.moves || []);
    setGames(nextGames);
    setMoves(nextMoves);
    setExpandedGame(null);
    setGamePage(1);
    void refreshPhaseCacheInBackground(normalizedPlayer, selectedTimeClass);
    return nextGames.length;
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function autoLoadStoredData() {
      const player = username.trim().toLowerCase();
      if (!player) return;

      try {
        // Cross-device restore happens before the dashboard reads IndexedDB.
        // This prevents a fresh phone/browser from looking empty while archived
        // games already exist remotely.
        let remote = null;
        try {
          remote = await hydrateProfileFromRemote({
            username: player,
            timeClass,
            signal: controller.signal,
          });
        } catch (remoteError) {
          if (remoteError?.name === "AbortError") return;
          console.warn("Shared cache was not auto-hydrated:", remoteError);
        }

        const data = await loadDashboardRows(player, timeClass);
        if (cancelled) return;
        const nextGames = normalizeGames(data.games || []);
        setGames(nextGames);
        setMoves(normalizeMoves(data.moves || []));
        void refreshPhaseCacheInBackground(player, timeClass, controller.signal);

        if (remote?.found) {
          setStatus(`Hydrated ${Number(remote.hydrated || remote.available || 0).toLocaleString()} archived ${timeClass} games from remote cache.`);
        }

        // Self-heal older local-only datasets. Opening the dashboard is enough
        // to archive any records that predate the shared-cache implementation.
        if (nextGames.length) {
          try {
            const archive = await uploadProfileSnapshot({
              username: player,
              timeClass,
              nodes: engineNodes,
            });
            if (!cancelled && Number(archive?.uploadedCount || 0) > 0) {
              setStatus(
                `Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games · archived ${Number(archive.uploadedCount).toLocaleString()} previously local-only game(s) remotely.`
              );
            }
          } catch (archiveError) {
            console.warn("Automatic archive repair was unavailable:", archiveError);
          }
        }
      } catch (e) {
        if (e?.name !== "AbortError") console.debug("Browser cache was not auto-loaded:", e);
      }
    }
    autoLoadStoredData();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  async function changeTimeClass(nextTimeClass) {
    if (syncing) return;
    setTimeClass(nextTimeClass);
    setError("");
    setStatus("");
    try {
      const player = username.trim().toLowerCase();
      const remote = await hydrateProfileFromRemote({
        username: player,
        timeClass: nextTimeClass,
      });
      const count = await loadPlayerData(username, nextTimeClass);
      if (!count) {
        setGames([]);
        setMoves([]);
      } else if (remote?.found) {
        setStatus(`Hydrated ${Number(remote.hydrated || remote.available || 0).toLocaleString()} archived ${nextTimeClass} games from remote cache.`);
      }
    } catch (e) {
      setGames([]);
      setMoves([]);
      setExpandedGame(null);
      setGamePage(1);
      setError(e?.message || "Could not restore the shared/browser cache.");
    }
  }

  async function syncPlayer(fullRescan = false) {
    const player = username.trim();
    if (!player || syncing) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setStatus("");
    setSyncing(true);
    setSyncJob({
      username: player,
      timeClass,
      fullRescan,
      phase: "starting",
      message: "Starting browser analysis...",
      current: 0,
      total: 0,
      percent: 0,
      archives: [],
      logs: [],
    });

    try {
      const data = await browserSync({
        username: player,
        timeClass,
        nodes: engineNodes,
        fullRescan,
        signal: controller.signal,
        onProgress: (progress) => {
          setSyncJob((prev) => ({
            ...(prev || {}),
            ...progress,
            username: player,
            timeClass,
            fullRescan,
          }));
        },
      });

      const nextGames = normalizeGames(data.games || []);
      const nextMoves = normalizeMoves(data.moves || []);
      setGames(nextGames);
      setMoves(nextMoves);
      setExpandedGame(null);
      setGamePage(1);
      void refreshPhaseCacheInBackground(player, timeClass, controller.signal);

      const analyzedThisRun = Number(data.syncMeta?.analyzedGames || 0);
      if (analyzedThisRun > 0) {
        try {
          const archive = await uploadProfileSnapshot({
            username: player,
            timeClass,
            nodes: engineNodes,
          });
          setStatus(
            `Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games · archived ${Number(archive.recordCount || nextGames.length).toLocaleString()} games remotely.`
          );
        } catch (archiveError) {
          setStatus(`Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games from browser storage.`);
          setError(`Analysis succeeded, but remote archive failed: ${archiveError?.message || "unknown error"}`);
        }
      } else {
        const sharedThisRun = Number(data.syncMeta?.sharedGames || 0);
        if (sharedThisRun > 0) {
          setStatus(
            `Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games · reused ${sharedThisRun.toLocaleString()} game(s) from the shared analysis cache · no Stockfish re-analysis needed for those games.`
          );
        } else {
          setStatus(`Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games from browser storage.`);
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        try {
          const count = await loadPlayerData(player, timeClass);

          if (count > 0) {
            try {
              const archive = await uploadProfileSnapshot({
                username: player,
                timeClass,
                nodes: engineNodes,
              });
              setStatus(
                `Analysis cancelled safely. ${count.toLocaleString()} completed games are saved in this browser · archived ${Number(archive.recordCount || count).toLocaleString()} games remotely.`
              );
            } catch (archiveError) {
              setStatus(
                `Analysis cancelled. ${count.toLocaleString()} completed games are saved in this browser, but the remote archive could not be updated.`
              );
              setError(`Cancel succeeded locally, but remote archive failed: ${archiveError?.message || "unknown error"}`);
            }
          } else {
            setStatus("Analysis cancelled. No completed games were available to archive.");
          }
        } catch {
          setStatus("Analysis cancelled.");
        }
      } else {
        setError(e?.message || "Browser analysis failed.");
      }
    } finally {
      abortRef.current = null;
      setSyncing(false);
    }
  }

  function cancelSync() {
    if (!syncing) return;
    setSyncJob((job) => job ? { ...job, phase: "cancelling", message: "Cancelling after the current Stockfish search..." } : job);
    abortRef.current?.abort();
  }

  function clearData() {
    setGames([]);
    setMoves([]);
    setExpandedGame(null);
    setStatus("Dashboard cleared.");
    setError("");
  }

  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();

    return games
      .filter((g) => {
        const resultOK = filter === "all" || g.result === filter;
        const opponent =
          g.playerColor.toLowerCase() === "white" ? g.black : g.white;

        const searchOK =
          !q ||
          opponent.toLowerCase().includes(q) ||
          String(g.gameNumber).includes(q) ||
          g.date.toLowerCase().includes(q);

        return resultOK && searchOK;
      })
      .sort((a, b) => b.gameNumber - a.gameNumber);
  }, [games, filter, search]);

  const totalGamePages = Math.max(
    1,
    Math.ceil(filteredGames.length / GAMES_PER_PAGE)
  );

  const pagedGames = useMemo(() => {
    const start = (gamePage - 1) * GAMES_PER_PAGE;
    return filteredGames.slice(start, start + GAMES_PER_PAGE);
  }, [filteredGames, gamePage]);

  useEffect(() => {
    setGamePage((page) => Math.min(Math.max(1, page), totalGamePages));
  }, [totalGamePages]);

  const chartWindowBounds = useMemo(() => {
    if (!games.length) return null;

    const gameNumbers = games.map((game) => Number(game.gameNumber)).filter(Number.isFinite);
    const ratings = games.map((game) => Number(game.playerRating)).filter(Number.isFinite);
    const dates = games.map((game) => parseGameDate(game.date)).filter(Number.isFinite);

    if (!gameNumbers.length || !ratings.length || !dates.length) return null;

    return {
      games: {
        min: Math.min(...gameNumbers),
        max: Math.max(...gameNumbers),
        step: 1,
      },
      rating: {
        min: Math.floor(Math.min(...ratings)),
        max: Math.ceil(Math.max(...ratings)),
        step: 1,
      },
      date: {
        min: Math.min(...dates),
        max: Math.max(...dates),
        step: 24 * 60 * 60 * 1000,
      },
    };
  }, [games]);

  const chartWindows = useMemo(() => {
    if (!chartWindowBounds) return null;

    const resolved = {};
    for (const mode of ["games", "date", "rating"]) {
      const bounds = chartWindowBounds[mode];
      const saved = chartWindowRanges[mode];
      if (!saved) {
        resolved[mode] = { min: bounds.min, max: bounds.max };
        continue;
      }

      const low = clampNumber(Number(saved.min), bounds.min, bounds.max);
      const high = clampNumber(Number(saved.max), bounds.min, bounds.max);
      resolved[mode] = {
        min: Math.min(low, high),
        max: Math.max(low, high),
      };
    }

    return resolved;
  }, [chartWindowBounds, chartWindowRanges]);

  const activeChartWindow = chartWindows?.[chartWindowMode] || null;

  const chartGames = useMemo(() => {
    if (!chartWindows) return games;

    return games.filter((game) => {
      const gameNumber = Number(game.gameNumber);
      const rating = Number(game.playerRating);
      const date = parseGameDate(game.date);

      if (!Number.isFinite(gameNumber) || !Number.isFinite(rating) || !Number.isFinite(date)) {
        return false;
      }

      return gameNumber >= chartWindows.games.min
        && gameNumber <= chartWindows.games.max
        && date >= chartWindows.date.min
        && date <= chartWindows.date.max
        && rating >= chartWindows.rating.min
        && rating <= chartWindows.rating.max;
    });
  }, [games, chartWindows]);

  const chartWindowFilteredByMode = useMemo(() => {
    if (!chartWindowBounds || !chartWindows) return {};

    const result = {};
    for (const mode of ["games", "date", "rating"]) {
      const bounds = chartWindowBounds[mode];
      const range = chartWindows[mode];
      result[mode] = range.min > bounds.min || range.max < bounds.max;
    }
    return result;
  }, [chartWindowBounds, chartWindows]);

  const chartWindowFiltered = Boolean(chartWindowFilteredByMode[chartWindowMode]);
  const anyChartWindowFiltered = Object.values(chartWindowFilteredByMode).some(Boolean);

  const chartWindowIsLast100 = useMemo(() => {
    const range = chartWindows?.games;
    const bounds = chartWindowBounds?.games;
    if (!range || !bounds) return false;
    const recentMin = Math.max(bounds.min, bounds.max - 99);
    return range.min === recentMin && range.max === bounds.max;
  }, [chartWindows, chartWindowBounds]);

  const chartWindowSummary = useMemo(() => {
    if (!chartWindows) return "";

    const parts = [];
    if (chartWindowFilteredByMode.games) {
      parts.push(`Games ${Math.round(chartWindows.games.min)}–${Math.round(chartWindows.games.max)}`);
    }
    if (chartWindowFilteredByMode.date) {
      parts.push(`${formatWindowDate(chartWindows.date.min)} – ${formatWindowDate(chartWindows.date.max)}`);
    }
    if (chartWindowFilteredByMode.rating) {
      parts.push(`${Math.round(chartWindows.rating.min)}–${Math.round(chartWindows.rating.max)} Elo`);
    }
    if (!parts.length) parts.push("All games");

    return `${parts.join(" · ")} · ${chartGames.length.toLocaleString()} of ${games.length.toLocaleString()} games`;
  }, [chartWindows, chartWindowFilteredByMode, chartGames.length, games.length]);

  const setChartWindow = (nextMin, nextMax) => {
    const bounds = chartWindowBounds?.[chartWindowMode];
    if (!bounds) return;

    const min = clampNumber(Number(nextMin), bounds.min, bounds.max);
    const max = clampNumber(Number(nextMax), bounds.min, bounds.max);
    setChartWindowRanges((current) => ({
      ...current,
      [chartWindowMode]: {
        min: Math.min(min, max),
        max: Math.max(min, max),
      },
    }));
    setChartRangeSelection(null);
  };

  const resetActiveChartWindow = () => {
    const bounds = chartWindowBounds?.[chartWindowMode];
    if (!bounds) return;
    setChartWindowRanges((current) => ({
      ...current,
      [chartWindowMode]: { min: bounds.min, max: bounds.max },
    }));
    setChartRangeSelection(null);
  };

  const showFullChartWindow = () => {
    if (!chartWindowBounds) return;
    setChartWindowRanges({
      games: { min: chartWindowBounds.games.min, max: chartWindowBounds.games.max },
      date: { min: chartWindowBounds.date.min, max: chartWindowBounds.date.max },
      rating: { min: chartWindowBounds.rating.min, max: chartWindowBounds.rating.max },
    });
    setChartRangeSelection(null);
  };

  const showLast100Games = () => {
    const bounds = chartWindowBounds?.games;
    if (!bounds) return;
    setChartWindowRanges((current) => ({
      ...current,
      games: {
        min: Math.max(bounds.min, bounds.max - 99),
        max: bounds.max,
      },
    }));
    setChartRangeSelection(null);
  };

  const chartWindowPct = (value) => {
    const bounds = chartWindowBounds?.[chartWindowMode];
    if (!bounds || bounds.max === bounds.min) return 0;
    return ((value - bounds.min) / (bounds.max - bounds.min)) * 100;
  };

  const chartDateYears = useMemo(() => {
    if (!chartWindowBounds?.date) return [];
    const start = utcDateParts(chartWindowBounds.date.min).year;
    const end = utcDateParts(chartWindowBounds.date.max).year;
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [chartWindowBounds]);

  const updateChartDatePart = (edge, part, value) => {
    if (!activeChartWindow || !chartWindowBounds?.date) return;
    const current = edge === "min" ? activeChartWindow.min : activeChartWindow.max;
    let next = timestampWithDatePart(current, part, value);
    next = clampNumber(next, chartWindowBounds.date.min, chartWindowBounds.date.max);

    if (edge === "min") {
      next = Math.min(next, activeChartWindow.max);
      setChartWindow(next, activeChartWindow.max);
    } else {
      next = Math.max(next, activeChartWindow.min);
      setChartWindow(activeChartWindow.min, next);
    }
  };

  const chartData = useMemo(() => {
    const ordered = [...chartGames].sort((a, b) => a.gameNumber - b.gameNumber);
    if (!ordered.length) return [];

    // Target roughly 20 plotted points regardless of dataset size.
    // Example: 1,000 games -> 50 games per plotted point.
    const bucketSize = Math.max(1, Math.ceil(ordered.length / 20));
    const points = [];

    for (let start = 0; start < ordered.length; start += bucketSize) {
      const bucket = ordered.slice(start, start + bucketSize);
      const first = bucket[0];
      const last = bucket[bucket.length - 1];

      const average = (key) =>
        bucket.reduce((sum, game) => sum + num(game[key]), 0) / bucket.length;

      const playerAcpls = bucket.map((g) => g.playerAcpl);
      const opponentAcpls = bucket.map((g) => g.opponentAcpl);
      const playerPractical = bucket.map((g) => g.playerPracticalBlunders);

      const playerAcplQuartiles = quartiles(playerAcpls);
      const practicalQuartileAverages = quartileAverages(playerPractical);

      const phaseMetric = (phase) => {
        const cap = phase[0].toUpperCase() + phase.slice(1);
        let weightedLoss = 0;
        let acplMoves = 0;
        let blunders = 0;
        let mateBlunders = 0;
        let normalBlunders = 0;

        for (const game of bucket) {
          const movesInPhase = num(game[`player${cap}Moves`]);
          const acpl = game[`player${cap}Acpl`];
          const phaseBlunders = num(game[`player${cap}Blunders`]);
          const phaseMateBlunders = num(game[`player${cap}MateBlunders`]);
          const phaseNormalBlunders = num(game[`player${cap}NormalBlunders`]);

          blunders += phaseBlunders;
          mateBlunders += phaseMateBlunders;
          normalBlunders += phaseNormalBlunders;
          if (movesInPhase > 0 && Number.isFinite(acpl)) {
            weightedLoss += acpl * movesInPhase;
            acplMoves += movesInPhase;
          }
        }

        return {
          acpl: acplMoves ? Number((weightedLoss / acplMoves).toFixed(2)) : null,
          blunders,
          mateBlunders,
          normalBlunders,
        };
      };

      const opening = phaseMetric('opening');
      const middlegame = phaseMetric('middlegame');
      const endgame = phaseMetric('endgame');

      points.push({
        game: last.gameNumber,
        range: `${first.gameNumber}-${last.gameNumber}`,
        gamesInBucket: bucket.length,

        rating: Number(average("playerRating").toFixed(1)),

        acplAvg: Number(average("playerAcpl").toFixed(2)),
        acplQ1: Number(playerAcplQuartiles.q1.toFixed(2)),
        acplMedian: Number(playerAcplQuartiles.median.toFixed(2)),
        acplQ3: Number(playerAcplQuartiles.q3.toFixed(2)),

        blunderAvg: Number(
          (playerPractical.reduce((a, b) => a + b, 0) / playerPractical.length).toFixed(3)
        ),
        blunderBottom25Avg: Number(
          practicalQuartileAverages.bottom25Avg.toFixed(3)
        ),
        blunderTop25Avg: Number(
          practicalQuartileAverages.top25Avg.toFixed(3)
        ),
        zeroPracticalBlunderPct: Number(
          (
            100 *
            bucket.filter((g) => g.playerPracticalBlunders === 0).length /
            bucket.length
          ).toFixed(1)
        ),
        openingAcpl: opening.acpl,
        middlegameAcpl: middlegame.acpl,
        endgameAcpl: endgame.acpl,
        openingBlunders: opening.blunders,
        middlegameBlunders: middlegame.blunders,
        endgameBlunders: endgame.blunders,
        openingMateBlunders: opening.mateBlunders,
        middlegameMateBlunders: middlegame.mateBlunders,
        endgameMateBlunders: endgame.mateBlunders,
        openingNormalBlunders: opening.normalBlunders,
        middlegameNormalBlunders: middlegame.normalBlunders,
        endgameNormalBlunders: endgame.normalBlunders,
      });
    }

    return points;
  }, [chartGames]);

  const blunderYAxisMax = useMemo(() => {
    const values = chartData.flatMap((point) => [
      point.blunderAvg,
      point.blunderTop25Avg,
      point.blunderBottom25Avg,
    ]).filter(Number.isFinite);

    if (!values.length) return 1;

    const maxValue = Math.max(...values);
    const padded = maxValue * 1.08;
    return Math.max(0.5, Math.ceil(padded * 4) / 4);
  }, [chartData]);

  const stats = useMemo(() => {
    const wins = games.filter((g) => g.result === "win").length;
    const losses = games.filter((g) => g.result === "loss").length;
    const draws = games.filter((g) => g.result === "draw").length;

    const chronological = [...games].sort(
      (a, b) => a.gameNumber - b.gameNumber
    );
    const latest = chronological[chronological.length - 1];
    const climb = calculateClimbMetrics(games);

    return {
      wins,
      losses,
      draws,
      latestRating: latest?.playerRating ?? 0,
      climb,
    };
  }, [games]);

  const movesByGame = useMemo(() => {
    const map = new Map();

    for (const move of moves) {
      if (!map.has(move.gameNumber)) map.set(move.gameNumber, []);
      map.get(move.gameNumber).push(move);
    }

    return map;
  }, [moves]);

  const distribution = useMemo(() => ({
    acpl: quartiles(games.map((g) => g.playerAcpl)),
  }), [games]);

  return (
    <div className="app">
<header className="header">
        <div className="header-inner">
          <div>
            <h1>{username.trim() || "Chess"} Dashboard</h1>
            <div className="subtitle">
              Longitudinal chess analysis · runs entirely in your browser
            </div>
          </div>

          <div className="actions">
            <input
              className="player-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") syncPlayer(false);
              }}
              placeholder="Chess.com username"
              aria-label="Chess.com username"
            />

            <select
              className="player-input time-class-select"
              value={timeClass}
              onChange={(e) => changeTimeClass(e.target.value)}
              disabled={syncing}
              aria-label="Chess.com time class"
              title="Rated games only"
            >
              <option value="rapid">Rapid</option>
              <option value="blitz">Blitz</option>
            </select>

            <select
              className="player-input engine-select"
              value={engineNodes}
              onChange={(e) => setEngineNodes(Number(e.target.value))}
              disabled={syncing}
              aria-label="Browser Stockfish work per position"
              title="Stockfish 18 lite, single-threaded"
            >
              <option value={5000}>Fast · 5k nodes</option>
              <option value={12000}>Standard · 12k</option>
              <option value={30000}>Deep · 30k</option>
            </select>

            <button
              className="button primary"
              onClick={() => syncPlayer(false)}
              disabled={syncing || !username.trim()}
            >
              <RefreshCw size={16} className={syncing ? "spin" : ""} />
              {syncing ? "Syncing..." : "Sync"}
            </button>

            <button
              className="button"
              onClick={() => syncPlayer(true)}
              disabled={syncing || !username.trim()}
              title="Clear and reanalyze every rated game in the selected time class inside this browser"
            >
              Full rescan
            </button>

            {syncing && (
              <button className="button danger" onClick={cancelSync}>
                Cancel
              </button>
            )}

            <label className="button">
              <Upload size={16} />
              Load CSVs
              <input
                type="file"
                accept=".csv"
                multiple
                hidden
                onChange={(e) => loadFiles(e.target.files)}
              />
            </label>

            <button className="button" onClick={clearData}>
              <RefreshCw size={16} />
              Clear
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        {status && <div className="notice">{status}</div>}
        {error && <div className="notice error">{error}</div>}

        {syncJob && syncing && (
          <section className="sync-progress card">
            <div className="sync-progress-head">
              <div>
                <div className="sync-title">
                  {syncJob.fullRescan ? "Full rescan" : "Syncing"} {syncJob.username} · rated {syncJob.timeClass || timeClass}
                </div>
                <div className="sync-phase">{syncJob.message || syncJob.phase}</div>
              </div>
              <div className="sync-percent">
                {Number(syncJob.percent || 0).toFixed(1)}%
              </div>
            </div>

            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.max(0, Math.min(100, Number(syncJob.percent || 0)))}%` }}
              />
            </div>

            <div className="sync-stats">
              <span>
                Games: {Number(syncJob.current || 0).toLocaleString()} / {Number(syncJob.total || 0).toLocaleString()}
              </span>
              <span>
                Found: {syncJob.missingGames == null ? "—" : Number(syncJob.missingGames).toLocaleString()}
              </span>
              <span>
                Speed: {syncJob.rate == null ? "—" : `${Number(syncJob.rate).toFixed(2)} games/s`}
              </span>
              <span>
                ETA: {syncJob.etaMinutes == null ? "—" : `${Number(syncJob.etaMinutes).toFixed(1)} min`}
              </span>
            </div>

            {!!syncJob.archives?.length && (
              <div className="archive-summary">
                {syncJob.archives.map((archive) => (
                  <span key={archive.month}>
                    {archive.month}: {archive.games} games · {archive.missing} new
                  </span>
                ))}
              </div>
            )}

            {!!syncJob.logs?.length && (
              <pre className="sync-log">{syncJob.logs.slice(-8).join("\n")}</pre>
            )}
          </section>
        )}

        {games.length ? (
          <>
            <section className="metrics">
              <Metric
                icon={Trophy}
                label="Current rating"
                value={stats.latestRating}
                sub={`${games.length} analyzed games`}
              />

              <Metric
                icon={Target}
                label="Record"
                value={`${stats.wins}-${stats.losses}-${stats.draws}`}
                sub={`${games.length ? ((stats.wins / games.length) * 100).toFixed(1) : 0}% wins`}
              />

              <Metric
                icon={Gauge}
                label="Climb score"
                value={`${Math.round(stats.climb.score)}/100`}
                sub={`${stats.climb.label} · ${stats.climb.sampleSize.toLocaleString()}-game detected regime`}
                title={`Detected climb: game ${stats.climb.climbStartGame ?? "—"} to ${stats.climb.climbEndGame ?? "—"}${Number.isFinite(stats.climb.climbStartDate) && Number.isFinite(stats.climb.climbEndDate) ? ` (${formatWindowDate(stats.climb.climbStartDate)} – ${formatWindowDate(stats.climb.climbEndDate)})` : ""}. Recovery-adjusted gain: ${stats.climb.climbRatingGain >= 0 ? "+" : ""}${Math.round(stats.climb.climbRatingGain)} Elo across ${stats.climb.climbDurationDays || "—"} days. Established pre-climb peak: ${Math.round(stats.climb.priorAccountPeak)}; new rating territory: +${Math.round(stats.climb.newTerritoryGain)} Elo; recovery inside the regime: ${Math.round(stats.climb.recoveryGain)} Elo. ${stats.climb.establishedHistoryDetected ? `Placement/stabilization excluded through game ${Math.max(0, (stats.climb.establishedHistoryStartGame || 1) - 1)} (${stats.climb.placementGamesExcluded.toLocaleString()} game${stats.climb.placementGamesExcluded === 1 ? "" : "s"}); established rating history begins at game ${stats.climb.establishedHistoryStartGame}${Number.isFinite(stats.climb.establishedHistoryStartDate) ? ` on ${formatWindowDate(stats.climb.establishedHistoryStartDate)}` : ""}${Number.isFinite(stats.climb.excludedPlacementPeak) ? `, ignoring an initial placement/stabilization peak of ${Math.round(stats.climb.excludedPlacementPeak)}` : ""}` : `No earlier sustained climb was detected before the current regime, so provisional pre-climb placement ratings are not used as the account peak`}. The detected edge median was ${Math.round(stats.climb.baselineStartRating)} → ${Math.round(stats.climb.baselineEndRating)}; ${Number.isFinite(stats.climb.preClimbBaselineRating) ? `the immediately preceding local baseline was ${Math.round(stats.climb.preClimbBaselineRating)}, so the effective climb start is ${Math.round(stats.climb.effectiveStartRating)} and ${Math.round(stats.climb.recoveredEloExcluded)} trough-recovery Elo is excluded` : `no prior in-era baseline was available, so the edge median ${Math.round(stats.climb.effectiveStartRating)} is used as the effective climb start`}. Mean rating during the detected regime: ${stats.climb.meanClimbRating.toFixed(1)}; end baseline is ${stats.climb.endVsMean >= 0 ? "+" : ""}${stats.climb.endVsMean.toFixed(1)} Elo versus that mean. Status: ${stats.climb.label}${stats.climb.scoreCap < 100 ? `; score capped at ${stats.climb.scoreCap}/100 because the regime is currently ${stats.climb.label.toLowerCase()}` : ""}. The detector allows short plateaus but treats any inactivity gap over 90 days as a hard break. Score breakdown — new territory: ${stats.climb.newTerritoryScore.toFixed(0)}/100, total recovery-adjusted gain: ${stats.climb.gainScore.toFixed(0)}/100, Elo / 100 games: ${stats.climb.velocityScore.toFixed(0)}/100, literal 30-day Elo change: ${stats.climb.calendarVelocityScore.toFixed(0)}/100, cadence: ${stats.climb.cadenceScore.toFixed(0)}/100, results vs expectation: ${stats.climb.pressureScore.toFixed(0)}/100, positive-window consistency: ${stats.climb.consistencyScore.toFixed(0)}/100, drawdown control: ${stats.climb.drawdownScore.toFixed(0)}/100. Cadence details — daily-volume regularity: ${stats.climb.volumeRegularityScore.toFixed(0)}/100, active weeks: ${stats.climb.activeWeekPct.toFixed(0)}%, longest inactivity gap: ${stats.climb.longestGapDays} day${stats.climb.longestGapDays === 1 ? "" : "s"}.`}
              />

              <Metric
                icon={TrendingUp}
                label="Climb pace"
                value={`${stats.climb.pacePer100 >= 0 ? "+" : ""}${stats.climb.pacePer100.toFixed(1)} Elo`}
                sub={`${stats.climb.hasCalendar30DayWindow ? `${stats.climb.calendarPacePer30 >= 0 ? "+" : ""}${stats.climb.calendarPacePer30.toFixed(1)} Elo / 30 days` : "30-day history unavailable"} · cadence ${stats.climb.cadenceScore.toFixed(0)}/100`}
                title={`Across the detected ${stats.climb.sampleSize}-game regime: ${stats.climb.positiveWindowPct.toFixed(0)}% of ${stats.climb.positiveWindowSize}-game windows are positive, results are ${stats.climb.pressurePct >= 0 ? "+" : ""}${stats.climb.pressurePct.toFixed(1)} percentage points versus Elo expectation, maximum drawdown is ${Math.round(stats.climb.maxDrawdown)} Elo, and the longest inactivity gap is ${stats.climb.longestGapDays} day${stats.climb.longestGapDays === 1 ? "" : "s"}. ${stats.climb.hasCalendar30DayWindow ? `Literal 30-day rating change: ${Math.round(stats.climb.calendar30DayStartRating)} → ${Math.round(stats.climb.calendar30DayEndRating)} (${stats.climb.calendarPacePer30 >= 0 ? "+" : ""}${stats.climb.calendarPacePer30.toFixed(1)} Elo), using the last recorded rating on or before ${formatWindowDate(stats.climb.calendar30DayEndDate - (30 * 24 * 60 * 60 * 1000))}.` : "A full 30-day rating history is not available, so the calendar-speed score is neutral."} Recent local slope is ${stats.climb.recentSlopePer100 >= 0 ? "+" : ""}${stats.climb.recentSlopePer100.toFixed(1)} Elo / 100 games; the current regime is ${stats.climb.isActiveClimb ? "still climbing" : "flat or declining"}.`}
              />

              <Metric
                icon={Database}
                label="Move records"
                value={`${moves.length.toLocaleString()} moves`}
                sub={`from ${games.length.toLocaleString()} games`}
              />
            </section>


            {chartWindowBounds && activeChartWindow && (
              <section className="chart-window" aria-label="Graph data window">
                <div className="chart-window-header">
                  <div>
                    <div className="chart-window-title">Graph data window</div>
                    <div className="chart-window-summary">
                      {chartWindowSummary}
                    </div>
                  </div>

                  <div className="chart-window-actions">
                    <div className="chart-window-modes" role="group" aria-label="Filter graphs by">
                      {[
                        ["games", "Games"],
                        ["date", "Date"],
                        ["rating", "Rating"],
                      ].map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          className={`chart-window-mode ${chartWindowMode === mode ? "active" : ""} ${chartWindowFilteredByMode[mode] ? "filtered" : ""}`}
                          onClick={() => setChartWindowMode(mode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {chartWindowMode === "games" && !chartWindowIsLast100 && (
                      <button type="button" className="chart-window-reset" onClick={showLast100Games}>
                        Last 100
                      </button>
                    )}

                    {chartWindowFiltered && (
                      <button type="button" className="chart-window-reset" onClick={resetActiveChartWindow}>
                        Reset {chartWindowMode === "games" ? "games" : chartWindowMode === "date" ? "date" : "rating"}
                      </button>
                    )}

                    {anyChartWindowFiltered && (
                      <button type="button" className="chart-window-reset" onClick={showFullChartWindow}>
                        Full range
                      </button>
                    )}
                  </div>
                </div>

                <div className="chart-window-hint">
                  Filters combine: games must satisfy the Games, Date, and Rating ranges at the same time.
                </div>

                {chartWindowMode === "date" ? (
                  <div className="chart-window-date-editor">
                    {[
                      ["min", "From", activeChartWindow.min],
                      ["max", "To", activeChartWindow.max],
                    ].map(([edge, label, timestamp]) => {
                      const parts = utcDateParts(timestamp);
                      const dayCount = daysInUtcMonth(parts.year, parts.month);

                      return (
                        <div className="chart-window-date-card" key={edge}>
                          <div className="chart-window-date-card-title">{label}</div>
                          <div className="chart-window-date-selects">
                            <label>
                              <span>Month</span>
                              <select
                                value={parts.month}
                                onChange={(event) => updateChartDatePart(edge, "month", event.target.value)}
                              >
                                {MONTH_NAMES.map((month, index) => (
                                  <option key={month} value={index + 1}>{month}</option>
                                ))}
                              </select>
                            </label>

                            <label>
                              <span>Day</span>
                              <select
                                value={parts.day}
                                onChange={(event) => updateChartDatePart(edge, "day", event.target.value)}
                              >
                                {Array.from({ length: dayCount }, (_, index) => index + 1).map((day) => (
                                  <option key={day} value={day}>{day}</option>
                                ))}
                              </select>
                            </label>

                            <label>
                              <span>Year</span>
                              <select
                                value={parts.year}
                                onChange={(event) => updateChartDatePart(edge, "year", event.target.value)}
                              >
                                {chartDateYears.map((year) => (
                                  <option key={year} value={year}>{year}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <div className="chart-window-date-preview">{formatWindowDate(timestamp)}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="chart-window-slider-row">
                    <span className="chart-window-edge">
                      {chartWindowMode === "rating"
                        ? `${Math.round(activeChartWindow.min)} Elo`
                        : `#${Math.round(activeChartWindow.min)}`}
                    </span>

                    <div
                      className="dual-range"
                      style={{
                        "--range-start": `${chartWindowPct(activeChartWindow.min)}%`,
                        "--range-end": `${chartWindowPct(activeChartWindow.max)}%`,
                      }}
                    >
                      <div className="dual-range-track" aria-hidden="true" />
                      <input
                        className="dual-range-input dual-range-min"
                        type="range"
                        min={chartWindowBounds[chartWindowMode].min}
                        max={chartWindowBounds[chartWindowMode].max}
                        step={1}
                        value={activeChartWindow.min}
                        aria-label={`Minimum ${chartWindowMode}`}
                        onChange={(event) => {
                          const next = Math.min(Number(event.target.value), activeChartWindow.max);
                          setChartWindow(next, activeChartWindow.max);
                        }}
                      />
                      <input
                        className="dual-range-input dual-range-max"
                        type="range"
                        min={chartWindowBounds[chartWindowMode].min}
                        max={chartWindowBounds[chartWindowMode].max}
                        step={1}
                        value={activeChartWindow.max}
                        aria-label={`Maximum ${chartWindowMode}`}
                        onChange={(event) => {
                          const next = Math.max(Number(event.target.value), activeChartWindow.min);
                          setChartWindow(activeChartWindow.min, next);
                        }}
                      />
                    </div>

                    <span className="chart-window-edge chart-window-edge-right">
                      {chartWindowMode === "rating"
                        ? `${Math.round(activeChartWindow.max)} Elo`
                        : `#${Math.round(activeChartWindow.max)}`}
                    </span>
                  </div>
                )}

              </section>
            )}

            <div className="chart-note">
              Each graph is compressed to about 20 points from the {chartGames.length.toLocaleString()} games in the active graph window.
              Each point represents about {Math.max(1, Math.ceil(chartGames.length / 20))} games.
              Drag across any graph to measure the fitted rate of change over a selected range.
              The same selection is shared across every graph for direct comparison. Click anywhere outside the graphs to clear it.
            </div>

            <div className="charts">
              <ChartCard title="Rating over games">
                <RangeLineChart
                  data={chartData}
                  selection={chartRangeSelection}
                  onSelectionChange={setChartRangeSelection}
                  metrics={[{ key: "rating", label: "Rating", suffix: " Elo", decimals: 1 }]}
                >
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line
                      name="Average rating"
                      type="monotone"
                      dataKey="rating"
                      dot={false}
                      strokeWidth={2}
                    />
                </RangeLineChart>
              </ChartCard>

              <ChartCard title="ACPL per Game">
                <RangeLineChart
                  data={chartData}
                  selection={chartRangeSelection}
                  onSelectionChange={setChartRangeSelection}
                  detailKey="acplAvg"
                  metrics={[
                    { key: "acplAvg", label: "Average ACPL", decimals: 1 },
                    { key: "acplQ3", label: "Q3", decimals: 1 },
                    { key: "acplQ1", label: "Q1", decimals: 1 },
                  ]}
                >
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, "auto"]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line
                      name="Average ACPL"
                      type="monotone"
                      dataKey="acplAvg"
                      dot={false}
                      strokeWidth={2.5}
                    />
                    <Line
                      name="Upper quartile (Q3)"
                      type="monotone"
                      dataKey="acplQ3"
                      dot={false}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                    <Line
                      name="Lower quartile (Q1)"
                      type="monotone"
                      dataKey="acplQ1"
                      dot={false}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                </RangeLineChart>
              </ChartCard>

              <ChartCard title="Average Blunders per Game">
                <RangeLineChart
                  data={chartData}
                  selection={chartRangeSelection}
                  onSelectionChange={setChartRangeSelection}
                  detailKey="blunderAvg"
                  metrics={[
                    { key: "blunderAvg", label: "Average blunders", decimals: 2 },
                    { key: "blunderTop25Avg", label: "Top 25%", decimals: 2 },
                    { key: "blunderBottom25Avg", label: "Bottom 25%", decimals: 2 },
                  ]}
                >
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, blunderYAxisMax]}
                      allowDecimals
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line
                      name="Average"
                      type="monotone"
                      dataKey="blunderAvg"
                      dot={false}
                      stroke="#3fb950"
                      strokeWidth={2.5}
                    />
                    <Line
                      name="Top 25% avg"
                      type="monotone"
                      dataKey="blunderTop25Avg"
                      dot={false}
                      stroke="#ffa657"
                      strokeWidth={1.7}
                      strokeDasharray="5 4"
                    />
                    <Line
                      name="Bottom 25% avg"
                      type="monotone"
                      dataKey="blunderBottom25Avg"
                      dot={false}
                      stroke="#79c0ff"
                      strokeWidth={1.7}
                      strokeDasharray="5 4"
                    />
                </RangeLineChart>
              </ChartCard>

              <ChartCard title="% of games without blunders">
                <RangeLineChart
                  data={chartData}
                  selection={chartRangeSelection}
                  onSelectionChange={setChartRangeSelection}
                  metrics={[{ key: "zeroPracticalBlunderPct", label: "Zero-blunder games", suffix: "%", slopeSuffix: " pp / 100 games", decimals: 1 }]}
                >
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line
                      name="Zero blunders"
                      type="monotone"
                      dataKey="zeroPracticalBlunderPct"
                      dot={false}
                      strokeWidth={2.5}
                    />
                </RangeLineChart>
              </ChartCard>

              <ChartCard title="ACPL by Game Phase">
                <RangeLineChart
                  data={chartData}
                  selection={chartRangeSelection}
                  onSelectionChange={setChartRangeSelection}
                  detailKey="middlegameAcpl"
                  metrics={[
                    { key: "openingAcpl", label: "Opening", decimals: 1 },
                    { key: "middlegameAcpl", label: "Middlegame", decimals: 1 },
                    { key: "endgameAcpl", label: "Endgame", decimals: 1 },
                  ]}
                >
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, "auto"]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line name="Opening" type="monotone" dataKey="openingAcpl" connectNulls dot={false} stroke="#a371f7" strokeWidth={2.2} />
                    <Line name="Middlegame" type="monotone" dataKey="middlegameAcpl" connectNulls dot={false} stroke="#58a6ff" strokeWidth={2.2} />
                    <Line name="Endgame" type="monotone" dataKey="endgameAcpl" connectNulls dot={false} stroke="#f0883e" strokeWidth={2.2} />
                </RangeLineChart>
              </ChartCard>

              <ChartCard title="Blunders by Game Phase">
                <RangeLineChart
                  data={chartData}
                  selection={chartRangeSelection}
                  onSelectionChange={setChartRangeSelection}
                  detailKey="middlegameBlunders"
                  metrics={[
                    { key: "openingBlunders", label: "Opening", decimals: 1 },
                    { key: "middlegameBlunders", label: "Middlegame", decimals: 1 },
                    { key: "endgameBlunders", label: "Endgame", decimals: 1 },
                  ]}
                >
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, "auto"]}
                      allowDecimals={false}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <PhaseBlunderTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line name="Opening" type="monotone" dataKey="openingBlunders" connectNulls dot={false} stroke="#a371f7" strokeWidth={2.2} />
                    <Line name="Middlegame" type="monotone" dataKey="middlegameBlunders" connectNulls dot={false} stroke="#58a6ff" strokeWidth={2.2} />
                    <Line name="Endgame" type="monotone" dataKey="endgameBlunders" connectNulls dot={false} stroke="#f0883e" strokeWidth={2.2} />
                </RangeLineChart>
              </ChartCard>
            </div>

            <section className="card table-card">
              <div className="table-header">
                <h2>Game history</h2>

                <div className="toolbar">
                  <input
                    className="search"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setGamePage(1); }}
                    placeholder="Search opponent, game number, or date..."
                  />

                  <select
                    className="filter"
                    value={filter}
                    onChange={(e) => { setFilter(e.target.value); setGamePage(1); }}
                  >
                    <option value="all">All results</option>
                    <option value="win">Wins</option>
                    <option value="loss">Losses</option>
                    <option value="draw">Draws</option>
                  </select>
                </div>

                <div className="footer-note">
                  Showing {filteredGames.length ? ((gamePage - 1) * GAMES_PER_PAGE + 1) : 0}
                  –{Math.min(gamePage * GAMES_PER_PAGE, filteredGames.length)} of{" "}
                  {filteredGames.length} matching games.
                  Click a row to inspect its move records.
                </div>
              </div>

              <div className="table-wrap">
                <table className="game-table">
                  <colgroup>
                    <col style={{ width: "34px" }} />
                    <col style={{ width: "88px" }} />
                    <col style={{ width: "150px" }} />
                    <col style={{ width: "72px" }} />
                    <col style={{ width: "60px" }} />
                    <col style={{ width: "72px" }} />
                    <col style={{ width: "82px" }} />
                    <col style={{ width: "68px" }} />
                    <col style={{ width: "78px" }} />
                    <col style={{ width: "72px" }} />
                    <col style={{ width: "72px" }} />
                    <col style={{ width: "82px" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th />
                      <th>Date</th>
                      <th>Opponent</th>
                      <th>Result</th>
                      <th>Moves</th>
                      <th>Rating</th>
                      <th>Opp. rating</th>
                      <th>ACPL</th>
                      <th>Opp. ACPL</th>
                      <th>Blunders</th>
                      <th>Mistakes</th>
                      <th>Inaccuracies</th>
                    </tr>
                  </thead>

                  <tbody>
                    {pagedGames.map((game) => (
                      <GameRow
                        key={game.gameNumber}
                        game={game}
                        moves={movesByGame.get(game.gameNumber) || []}
                        expanded={expandedGame === game.gameNumber}
                        onToggle={() =>
                          setExpandedGame(
                            expandedGame === game.gameNumber
                              ? null
                              : game.gameNumber
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="game-pagination">
                <button
                  className="page-button"
                  disabled={gamePage <= 1}
                  onClick={() => {
                    setExpandedGame(null);
                    setGamePage((page) => Math.max(1, page - 1));
                  }}
                >
                  ‹
                </button>

                <span>
                  Page {gamePage} of {totalGamePages}
                </span>

                <button
                  className="page-button"
                  disabled={gamePage >= totalGamePages}
                  onClick={() => {
                    setExpandedGame(null);
                    setGamePage((page) => Math.min(totalGamePages, page + 1));
                  }}
                >
                  ›
                </button>
              </div>
            </section>
          </>
        ) : null}
      </main>
      <div className="app-version" aria-label={`App version ${APP_VERSION}`}>
        v{APP_VERSION}
      </div>
    </div>
  );
}
