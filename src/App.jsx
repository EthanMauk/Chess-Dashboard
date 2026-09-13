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
  ChevronDown,
} from "lucide-react";
import ClimbScoreMetric from "./components/ClimbScoreMetric";
import PerformanceMetric from "./components/PerformanceMetric";
import ChartCard, { ChartTooltip, PhaseBlunderTooltip } from "./components/ChartCard";
import RangeLineChart from "./components/RangeLineChart";
import GameTable from "./components/GameTable";
import RatingOverview from "./components/RatingOverview";
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

function usernameFromProfilePath() {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/player\/([^/]+)\/?$/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

function canonicalProfilePath(player) {
  const normalized = String(player || "").trim().toLowerCase();
  return normalized ? `/player/${encodeURIComponent(normalized)}` : "/";
}

function currentProfileUsername(fallback = "ProtoX09") {
  const routed = usernameFromProfilePath();
  if (routed) return routed;
  try {
    return localStorage.getItem(USERNAME_STORAGE_KEY)?.trim() || fallback;
  } catch {
    return fallback;
  }
}

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

function scoreLowerIsBetter(value, strong, weak) {
  if (!Number.isFinite(value)) return 0;
  if (value <= strong) return 100;
  if (value >= weak) return 0;
  return 100 * (weak - value) / (weak - strong);
}

function weightedMean(rows, valueForRow, weightForRow) {
  let weightedTotal = 0;
  let totalWeight = 0;

  rows.forEach((row, index) => {
    const value = Number(valueForRow(row, index));
    const weight = Number(weightForRow(row, index));
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) return;
    weightedTotal += value * weight;
    totalWeight += weight;
  });

  return totalWeight > 0 ? weightedTotal / totalWeight : 0;
}

function weightedStdDev(rows, valueForRow, weightForRow) {
  const mean = weightedMean(rows, valueForRow, weightForRow);
  let weightedSquared = 0;
  let totalWeight = 0;

  rows.forEach((row, index) => {
    const value = Number(valueForRow(row, index));
    const weight = Number(weightForRow(row, index));
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) return;
    weightedSquared += ((value - mean) ** 2) * weight;
    totalWeight += weight;
  });

  return totalWeight > 0 ? Math.sqrt(weightedSquared / totalWeight) : 0;
}

function scoreCenteredSignal(signal, scale) {
  if (!Number.isFinite(signal) || !Number.isFinite(scale) || scale <= 0) return 50;
  return clampNumber(50 + 50 * Math.tanh(signal / scale), 0, 100);
}

function expectedScoreFromRatings(playerRating, opponentRating) {
  const player = Number(playerRating);
  const opponent = Number(opponentRating);
  if (!Number.isFinite(player) || !Number.isFinite(opponent)) return 0.5;
  return 1 / (1 + (10 ** ((opponent - player) / 400)));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function meanFinite(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : NaN;
}

function weightedQuantile(rows, valueForRow, weightForRow, quantile) {
  const points = rows
    .map((row, index) => ({
      value: Number(valueForRow(row, index)),
      weight: Number(weightForRow(row, index)),
    }))
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.weight) && point.weight > 0)
    .sort((a, b) => a.value - b.value);

  if (!points.length) return NaN;
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const target = clampNumber(quantile, 0, 1) * totalWeight;
  let cumulative = 0;
  for (const point of points) {
    cumulative += point.weight;
    if (cumulative >= target) return point.value;
  }
  return points[points.length - 1].value;
}

function performanceErrorBurden(game, side = "player") {
  const prefix = side === "opponent" ? "opponent" : "player";
  return (
    4.0 * num(game[`${prefix}PracticalBlunders`])
    + 1.65 * num(game[`${prefix}Mistakes`])
    + 0.55 * num(game[`${prefix}Inaccuracies`])
  );
}

function criticalDecisionBurden(game, side = "player") {
  const prefix = side === "opponent" ? "opponent" : "player";
  return (
    5.0 * num(game[`${prefix}MissedMates`])
    + 2.4 * num(game[`${prefix}ConversionErrors`])
    + 1.35 * num(game[`${prefix}MissedOpportunities`])
  );
}

function classifiedMoveCount(game, side = "player") {
  const prefix = side === "opponent" ? "opponent" : "player";
  return (
    num(game[`${prefix}GreatMoves`])
    + num(game[`${prefix}BestMoves`])
    + num(game[`${prefix}GoodMoves`])
    + num(game[`${prefix}Mistakes`])
    + num(game[`${prefix}Inaccuracies`])
    + num(game[`${prefix}PracticalBlunders`])
  );
}

function moveQualityShare(game, side = "player") {
  const prefix = side === "opponent" ? "opponent" : "player";
  const total = classifiedMoveCount(game, side);
  if (!total) return NaN;
  return (
    num(game[`${prefix}GreatMoves`])
    + num(game[`${prefix}BestMoves`])
    + num(game[`${prefix}GoodMoves`])
  ) / total;
}

function legConfidence(sampleSize, target = 40, coverage = 1) {
  if (!sampleSize) return 0;
  const sampleEvidence = 1 - Math.exp(-sampleSize / Math.max(1, target));
  return clampNumber(sampleEvidence * clampNumber(coverage, 0, 1), 0, 1);
}

function shrinkToNeutral(score, confidence) {
  return 50 + (clampNumber(score, 0, 100) - 50) * clampNumber(confidence, 0, 1);
}

function weightedAverageScores(items) {
  let total = 0;
  let weight = 0;
  for (const item of items) {
    const score = Number(item.score);
    const itemWeight = Number(item.weight);
    if (!Number.isFinite(score) || !Number.isFinite(itemWeight) || itemWeight <= 0) continue;
    total += score * itemWeight;
    weight += itemWeight;
  }
  return weight ? total / weight : 50;
}

function eloToPlayingScore(elo) {
  const value = Number(elo);
  if (!Number.isFinite(value)) return 50;
  const anchors = [
    [100, 5],
    [300, 15],
    [600, 28],
    [900, 40],
    [1200, 50],
    [1500, 60],
    [1800, 70],
    [2000, 77],
    [2200, 84],
    [2400, 89],
    [2600, 94],
    [2800, 97],
    [3000, 99],
    [3200, 100],
  ];

  if (value <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (value <= x2) {
      const t = (value - x1) / (x2 - x1);
      return y1 + (y2 - y1) * t;
    }
  }
  return 100;
}

function performanceRatingFromScore(scoreRate, opponentRating) {
  const p = clampNumber(Number(scoreRate), 0.02, 0.98);
  const opposition = Number(opponentRating);
  if (!Number.isFinite(opposition)) return NaN;
  return opposition + 400 * Math.log10(p / (1 - p));
}

function absoluteCategoryScore(anchorScore, relativeScore, confidence = 1, sensitivity = 0.28) {
  const anchor = clampNumber(Number(anchorScore), 0, 100);
  const relative = clampNumber(Number(relativeScore), 0, 100);
  const evidence = clampNumber(Number(confidence), 0, 1);
  return clampNumber(anchor + (relative - 50) * sensitivity * evidence, 0, 100);
}

function calculatePerformanceMetrics(games, windowSize = 100) {
  const chronological = [...games]
    .filter((game) => Number.isFinite(Number(game.gameNumber)))
    .sort((a, b) => Number(a.gameNumber) - Number(b.gameNumber));

  const fullAnalyzed = chronological.filter((game) => {
    const classifiedMoves = classifiedMoveCount(game, "player");
    return num(game.playerAcpl) > 0 || classifiedMoves > 0;
  });
  const analyzed = fullAnalyzed.slice(-windowSize);

  const emptyCategories = [
    "Results strength",
    "Engine quality",
    "Error control",
    "Critical decisions",
    "Phase quality",
    "Move quality",
    "Consistency & floor",
    "Current form",
  ].map((label) => ({ label, score: 50, confidence: 0 }));

  if (!analyzed.length) {
    return {
      score: 50,
      rawScore: 50,
      sampleSize: 0,
      confidence: 0,
      confidenceLabel: "Low",
      trend: "Flat",
      trendDelta: 0,
      categories: emptyCategories,
      details: {},
    };
  }

  const halfLife = 25;
  const recencyWeight = (_game, index) => {
    const gamesAgo = analyzed.length - 1 - index;
    return 0.5 ** (gamesAgo / halfLife);
  };
  const uniformWeight = () => 1;

  const weightedAvailableMean = (rows, valueForRow, weightForRow = uniformWeight) => {
    let weightedTotal = 0;
    let totalWeight = 0;
    let count = 0;
    rows.forEach((row, index) => {
      const value = Number(valueForRow(row, index));
      const weight = Number(weightForRow(row, index));
      if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) return;
      weightedTotal += value * weight;
      totalWeight += weight;
      count += 1;
    });
    return {
      value: totalWeight ? weightedTotal / totalWeight : NaN,
      count,
      coverage: rows.length ? count / rows.length : 0,
    };
  };

  const historicalMean = (valueForRow) => weightedAvailableMean(fullAnalyzed, valueForRow).value;

  // RESULTS VS EXPECTATION ---------------------------------------------------
  const resultRows = analyzed.filter((game) => gameResultScore(game.result) != null);
  const actualScoreMetric = weightedAvailableMean(
    resultRows,
    (game) => gameResultScore(game.result),
    (_game, index) => recencyWeight(resultRows[index], analyzed.length - resultRows.length + index),
  );
  const expectedScoreMetric = weightedAvailableMean(
    resultRows,
    (game) => expectedScoreFromRatings(game.playerRating, game.opponentRating),
    (_game, index) => recencyWeight(resultRows[index], analyzed.length - resultRows.length + index),
  );
  const resultDelta = Number.isFinite(actualScoreMetric.value) && Number.isFinite(expectedScoreMetric.value)
    ? actualScoreMetric.value - expectedScoreMetric.value
    : 0;
  const resultRaw = scoreCenteredSignal(resultDelta, 0.16);
  const resultConfidence = legConfidence(resultRows.length, 35, Math.min(actualScoreMetric.coverage, expectedScoreMetric.coverage));
  const resultScore = shrinkToNeutral(resultRaw, resultConfidence);

  // ENGINE QUALITY ----------------------------------------------------------
  const acplRows = analyzed.filter((game) => Number.isFinite(Number(game.playerAcpl)) && Number(game.playerAcpl) > 0);
  const playerAcplMetric = weightedAvailableMean(acplRows, (game) => num(game.playerAcpl), recencyWeight);
  const opponentAcplMetric = weightedAvailableMean(acplRows, (game) => {
    const value = finiteNumber(game.opponentAcpl);
    return value != null && value > 0 ? value : NaN;
  }, recencyWeight);
  const acplEdge = Number.isFinite(opponentAcplMetric.value)
    ? opponentAcplMetric.value - playerAcplMetric.value
    : 0;
  const relativeAcplScore = Number.isFinite(opponentAcplMetric.value)
    ? scoreCenteredSignal(acplEdge, 35)
    : 50;

  const historicalAcpl = historicalMean((game) => {
    const value = finiteNumber(game.playerAcpl);
    return value != null && value > 0 ? value : NaN;
  });
  const selfAcplDelta = Number.isFinite(historicalAcpl) && Number.isFinite(playerAcplMetric.value)
    ? historicalAcpl - playerAcplMetric.value
    : 0;
  const selfAcplScore = scoreCenteredSignal(selfAcplDelta, 28);

  const acplMedian = weightedQuantile(acplRows, (game) => num(game.playerAcpl), recencyWeight, 0.5);
  const acplP80 = weightedQuantile(acplRows, (game) => num(game.playerAcpl), recencyWeight, 0.8);
  const historicalP80 = weightedQuantile(fullAnalyzed, (game) => num(game.playerAcpl), uniformWeight, 0.8);
  const tailScore = Number.isFinite(acplP80) && Number.isFinite(historicalP80)
    ? scoreCenteredSignal(historicalP80 - acplP80, 35)
    : 50;
  const engineRaw = weightedAverageScores([
    { score: relativeAcplScore, weight: Number.isFinite(opponentAcplMetric.value) ? 0.55 : 0 },
    { score: selfAcplScore, weight: 0.30 },
    { score: tailScore, weight: 0.15 },
  ]);
  const engineCoverage = Math.max(
    playerAcplMetric.coverage,
    Math.min(playerAcplMetric.coverage, opponentAcplMetric.coverage),
  );
  const engineConfidence = legConfidence(acplRows.length, 35, engineCoverage);
  const engineScore = shrinkToNeutral(engineRaw, engineConfidence);

  // ERROR CONTROL -----------------------------------------------------------
  const errorRows = analyzed.filter((game) => classifiedMoveCount(game, "player") > 0);
  const playerErrorMetric = weightedAvailableMean(errorRows, (game) => performanceErrorBurden(game, "player"), recencyWeight);
  const opponentErrorMetric = weightedAvailableMean(errorRows, (game) => {
    const hasFields = game.opponentPracticalBlunders != null || game.opponentMistakes != null || game.opponentInaccuracies != null;
    return hasFields ? performanceErrorBurden(game, "opponent") : NaN;
  }, recencyWeight);
  const historicalError = historicalMean((game) => classifiedMoveCount(game, "player") > 0
    ? performanceErrorBurden(game, "player")
    : NaN);
  const opponentErrorEdge = Number.isFinite(opponentErrorMetric.value)
    ? opponentErrorMetric.value - playerErrorMetric.value
    : 0;
  const selfErrorEdge = Number.isFinite(historicalError)
    ? historicalError - playerErrorMetric.value
    : 0;
  const blunderFreeRateMetric = weightedAvailableMean(
    errorRows,
    (game) => num(game.playerPracticalBlunders) === 0 ? 1 : 0,
    recencyWeight,
  );
  const historicalBlunderFreeRate = historicalMean((game) => classifiedMoveCount(game, "player") > 0
    ? (num(game.playerPracticalBlunders) === 0 ? 1 : 0)
    : NaN);
  const blunderFreeDelta = Number.isFinite(historicalBlunderFreeRate)
    ? blunderFreeRateMetric.value - historicalBlunderFreeRate
    : 0;
  const errorRaw = weightedAverageScores([
    { score: Number.isFinite(opponentErrorMetric.value) ? scoreCenteredSignal(opponentErrorEdge, 2.0) : 50, weight: Number.isFinite(opponentErrorMetric.value) ? 0.50 : 0 },
    { score: scoreCenteredSignal(selfErrorEdge, 1.6), weight: 0.30 },
    { score: scoreCenteredSignal(blunderFreeDelta, 0.18), weight: 0.20 },
  ]);
  const errorCoverage = Math.max(playerErrorMetric.coverage, opponentErrorMetric.coverage);
  const errorConfidence = legConfidence(errorRows.length, 35, errorCoverage);
  const errorScore = shrinkToNeutral(errorRaw, errorConfidence);

  // CRITICAL DECISIONS ------------------------------------------------------
  const criticalRows = analyzed.filter((game) => (
    game.playerMissedMates != null
    || game.playerConversionErrors != null
    || game.playerMissedOpportunities != null
  ));
  const playerCriticalMetric = weightedAvailableMean(criticalRows, (game) => criticalDecisionBurden(game, "player"), recencyWeight);
  const opponentCriticalMetric = weightedAvailableMean(criticalRows, (game) => {
    const hasFields = game.opponentMissedMates != null || game.opponentConversionErrors != null || game.opponentMissedOpportunities != null;
    return hasFields ? criticalDecisionBurden(game, "opponent") : NaN;
  }, recencyWeight);
  const historicalCritical = historicalMean((game) => (
    game.playerMissedMates != null || game.playerConversionErrors != null || game.playerMissedOpportunities != null
  ) ? criticalDecisionBurden(game, "player") : NaN);
  const criticalRaw = weightedAverageScores([
    {
      score: Number.isFinite(opponentCriticalMetric.value)
        ? scoreCenteredSignal(opponentCriticalMetric.value - playerCriticalMetric.value, 1.4)
        : 50,
      weight: Number.isFinite(opponentCriticalMetric.value) ? 0.55 : 0,
    },
    {
      score: Number.isFinite(historicalCritical)
        ? scoreCenteredSignal(historicalCritical - playerCriticalMetric.value, 1.1)
        : 50,
      weight: 0.45,
    },
  ]);
  const criticalCoverage = analyzed.length ? criticalRows.length / analyzed.length : 0;
  const criticalConfidence = legConfidence(criticalRows.length, 30, criticalCoverage);
  const criticalScore = shrinkToNeutral(criticalRaw, criticalConfidence);

  // PHASE QUALITY -----------------------------------------------------------
  const phaseDefinitions = [
    ["Opening", "Opening"],
    ["Middlegame", "Middlegame"],
    ["Endgame", "Endgame"],
  ];
  const phaseComponents = [];
  const phaseDetails = {};
  for (const [label, cap] of phaseDefinitions) {
    let weightedPlayerLoss = 0;
    let weightedOpponentLoss = 0;
    let playerMoves = 0;
    let opponentMoves = 0;
    let gamesWithPhase = 0;

    for (const game of analyzed) {
      const pMoves = num(game[`player${cap}Moves`]);
      const oMoves = num(game[`opponent${cap}Moves`]);
      const pAcpl = finiteNumber(game[`player${cap}Acpl`]);
      const oAcpl = finiteNumber(game[`opponent${cap}Acpl`]);
      if (pMoves > 0 && pAcpl != null) {
        weightedPlayerLoss += pAcpl * pMoves;
        playerMoves += pMoves;
        gamesWithPhase += 1;
      }
      if (oMoves > 0 && oAcpl != null) {
        weightedOpponentLoss += oAcpl * oMoves;
        opponentMoves += oMoves;
      }
    }

    const pPhaseAcpl = playerMoves ? weightedPlayerLoss / playerMoves : NaN;
    const oPhaseAcpl = opponentMoves ? weightedOpponentLoss / opponentMoves : NaN;
    const historicalPhaseAcpl = (() => {
      let loss = 0;
      let moves = 0;
      for (const game of fullAnalyzed) {
        const moveCount = num(game[`player${cap}Moves`]);
        const acpl = finiteNumber(game[`player${cap}Acpl`]);
        if (moveCount > 0 && acpl != null) {
          loss += acpl * moveCount;
          moves += moveCount;
        }
      }
      return moves ? loss / moves : NaN;
    })();

    const relative = Number.isFinite(oPhaseAcpl)
      ? scoreCenteredSignal(oPhaseAcpl - pPhaseAcpl, 42)
      : 50;
    const self = Number.isFinite(historicalPhaseAcpl) && Number.isFinite(pPhaseAcpl)
      ? scoreCenteredSignal(historicalPhaseAcpl - pPhaseAcpl, 32)
      : 50;
    const phaseRaw = weightedAverageScores([
      { score: relative, weight: Number.isFinite(oPhaseAcpl) ? 0.70 : 0 },
      { score: self, weight: 0.30 },
    ]);
    const phaseConfidence = legConfidence(gamesWithPhase, label === "Endgame" ? 18 : 25, Math.min(1, playerMoves / 180));
    phaseComponents.push({ score: shrinkToNeutral(phaseRaw, phaseConfidence), weight: Math.max(0.15, Math.sqrt(playerMoves || 0)), confidence: phaseConfidence });
    phaseDetails[label.toLowerCase()] = { playerAcpl: pPhaseAcpl, opponentAcpl: oPhaseAcpl, moves: playerMoves, confidence: phaseConfidence };
  }
  const phaseRawScore = weightedAverageScores(phaseComponents);
  const phaseConfidence = phaseComponents.length
    ? meanFinite(phaseComponents.map((item) => item.confidence))
    : 0;
  const phaseScore = shrinkToNeutral(phaseRawScore, phaseConfidence);

  // MOVE QUALITY ------------------------------------------------------------
  const moveQualityRows = analyzed.filter((game) => Number.isFinite(moveQualityShare(game, "player")));
  const recentMoveQuality = weightedAvailableMean(moveQualityRows, (game) => moveQualityShare(game, "player"), recencyWeight);
  const historicalMoveQuality = historicalMean((game) => moveQualityShare(game, "player"));
  const moveQualityDelta = Number.isFinite(historicalMoveQuality)
    ? recentMoveQuality.value - historicalMoveQuality
    : 0;
  const recentBestLike = weightedAvailableMean(moveQualityRows, (game) => {
    const total = classifiedMoveCount(game, "player");
    if (!total) return NaN;
    return (num(game.playerGreatMoves) + num(game.playerBestMoves)) / total;
  }, recencyWeight);
  const historicalBestLike = historicalMean((game) => {
    const total = classifiedMoveCount(game, "player");
    if (!total) return NaN;
    return (num(game.playerGreatMoves) + num(game.playerBestMoves)) / total;
  });
  const bestLikeDelta = Number.isFinite(historicalBestLike)
    ? recentBestLike.value - historicalBestLike
    : 0;
  const moveQualityRaw = weightedAverageScores([
    { score: scoreCenteredSignal(moveQualityDelta, 0.10), weight: 0.60 },
    { score: scoreCenteredSignal(bestLikeDelta, 0.08), weight: 0.40 },
  ]);
  const moveQualityConfidence = legConfidence(moveQualityRows.length, 30, recentMoveQuality.coverage);
  const moveQualityScore = shrinkToNeutral(moveQualityRaw, moveQualityConfidence);

  // CONSISTENCY & FLOOR -----------------------------------------------------
  const recentAcplSd = weightedStdDev(acplRows, (game) => num(game.playerAcpl), recencyWeight);
  const historicalAcplSd = fullAnalyzed.length >= 20
    ? (() => {
        const values = fullAnalyzed.map((game) => finiteNumber(game.playerAcpl)).filter((value) => value != null && value > 0);
        if (!values.length) return NaN;
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
      })()
    : recentAcplSd;
  const recentP90 = weightedQuantile(acplRows, (game) => num(game.playerAcpl), recencyWeight, 0.9);
  const historicalP90 = weightedQuantile(fullAnalyzed, (game) => num(game.playerAcpl), uniformWeight, 0.9);
  const consistencyRaw = weightedAverageScores([
    {
      score: Number.isFinite(historicalAcplSd)
        ? scoreCenteredSignal(historicalAcplSd - recentAcplSd, 16)
        : 50,
      weight: 0.45,
    },
    {
      score: Number.isFinite(historicalP90) && Number.isFinite(recentP90)
        ? scoreCenteredSignal(historicalP90 - recentP90, 32)
        : 50,
      weight: 0.40,
    },
    { score: scoreCenteredSignal(blunderFreeDelta, 0.16), weight: 0.15 },
  ]);
  const consistencyConfidence = legConfidence(acplRows.length, 40, playerAcplMetric.coverage);
  const consistencyScore = shrinkToNeutral(consistencyRaw, consistencyConfidence);

  // CURRENT FORM / MOMENTUM -------------------------------------------------
  const recentCount = Math.min(25, analyzed.length);
  const recentFormRows = analyzed.slice(-recentCount);
  const priorFormRows = fullAnalyzed.slice(Math.max(0, fullAnalyzed.length - recentCount * 3), Math.max(0, fullAnalyzed.length - recentCount));

  const formSnapshot = (rows) => {
    if (!rows.length) return null;
    const actual = meanFinite(rows.map((game) => gameResultScore(game.result)).filter((value) => value != null));
    const expected = meanFinite(rows.map((game) => expectedScoreFromRatings(game.playerRating, game.opponentRating)));
    const pAcpl = meanFinite(rows.map((game) => finiteNumber(game.playerAcpl)).filter((value) => value != null && value > 0));
    const oAcpl = meanFinite(rows.map((game) => finiteNumber(game.opponentAcpl)).filter((value) => value != null && value > 0));
    const errors = meanFinite(rows.map((game) => performanceErrorBurden(game, "player")));
    return { actual, expected, pAcpl, oAcpl, errors };
  };
  const recentForm = formSnapshot(recentFormRows);
  const priorForm = formSnapshot(priorFormRows);
  let formRaw = 50;
  let trendDelta = 0;
  if (recentForm && priorForm && priorFormRows.length >= 10) {
    const resultMomentum = (recentForm.actual - recentForm.expected) - (priorForm.actual - priorForm.expected);
    const recentAcplEdge = Number.isFinite(recentForm.oAcpl) ? recentForm.oAcpl - recentForm.pAcpl : 0;
    const priorAcplEdge = Number.isFinite(priorForm.oAcpl) ? priorForm.oAcpl - priorForm.pAcpl : 0;
    const acplMomentum = recentAcplEdge - priorAcplEdge;
    const errorMomentum = priorForm.errors - recentForm.errors;
    formRaw = weightedAverageScores([
      { score: scoreCenteredSignal(resultMomentum, 0.14), weight: 0.45 },
      { score: scoreCenteredSignal(acplMomentum, 28), weight: 0.35 },
      { score: scoreCenteredSignal(errorMomentum, 1.5), weight: 0.20 },
    ]);
    trendDelta = formRaw - 50;
  }
  const formConfidence = legConfidence(Math.min(recentFormRows.length, priorFormRows.length), 20, priorFormRows.length >= 10 ? 1 : 0);
  const formScore = shrinkToNeutral(formRaw, formConfidence);

  // ABSOLUTE PLAYING STRENGTH ------------------------------------------------
  // The old model centered every player around 50 and therefore measured form,
  // not chess strength. That badly fails at the top of the pool: a #1 player
  // almost never has higher-rated opponents available. We instead convert the
  // score rate against the *absolute* opponent field into an Elo-equivalent
  // performance rating, then use rating as a prior and engine/error metrics as
  // bounded modifiers around that absolute strength.
  const latestRating = finiteNumber(analyzed[analyzed.length - 1]?.playerRating)
    ?? finiteNumber(chronological[chronological.length - 1]?.playerRating)
    ?? NaN;
  const averageOpponentRatingMetric = weightedAvailableMean(
    resultRows,
    (game) => finiteNumber(game.opponentRating),
    (_game, index) => recencyWeight(resultRows[index], analyzed.length - resultRows.length + index),
  );
  const resultPerformanceRating = (
    Number.isFinite(actualScoreMetric.value)
    && Number.isFinite(averageOpponentRatingMetric.value)
  )
    ? performanceRatingFromScore(actualScoreMetric.value, averageOpponentRatingMetric.value)
    : NaN;

  const ratingPrior = Number.isFinite(latestRating)
    ? latestRating
    : resultPerformanceRating;
  const resultsBlend = clampNumber(0.30 + 0.50 * resultConfidence, 0.30, 0.80);
  const absoluteBaseElo = Number.isFinite(resultPerformanceRating) && Number.isFinite(ratingPrior)
    ? ratingPrior * (1 - resultsBlend) + resultPerformanceRating * resultsBlend
    : (Number.isFinite(resultPerformanceRating) ? resultPerformanceRating : ratingPrior);
  const absoluteAnchorScore = eloToPlayingScore(absoluteBaseElo);

  const resultsAbsoluteScore = Number.isFinite(resultPerformanceRating)
    ? eloToPlayingScore(
        Number.isFinite(ratingPrior)
          ? ratingPrior * (1 - resultConfidence) + resultPerformanceRating * resultConfidence
          : resultPerformanceRating
      )
    : absoluteAnchorScore;
  const engineAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, engineScore, engineConfidence, 0.34);
  const errorAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, errorScore, errorConfidence, 0.30);
  const criticalAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, criticalScore, criticalConfidence, 0.22);
  const phaseAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, phaseScore, phaseConfidence, 0.28);
  const moveQualityAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, moveQualityScore, moveQualityConfidence, 0.24);
  const consistencyAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, consistencyScore, consistencyConfidence, 0.24);
  const formAbsoluteScore = absoluteCategoryScore(absoluteAnchorScore, formScore, formConfidence, 0.30);

  // Convert the aggregate modifier back into a small Elo adjustment so the UI
  // can expose an estimated playing strength in familiar units. The absolute
  // rating/result anchor remains dominant; supporting metrics refine it.
  const relativeModifier = weightedAverageScores([
    { score: engineScore, weight: 0.24 },
    { score: errorScore, weight: 0.20 },
    { score: criticalScore, weight: 0.10 },
    { score: phaseScore, weight: 0.16 },
    { score: moveQualityScore, weight: 0.10 },
    { score: consistencyScore, weight: 0.10 },
    { score: formScore, weight: 0.10 },
  ]);
  const eloAdjustment = clampNumber((relativeModifier - 50) * 2.0, -90, 90);
  const estimatedElo = Number.isFinite(absoluteBaseElo) ? absoluteBaseElo + eloAdjustment : NaN;

  const categorySpecs = [
    { label: "Results strength", score: resultsAbsoluteScore, confidence: resultConfidence, weight: 0.25 },
    { label: "Engine quality", score: engineAbsoluteScore, confidence: engineConfidence, weight: 0.18 },
    { label: "Error control", score: errorAbsoluteScore, confidence: errorConfidence, weight: 0.15 },
    { label: "Critical decisions", score: criticalAbsoluteScore, confidence: criticalConfidence, weight: 0.10 },
    { label: "Phase quality", score: phaseAbsoluteScore, confidence: phaseConfidence, weight: 0.11 },
    { label: "Move quality", score: moveQualityAbsoluteScore, confidence: moveQualityConfidence, weight: 0.07 },
    { label: "Consistency & floor", score: consistencyAbsoluteScore, confidence: consistencyConfidence, weight: 0.08 },
    { label: "Current form", score: formAbsoluteScore, confidence: formConfidence, weight: 0.06 },
  ];

  // Sparse legs contribute less rather than being allowed to inject fake 0/100
  // certainty. Their unused weight is automatically redistributed among the
  // better-supported legs.
  const supportedWeights = categorySpecs.map((category) => ({
    ...category,
    effectiveWeight: category.weight * (0.35 + 0.65 * category.confidence),
  }));
  const rawScore = weightedAverageScores(
    supportedWeights.map((category) => ({ score: category.score, weight: category.effectiveWeight })),
  );

  const averageCoverage = weightedAverageScores(
    supportedWeights.map((category) => ({ score: category.confidence * 100, weight: category.weight })),
  ) / 100;
  const overallSampleConfidence = legConfidence(analyzed.length, 45, 1);
  const confidence = clampNumber(overallSampleConfidence * (0.68 + 0.32 * averageCoverage), 0, 1);
  // Confidence describes certainty; it must not drag an elite absolute-strength
  // estimate back toward 50. Sparse supporting legs already have reduced weight.
  const score = clampNumber(rawScore, 0, 100);
  const confidenceLabel = confidence >= 0.82 ? "High" : confidence >= 0.58 ? "Medium" : "Low";
  const trend = trendDelta >= 6 ? "Rising" : trendDelta <= -6 ? "Falling" : "Flat";

  return {
    score: clampNumber(score, 0, 100),
    rawScore: clampNumber(rawScore, 0, 100),
    sampleSize: analyzed.length,
    confidence,
    confidenceLabel,
    trend,
    trendDelta,
    estimatedElo,
    resultPerformanceRating,
    ratingAnchorElo: ratingPrior,
    averageOpponentRating: averageOpponentRatingMetric.value,
    categories: supportedWeights.map((category) => ({
      label: category.label,
      score: clampNumber(category.score, 0, 100),
      confidence: category.confidence,
      weight: category.weight,
      effectiveWeight: category.effectiveWeight,
    })),
    details: {
      actualScorePct: Number.isFinite(actualScoreMetric.value) ? actualScoreMetric.value * 100 : NaN,
      estimatedElo,
      resultPerformanceRating,
      ratingAnchorElo: ratingPrior,
      averageOpponentRating: averageOpponentRatingMetric.value,
      expectedScorePct: Number.isFinite(expectedScoreMetric.value) ? expectedScoreMetric.value * 100 : NaN,
      resultDeltaPct: resultDelta * 100,
      playerAcpl: playerAcplMetric.value,
      opponentAcpl: opponentAcplMetric.value,
      acplEdge,
      historicalAcpl,
      acplMedian,
      acplP80,
      historicalP80,
      playerErrorBurden: playerErrorMetric.value,
      opponentErrorBurden: opponentErrorMetric.value,
      historicalErrorBurden: historicalError,
      blunderFreeRate: blunderFreeRateMetric.value,
      historicalBlunderFreeRate,
      playerCriticalBurden: playerCriticalMetric.value,
      opponentCriticalBurden: opponentCriticalMetric.value,
      historicalCriticalBurden: historicalCritical,
      moveQualityShare: recentMoveQuality.value,
      historicalMoveQualityShare: historicalMoveQuality,
      bestLikeShare: recentBestLike.value,
      historicalBestLikeShare: historicalBestLike,
      recentAcplSd,
      historicalAcplSd,
      recentAcplP90: recentP90,
      historicalAcplP90: historicalP90,
      phase: phaseDetails,
      averageCoverage,
      recentFormGames: recentFormRows.length,
      priorFormGames: priorFormRows.length,
    },
  };
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
  if (score >= 78 && recentSlopePer100 >= 40 && newTerritoryGain >= 50) return "Flying";
  return "Climbing";
}

function trajectoryPaceLabel(state) {
  if (state === "Floundering") return "Decline pace";
  if (state === "Flatlining") return "Trend pace";
  return "Climb pace";
}

function trajectoryStateSummary(state) {
  if (state === "Flying") return "exceptional sustained upward momentum";
  if (state === "Climbing") return "positive upward momentum";
  if (state === "Flatlining") return "little sustained directional progress";
  return "sustained negative momentum";
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
  const PEAK_RATCHET_ELO = 20;
  const SUPPORT_BREAK_MARGIN = 12;

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
      smoothingWindow: 0,
      supportFloor: NaN,
      confirmedPeak: NaN,
      structuralBreaks: 0,
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
      smoothingWindow: era.length,
      supportFloor: Number(only?.playerRating),
      confirmedPeak: Number(only?.playerRating),
      structuralBreaks: 0,
      isActiveClimb: false,
      hardGapDaysBefore,
    };
  }

  // Smooth the rating path over roughly 20–30 games. A climb is allowed to
  // contain ugly drawdowns as long as its smoothed level does not spend a full
  // smoothing window materially below the previous confirmed rating peak.
  // When a higher band is held for long enough, the old peak becomes the new
  // structural support floor. This models a climb as higher sustained levels,
  // rather than breaking it merely because several short blocks slope down.
  const smoothingWindow = Math.round(clampNumber(era.length / 8, 20, 30));
  const peakHoldGames = Math.max(8, Math.ceil(smoothingWindow * 0.6));
  const supportBreakGames = smoothingWindow;
  const smoothed = era.map((_, index) => {
    const start = Math.max(0, index - smoothingWindow + 1);
    return medianFinite(era.slice(start, index + 1).map((row) => row.playerRating));
  });

  let regimeStartIndex = 0;
  let supportFloor = smoothed[0];
  let confirmedPeak = smoothed[0];
  let abovePeakRun = 0;
  let belowSupportRun = 0;
  let belowSupportStart = 0;
  let structuralBreaks = 0;
  let canBreakSupport = true;

  for (let index = 1; index < era.length; index += 1) {
    const level = smoothed[index];
    if (!Number.isFinite(level)) continue;

    // Require a higher rating band to persist before ratcheting support upward.
    if (level >= confirmedPeak + PEAK_RATCHET_ELO) {
      abovePeakRun += 1;
      if (abovePeakRun >= peakHoldGames) {
        const heldStart = Math.max(regimeStartIndex, index - peakHoldGames + 1);
        const heldLevel = medianFinite(smoothed.slice(heldStart, index + 1));
        const previousPeak = confirmedPeak;
        if (Number.isFinite(heldLevel) && heldLevel >= previousPeak + PEAK_RATCHET_ELO) {
          supportFloor = Math.max(supportFloor, previousPeak);
          confirmedPeak = heldLevel;
          canBreakSupport = true;
        }
        abovePeakRun = 0;
      }
    } else if (level < confirmedPeak + (PEAK_RATCHET_ELO * 0.5)) {
      abovePeakRun = 0;
    }

    if (canBreakSupport && level < supportFloor - SUPPORT_BREAK_MARGIN) {
      if (belowSupportRun === 0) belowSupportStart = index;
      belowSupportRun += 1;

      if (belowSupportRun >= supportBreakGames) {
        // The smoothed level has genuinely lost the last confirmed support.
        // Start a new regime at the beginning of that sustained break. Do not
        // repeatedly chop a continuing decline; another break is only allowed
        // after the new regime establishes and holds a higher band.
        regimeStartIndex = Math.max(0, belowSupportStart);
        const resetLevel = smoothed[index];
        supportFloor = resetLevel;
        confirmedPeak = resetLevel;
        abovePeakRun = 0;
        belowSupportRun = 0;
        structuralBreaks += 1;
        canBreakSupport = false;
      }
    } else {
      belowSupportRun = 0;
    }
  }

  const sample = era.slice(regimeStartIndex);
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
  const priorWindowSize = Math.min(baseline.windowSize, regimeStartIndex);
  const priorWindow = priorWindowSize > 0
    ? era.slice(Math.max(0, regimeStartIndex - priorWindowSize), regimeStartIndex)
    : [];
  const preClimbBaselineRating = priorWindow.length
    ? medianFinite(priorWindow.map((row) => row.playerRating))
    : NaN;
  const effectiveStartRating = Number.isFinite(preClimbBaselineRating)
    ? Math.max(baseline.startRating, preClimbBaselineRating)
    : baseline.startRating;
  const recoveredEloExcluded = Math.max(0, effectiveStartRating - baseline.startRating);
  const ratingGain = baseline.endRating - effectiveStartRating;

  const recentWindow = sample.slice(Math.max(0, sample.length - smoothingWindow));
  const recentSlopePer100 = recentWindow.length >= 2
    ? regressionSlopePerGame(recentWindow, "gameNumber", "playerRating") * 100
    : 0;
  const isActiveClimb = recentSlopePer100 > 10;

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
    recentSlopePer100,
    blockSize: smoothingWindow,
    smoothingWindow,
    supportFloor,
    confirmedPeak,
    structuralBreaks,
    isActiveClimb,
    hardGapDaysBefore,
  };
}

function detectCurrentClimbLeg(macroDetected) {
  const macroSample = macroDetected?.sample || [];
  const DAY = 24 * 60 * 60 * 1000;

  if (macroSample.length < 2) {
    const only = macroSample[0];
    return {
      sample: macroSample,
      startGame: Number(only?.gameNumber) || null,
      endGame: Number(only?.gameNumber) || null,
      startDate: parseGameDate(only?.date),
      endDate: parseGameDate(only?.date),
      durationDays: macroSample.length ? 1 : 0,
      smoothingWindow: macroSample.length,
      recentSlopePer100: 0,
      direction: "flat",
      turnType: "macro",
      turnMagnitude: 0,
      baselineWindowSize: macroSample.length,
      baselineStartRating: Number(only?.playerRating) || 0,
      baselineEndRating: Number(only?.playerRating) || 0,
      preClimbBaselineRating: NaN,
      effectiveStartRating: Number(only?.playerRating) || 0,
      recoveredEloExcluded: 0,
    };
  }

  // The support-floor detector above describes the broad ascent. This second
  // layer finds the most recent directional leg inside that ascent. A leg is
  // separated only by a meaningful smoothed reversal: a real drawdown into a
  // trough before the current rise, or a real run-up into a peak before a
  // current decline. This keeps "career ascent" and "what is happening now"
  // from being forced into the same boundary.
  let smoothingWindow = Math.round(clampNumber(macroSample.length / 30, 9, 21));
  if (smoothingWindow % 2 === 0) smoothingWindow += 1;
  const halfWindow = Math.floor(smoothingWindow / 2);
  const smoothed = macroSample.map((_, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(macroSample.length, index + halfWindow + 1);
    return medianFinite(macroSample.slice(start, end).map((row) => row.playerRating));
  });

  const recentCount = Math.min(
    macroSample.length,
    Math.max(20, Math.min(50, Math.round(macroSample.length * 0.12)))
  );
  const recentRows = macroSample.slice(-recentCount);
  const recentSlopePer100 = recentRows.length >= 2
    ? regressionSlopePerGame(recentRows, "gameNumber", "playerRating") * 100
    : 0;
  const direction = recentSlopePer100 > 10
    ? "up"
    : recentSlopePer100 < -10
      ? "down"
      : "flat";

  const MIN_TURN_ELO = 25;
  const MIN_POST_MOVE_ELO = 15;
  const MIN_TURN_GAMES = Math.max(15, smoothingWindow);
  const MIN_LEG_GAMES = Math.max(18, smoothingWindow);
  const localRadius = Math.max(3, Math.floor(smoothingWindow / 3));
  let legStartIndex = 0;
  let turnType = "macro";
  let turnMagnitude = 0;

  const isLocalMin = (index) => {
    const start = Math.max(0, index - localRadius);
    const end = Math.min(smoothed.length, index + localRadius + 1);
    const neighborhood = smoothed.slice(start, end).filter(Number.isFinite);
    return neighborhood.length && smoothed[index] <= Math.min(...neighborhood);
  };
  const isLocalMax = (index) => {
    const start = Math.max(0, index - localRadius);
    const end = Math.min(smoothed.length, index + localRadius + 1);
    const neighborhood = smoothed.slice(start, end).filter(Number.isFinite);
    return neighborhood.length && smoothed[index] >= Math.max(...neighborhood);
  };

  if (direction === "up") {
    // Walk backward to the most recent significant trough that followed a
    // sustained drawdown and from which the account has made a meaningful
    // recovery. This is the start of the current climbing leg.
    for (let trough = smoothed.length - MIN_LEG_GAMES - 1; trough >= MIN_TURN_GAMES; trough -= 1) {
      if (!Number.isFinite(smoothed[trough]) || !isLocalMin(trough)) continue;

      let peakIndex = 0;
      let peakLevel = -Infinity;
      for (let index = 0; index < trough; index += 1) {
        if (Number.isFinite(smoothed[index]) && smoothed[index] > peakLevel) {
          peakLevel = smoothed[index];
          peakIndex = index;
        }
      }

      const drawdown = peakLevel - smoothed[trough];
      const postGain = smoothed[smoothed.length - 1] - smoothed[trough];
      if (
        drawdown >= MIN_TURN_ELO
        && postGain >= MIN_POST_MOVE_ELO
        && (trough - peakIndex) >= MIN_TURN_GAMES
      ) {
        legStartIndex = trough;
        turnType = "trough";
        turnMagnitude = drawdown;
        break;
      }
    }
  } else if (direction === "down") {
    // Mirror the rule for a currently declining account so the score can call
    // out a floundering leg instead of averaging the fall into an old climb.
    for (let peak = smoothed.length - MIN_LEG_GAMES - 1; peak >= MIN_TURN_GAMES; peak -= 1) {
      if (!Number.isFinite(smoothed[peak]) || !isLocalMax(peak)) continue;

      let troughIndex = 0;
      let troughLevel = Infinity;
      for (let index = 0; index < peak; index += 1) {
        if (Number.isFinite(smoothed[index]) && smoothed[index] < troughLevel) {
          troughLevel = smoothed[index];
          troughIndex = index;
        }
      }

      const runUp = smoothed[peak] - troughLevel;
      const decline = smoothed[peak] - smoothed[smoothed.length - 1];
      if (
        decline >= MIN_TURN_ELO
        && runUp >= MIN_POST_MOVE_ELO
        && (peak - troughIndex) >= MIN_TURN_GAMES
      ) {
        legStartIndex = peak;
        turnType = "peak";
        turnMagnitude = decline;
        break;
      }
    }
  }

  const sample = macroSample.slice(legStartIndex);
  const first = sample[0];
  const last = sample[sample.length - 1];
  const firstTime = parseGameDate(first?.date);
  const lastTime = parseGameDate(last?.date);
  const durationDays = Number.isFinite(firstTime) && Number.isFinite(lastTime)
    ? Math.max(1, Math.floor((lastTime - firstTime) / DAY) + 1)
    : 0;
  const baseline = representativeClimbEndpoints(sample);

  const priorWindowSize = Math.min(baseline.windowSize, legStartIndex);
  const priorWindow = priorWindowSize > 0
    ? macroSample.slice(Math.max(0, legStartIndex - priorWindowSize), legStartIndex)
    : [];
  const preClimbBaselineRating = priorWindow.length
    ? medianFinite(priorWindow.map((row) => row.playerRating))
    : NaN;
  const effectiveStartRating = Number.isFinite(preClimbBaselineRating)
    ? Math.max(baseline.startRating, preClimbBaselineRating)
    : baseline.startRating;
  const recoveredEloExcluded = Math.max(0, effectiveStartRating - baseline.startRating);

  return {
    sample,
    startGame: Number(first?.gameNumber) || null,
    endGame: Number(last?.gameNumber) || null,
    startDate: firstTime,
    endDate: lastTime,
    durationDays,
    smoothingWindow,
    recentSlopePer100,
    direction,
    turnType,
    turnMagnitude,
    baselineWindowSize: baseline.windowSize,
    baselineStartRating: baseline.startRating,
    baselineEndRating: baseline.endRating,
    preClimbBaselineRating,
    effectiveStartRating,
    recoveredEloExcluded,
  };
}


function summarizeDirectionalLeg(sample) {
  if (!sample?.length) {
    return {
      sampleSize: 0,
      startGame: null,
      endGame: null,
      ratingGain: 0,
      pacePer100: 0,
      direction: "flat",
      directionStrength: 0,
      maturity: 0,
    };
  }

  const baseline = representativeClimbEndpoints(sample);
  const gameSpan = Math.max(1, baseline.endGame - baseline.startGame);
  const ratingGain = baseline.endRating - baseline.startRating;
  const pacePer100 = (ratingGain / gameSpan) * 100;
  const direction = pacePer100 > 10 ? "up" : pacePer100 < -10 ? "down" : "flat";

  // Compress both speed and distance into a bounded directional signal. This is
  // intentionally used only as historical evidence, not as another headline
  // performance score. Longer legs are more trustworthy than tiny reversals.
  const paceSignal = Math.tanh(pacePer100 / 60);
  const gainSignal = Math.tanh(ratingGain / 80);
  const directionStrength = clampNumber((paceSignal * 0.60) + (gainSignal * 0.40), -1, 1);
  const maturity = clampNumber(1 - Math.exp(-sample.length / 60), 0, 1);

  return {
    sampleSize: sample.length,
    startGame: Number(sample[0]?.gameNumber) || null,
    endGame: Number(sample[sample.length - 1]?.gameNumber) || null,
    ratingGain,
    pacePer100,
    direction,
    directionStrength,
    maturity,
  };
}

function detectPastDirectionalLegs(macroDetected, currentLeg, maxLegs = 8) {
  const macroSample = macroDetected?.sample || [];
  if (macroSample.length < 2 || !currentLeg?.startGame) return [];

  let boundaryIndex = macroSample.findIndex(
    (game) => Number(game.gameNumber) === Number(currentLeg.startGame)
  );
  if (boundaryIndex <= 0) return [];

  const legs = [];
  let prefix = macroSample.slice(0, boundaryIndex + 1);
  let guard = 0;

  while (prefix.length >= 2 && legs.length < maxLegs && guard < maxLegs + 2) {
    guard += 1;
    const previous = detectCurrentClimbLeg({ sample: prefix });
    if (!previous?.sample?.length || previous.sample.length < 2) break;

    const summary = summarizeDirectionalLeg(previous.sample);
    legs.push({
      ...summary,
      turnType: previous.turnType,
      turnMagnitude: previous.turnMagnitude,
    });

    const previousStartIndex = prefix.findIndex(
      (game) => Number(game.gameNumber) === Number(previous.startGame)
    );
    if (previous.turnType === "macro" || previousStartIndex <= 0) break;

    const nextPrefix = prefix.slice(0, previousStartIndex + 1);
    if (nextPrefix.length >= prefix.length) break;
    prefix = nextPrefix;
  }

  return legs;
}

function historicalLegEvidence({ pastLegs, currentDirection, currentEndGame, structuralBreaks = 0 }) {
  if (!pastLegs?.length || !Number.isFinite(Number(currentEndGame)) || currentDirection === "flat") {
    return {
      historySupportScore: 50,
      historicalAlignment: 0,
      supportiveCarryGames: 0,
      effectivePastLegs: 0,
      continuityMultiplier: 1,
    };
  }

  const directionSign = currentDirection === "down" ? -1 : 1;
  const HALF_LIFE_GAMES = 100;
  let weightedSignal = 0;
  let totalWeight = 0;
  let supportiveCarryGames = 0;
  let effectivePastLegs = 0;

  for (const leg of pastLegs) {
    if (!Number.isFinite(Number(leg.endGame))) continue;
    const gamesAgo = Math.max(0, Number(currentEndGame) - Number(leg.endGame));
    const recencyWeight = 2 ** (-gamesAgo / HALF_LIFE_GAMES);
    const evidenceWeight = recencyWeight * clampNumber(leg.maturity, 0, 1);
    if (evidenceWeight <= 0) continue;

    const alignedStrength = clampNumber(leg.directionStrength * directionSign, -1, 1);
    weightedSignal += alignedStrength * evidenceWeight;
    totalWeight += evidenceWeight;
    supportiveCarryGames += leg.sampleSize * evidenceWeight * Math.max(0, alignedStrength);
    effectivePastLegs += 1;
  }

  const historicalAlignment = totalWeight > 0
    ? clampNumber(weightedSignal / totalWeight, -1, 1)
    : 0;

  // A macro regime with repeated structural support breaks should not carry as
  // much old evidence into the current trend leg. Zero breaks preserves all of it;
  // each break progressively reduces, rather than abruptly deletes, history.
  const continuityMultiplier = Math.exp(-0.35 * Math.max(0, structuralBreaks));
  supportiveCarryGames *= continuityMultiplier;

  return {
    historySupportScore: clampNumber(50 + (historicalAlignment * 50), 0, 100),
    historicalAlignment,
    supportiveCarryGames,
    effectivePastLegs,
    continuityMultiplier,
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
      gapControlScore: 100,
      velocityScore: 0,
      calendarVelocityScore: 0,
      pressureScore: 0,
      consistencyScore: 0,
      drawdownScore: 0,
      climbStartGame: null,
      climbEndGame: null,
      climbStartRating: 0,
      climbEndRating: 0,
      climbStartDate: null,
      climbEndDate: null,
      climbDurationDays: 0,
      climbRatingGain: 0,
      macroStartGame: null,
      macroEndGame: null,
      macroStartDate: null,
      macroEndDate: null,
      macroSampleSize: 0,
      macroDurationDays: 0,
      macroRatingGain: 0,
      currentLegTurnType: "macro",
      currentLegTurnMagnitude: 0,
      currentLegDirection: "flat",
      currentLegSmoothingWindow: 0,
      recentSlopePer100: 0,
      isActiveClimb: false,
      hardGapDaysBefore: 0,
      detectorBlockSize: 0,
      detectorSmoothingWindow: 0,
      detectorSupportFloor: NaN,
      detectorConfirmedPeak: NaN,
      detectorStructuralBreaks: 0,
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
      historySupportScore: 50,
      historicalAlignment: 0,
      supportiveCarryGames: 0,
      effectiveEvidenceGames: 0,
      pastLegCount: 0,
      historyContinuityMultiplier: 1,
    };
  }

  const macroDetected = detectCurrentClimbWindow(chronological);
  const legDetected = detectCurrentClimbLeg(macroDetected);
  const pastLegs = detectPastDirectionalLegs(macroDetected, legDetected);
  const historyEvidence = historicalLegEvidence({
    pastLegs,
    currentDirection: legDetected.direction,
    currentEndGame: legDetected.endGame,
    structuralBreaks: macroDetected.structuralBreaks || 0,
  });
  const sample = legDetected.sample.length
    ? legDetected.sample
    : (macroDetected.sample.length ? macroDetected.sample : chronological.slice(-100));
  const baseline = representativeClimbEndpoints(sample);
  const baselineGameSpan = Math.max(1, baseline.endGame - baseline.startGame);
  const effectiveStartRating = Number.isFinite(legDetected.effectiveStartRating)
    ? legDetected.effectiveStartRating
    : baseline.startRating;
  const freshRatingGain = baseline.endRating - effectiveStartRating;

  const macroSample = macroDetected.sample.length ? macroDetected.sample : sample;
  const macroBaseline = representativeClimbEndpoints(macroSample);
  const macroEffectiveStartRating = Number.isFinite(macroDetected.effectiveStartRating)
    ? macroDetected.effectiveStartRating
    : macroBaseline.startRating;
  const macroRatingGain = macroBaseline.endRating - macroEffectiveStartRating;

  // Distinguish rating recovery from genuinely new account territory, but do
  // not let provisional placement ratings define the account's lifetime peak.
  // Established history begins at the first sustained climb detected anywhere
  // on the account. Ratings before that point are still graphed and analyzed;
  // they are excluded only from the historical-peak/new-territory test.
  const establishedHistory = detectEstablishedRatingHistoryStart(chronological);
  const detectedStartIndexRaw = chronological.findIndex(
    (game) => Number(game.gameNumber) === Number(legDetected.startGame)
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
  let gapControlScore = 100;
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
    gapControlScore = 100;
    if (longestGapDays > 14) gapControlScore -= (Math.min(longestGapDays, 30) - 14) * 1.25;
    if (longestGapDays > 30) gapControlScore -= (Math.min(longestGapDays, 60) - 30) * 1.0;
    if (longestGapDays > 60) gapControlScore -= (Math.min(longestGapDays, 90) - 60) * 1.5;
    gapControlScore = clampNumber(gapControlScore, 0, 100);

    cadenceScore = clampNumber(
      (volumeRegularityScore * 0.50)
        + (activeWeekPct * 0.30)
        + (gapControlScore * 0.20),
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

  // A short explosive run is useful evidence, but it is not as established as
  // a climb that has survived hundreds of games. Treat current-leg length as
  // confidence in the measured climb quality rather than as another hand-tuned
  // performance bucket. Confidence rises smoothly toward 100% with diminishing
  // returns, reaching about 63% at 100 games, 86% at 200, and 95% at 300.
  const effectiveEvidenceGames = sample.length + historyEvidence.supportiveCarryGames;
  const maturityConfidence = clampNumber(
    1 - Math.exp(-effectiveEvidenceGames / 100),
    0,
    1
  );
  const maturityAdjustedScore = clampNumber(
    50 + (maturityConfidence * (rawScore - 50)),
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
    scoreCap = legDetected.recentSlopePer100 < -10 ? 45 : 60;
  } else if (legDetected.recentSlopePer100 <= 10) {
    scoreCap = 70;
  }
  const score = Math.min(maturityAdjustedScore, scoreCap);
  const label = climbStateLabel({
    score,
    endVsMean,
    recentSlopePer100: legDetected.recentSlopePer100,
    newTerritoryGain,
  });

  return {
    score,
    rawScore,
    maturityAdjustedScore,
    maturityConfidence,
    historySupportScore: historyEvidence.historySupportScore,
    historicalAlignment: historyEvidence.historicalAlignment,
    supportiveCarryGames: historyEvidence.supportiveCarryGames,
    effectiveEvidenceGames,
    pastLegCount: historyEvidence.effectivePastLegs,
    historyContinuityMultiplier: historyEvidence.continuityMultiplier,
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
    gapControlScore,
    gainScore,
    newTerritoryScore,
    velocityScore,
    calendarVelocityScore,
    pressureScore,
    consistencyScore,
    drawdownScore,
    climbStartGame: legDetected.startGame,
    climbEndGame: legDetected.endGame,
    climbStartRating: Number(sample[0]?.playerRating) || baseline.startRating,
    climbEndRating: Number(sample[sample.length - 1]?.playerRating) || baseline.endRating,
    climbStartDate: legDetected.startDate,
    climbEndDate: legDetected.endDate,
    climbDurationDays: legDetected.durationDays,
    climbRatingGain: freshRatingGain,
    macroStartGame: macroDetected.startGame,
    macroEndGame: macroDetected.endGame,
    macroStartDate: macroDetected.startDate,
    macroEndDate: macroDetected.endDate,
    macroSampleSize: macroSample.length,
    macroDurationDays: macroDetected.durationDays,
    macroRatingGain,
    currentLegTurnType: legDetected.turnType,
    currentLegTurnMagnitude: legDetected.turnMagnitude,
    currentLegDirection: legDetected.direction,
    currentLegSmoothingWindow: legDetected.smoothingWindow,
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
    recentSlopePer100: legDetected.recentSlopePer100,
    isActiveClimb: legDetected.recentSlopePer100 > 10,
    hardGapDaysBefore: macroDetected.hardGapDaysBefore,
    detectorBlockSize: macroDetected.blockSize,
    detectorSmoothingWindow: macroDetected.smoothingWindow || macroDetected.blockSize,
    detectorSupportFloor: macroDetected.supportFloor,
    detectorConfirmedPeak: macroDetected.confirmedPeak,
    detectorStructuralBreaks: macroDetected.structuralBreaks || 0,
    baselineWindowSize: baseline.windowSize,
    baselineStartRating: baseline.startRating,
    baselineEndRating: baseline.endRating,
    preClimbBaselineRating: legDetected.preClimbBaselineRating,
    effectiveStartRating,
    recoveredEloExcluded: legDetected.recoveredEloExcluded || 0,
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
  const [activePage, setActivePage] = useState(() => {
    if (typeof window === "undefined") return "overview";
    const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase();
    if (hash === "statistics") return "statistics";
    if (hash === "games" || hash === "game-history") return "games";
    return "overview";
  });
  const GAMES_PER_PAGE = 50;
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [username, setUsername] = useState(() => currentProfileUsername());
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
  const [ratingEraSelection, setRatingEraSelection] = useState(null);
  const [gameHistoryRange, setGameHistoryRange] = useState(null);
  const [chartWindowMode, setChartWindowMode] = useState("games");
  const [chartWindowRanges, setChartWindowRanges] = useState({});
  const abortRef = useRef(null);
  const phaseRefreshTokenRef = useRef(0);

  useEffect(() => {
    const syncLocationState = () => {
      const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase();
      if (hash === "statistics") setActivePage("statistics");
      else if (hash === "games" || hash === "game-history") setActivePage("games");
      else setActivePage("overview");

      // Browser back/forward can change the profile pathname without reloading
      // React. Keep the username state in sync with the URL as well.
      const routedUsername = usernameFromProfilePath();
      if (routedUsername) setUsername(routedUsername);
    };
    window.addEventListener("hashchange", syncLocationState);
    window.addEventListener("popstate", syncLocationState);
    return () => {
      window.removeEventListener("hashchange", syncLocationState);
      window.removeEventListener("popstate", syncLocationState);
    };
  }, []);

  function navigatePage(page) {
    setActivePage(page);
    const nextHash = page === "overview" ? "#overview" : page === "statistics" ? "#statistics" : "#game-history";
    if (window.location.hash !== nextHash) window.history.pushState(null, "", nextHash);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setProfileUrl(player, { replace = false } = {}) {
    if (typeof window === "undefined") return;
    const path = canonicalProfilePath(player);
    if (path === "/") return;
    const hash = window.location.hash || "#overview";
    const nextUrl = `${path}${hash}`;
    const currentUrl = `${window.location.pathname}${window.location.hash}`;
    if (currentUrl === nextUrl) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  }

  function openGameHistoryRange(range) {
    const startGame = Number(range?.startGame);
    const endGame = Number(range?.endGame);
    if (!Number.isFinite(startGame) || !Number.isFinite(endGame)) return;

    setGameHistoryRange({
      startGame: Math.min(startGame, endGame),
      endGame: Math.max(startGame, endGame),
    });
    setSearch("");
    setFilter("all");
    setGamePage(1);
    setExpandedGame(null);
    navigatePage("games");
  }

  useEffect(() => {
    // Every loaded profile has a stable, shareable public URL. On the legacy
    // root route, canonicalize the current profile without adding history.
    if (!usernameFromProfilePath() && username.trim()) {
      setProfileUrl(username, { replace: true });
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(USERNAME_STORAGE_KEY, username);
    } catch {
      // Local storage is optional; the dashboard still works without it.
    }
  }, [username]);

  useEffect(() => {
    if (typeof document !== "undefined" && username.trim()) {
      document.title = `${username.trim()} Chess Dashboard`;
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
    if (!chartRangeSelection && !ratingEraSelection) return undefined;

    const clearRangeOnClick = (event) => {
      // Keep explicit range actions usable; every other click clears highlights,
      // including clicks directly on a chart. A new drag can immediately create
      // a fresh selection after the pointer-down clear.
      if (event.target?.closest?.(".range-selection-action")) return;
      setChartRangeSelection(null);
      setRatingEraSelection(null);
    };

    document.addEventListener("pointerdown", clearRangeOnClick);
    return () => document.removeEventListener("pointerdown", clearRangeOnClick);
  }, [chartRangeSelection, ratingEraSelection]);

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
      // Resolve the profile from the address bar at execution time. This makes
      // a cold direct visit to /player/<username> independent of localStorage
      // and of any previous visit to the site.
      const player = currentProfileUsername(username).trim().toLowerCase();
      if (!player) return;

      if (username.trim().toLowerCase() !== player) setUsername(player);

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
        if (e?.name !== "AbortError") {
          console.debug("Browser cache was not auto-loaded:", e);
          if (!cancelled) setError(e?.message || "Could not load this public profile.");
        }
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

    setProfileUrl(player, { replace: true });

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
    setRatingEraSelection(null);
    setGameHistoryRange(null);
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

        const gameNumber = Number(g.gameNumber);
        const rangeOK = !gameHistoryRange || (
          Number.isFinite(gameNumber)
          && gameNumber >= gameHistoryRange.startGame
          && gameNumber <= gameHistoryRange.endGame
        );

        return resultOK && searchOK && rangeOK;
      })
      .sort((a, b) => b.gameNumber - a.gameNumber);
  }, [games, filter, search, gameHistoryRange]);

  const totalGamePages = Math.max(
    1,
    Math.ceil(filteredGames.length / GAMES_PER_PAGE)
  );

  const pagedGames = useMemo(() => {
    const start = (gamePage - 1) * GAMES_PER_PAGE;
    return filteredGames.slice(start, start + GAMES_PER_PAGE);
  }, [filteredGames, gamePage]);

  const overviewGames = useMemo(() => [...games]
    .sort((a, b) => Number(b.gameNumber) - Number(a.gameNumber))
    .slice(0, 10), [games]);

  const pageRecord = useMemo(() => {
    const wins = pagedGames.filter((game) => game.result === "win").length;
    const losses = pagedGames.filter((game) => game.result === "loss").length;
    const draws = pagedGames.filter((game) => game.result === "draw").length;
    const total = pagedGames.length;
    return {
      wins,
      losses,
      draws,
      total,
      winRate: total ? (wins / total) * 100 : 0,
    };
  }, [pagedGames]);

  const toggleGame = (gameNumber) => {
    setExpandedGame((current) => current === gameNumber ? null : gameNumber);
  };

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
    const performance = calculatePerformanceMetrics(games);

    return {
      wins,
      losses,
      draws,
      latestRating: latest?.playerRating ?? 0,
      climb,
      performance,
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

      <nav className="dashboard-nav" aria-label="Dashboard pages">
        {[
          ["overview", "Overview"],
          ["statistics", "Statistics"],
          ["games", "Game history"],
        ].map(([page, label]) => (
          <button
            key={page}
            type="button"
            className={`dashboard-nav-item ${activePage === page ? "active" : ""}`}
            aria-current={activePage === page ? "page" : undefined}
            onClick={() => {
              if (page === "games") setGameHistoryRange(null);
              navigatePage(page);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="main">
        {status && !/^(Loaded|Hydrated)\b/.test(status) && <div className="notice">{status}</div>}
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
            {activePage === "overview" && (
              <>
                <section className="overview-hero-grid">
                  <div className="overview-rating-column">
                    <RatingOverview
                      games={games}
                      currentRating={stats.latestRating}
                      climb={stats.climb}
                      wins={stats.wins}
                      losses={stats.losses}
                      draws={stats.draws}
                      selection={ratingEraSelection}
                      onSelectionChange={setRatingEraSelection}
                      onViewSelectedGames={openGameHistoryRange}
                    />
                  </div>

                  <aside className="overview-score-rail" aria-label="Performance and climb summary">
                    <section className="headline-metrics is-single overview-strength-card">
                      <PerformanceMetric performance={stats.performance} />
                    </section>

                    <section className="climb-feature-row">
                      <ClimbScoreMetric climb={stats.climb} />
                    </section>
                  </aside>
                </section>

                <section className="card table-card overview-games-card">
                  <div className="table-header overview-games-header">
                    <div>
                      <div className="page-eyebrow">Recent activity</div>
                      <h2>Recent games</h2>
                    </div>
                    <button
                      className="button overview-games-link"
                      type="button"
                      onClick={() => {
                        setGameHistoryRange(null);
                        navigatePage("games");
                      }}
                    >
                      View all games
                    </button>
                  </div>

                  <GameTable
                    games={overviewGames}
                    movesByGame={movesByGame}
                    expandedGame={expandedGame}
                    onToggle={toggleGame}
                  />
                </section>
              </>
            )}

            {activePage === "statistics" && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="page-eyebrow">Analysis</div>
                    <h2>Statistics</h2>
                  </div>
                  <p>Longitudinal trends across the games in your active graph window.</p>
                </div>

            {chartWindowBounds && activeChartWindow && (
              <section className="chart-window" aria-label="Graph filters">
                <details className="chart-filter-details">
                  <summary className="chart-filter-summary">
                    <div className="chart-filter-summary-copy">
                      <div className="chart-window-title">Graph filters</div>
                      <div className="chart-window-summary">{chartWindowSummary}</div>
                    </div>
                    <div className="chart-filter-summary-meta">
                      {anyChartWindowFiltered && (
                        <span className="chart-filter-count">
                          {Object.values(chartWindowFilteredByMode).filter(Boolean).length} active
                        </span>
                      )}
                      <ChevronDown className="chart-filter-chevron" size={16} aria-hidden="true" />
                    </div>
                  </summary>

                  <div className="chart-filter-body">
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

                      <div className="chart-window-quick-actions">
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

                    <div className="chart-window-hint">Games, date, and rating filters stack together.</div>

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
                  </div>
                </details>
              </section>
            )}

            <div className="chart-note">
              Charts summarize {chartGames.length.toLocaleString()} active games into about 20 buckets. Drag any chart to analyze a shared range; click outside the charts to clear it.
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
              </>
            )}

            {activePage === "games" && (
            <section className="card table-card">
              <div className="table-header game-history-header">
                <div className="game-history-title-row">
                  <h2>Game history</h2>
                  <div className="page-record-inline" aria-label="Record for games on this page">
                    <span className="page-record-winrate"><strong>{pageRecord.winRate.toFixed(1)}%</strong><small>win</small></span>
                    <span className="page-record-win">{pageRecord.wins}W</span>
                    <span className="page-record-draw">{pageRecord.draws}D</span>
                    <span className="page-record-loss">{pageRecord.losses}L</span>
                    <span className="page-record-range">
                      {filteredGames.length ? ((gamePage - 1) * GAMES_PER_PAGE + 1) : 0}
                      –{Math.min(gamePage * GAMES_PER_PAGE, filteredGames.length)} / {filteredGames.length}
                    </span>
                  </div>
                </div>

                {gameHistoryRange && (
                  <div className="game-history-era-row">
                    <span>Selected rating era</span>
                    <button
                      type="button"
                      className="game-history-era-filter"
                      onClick={() => {
                        setGameHistoryRange(null);
                        setGamePage(1);
                      }}
                    >
                      Games #{Math.round(gameHistoryRange.startGame).toLocaleString()}–#{Math.round(gameHistoryRange.endGame).toLocaleString()}
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                )}

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
              </div>

              <GameTable
                games={pagedGames}
                movesByGame={movesByGame}
                expandedGame={expandedGame}
                onToggle={toggleGame}
              />

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
            )}
          </>
        ) : null}
      </main>
      <div className="app-version" aria-label={`App version ${APP_VERSION}`}>
        v{APP_VERSION}
      </div>
    </div>
  );
}
