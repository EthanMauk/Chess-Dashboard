import React, { useMemo, useState } from "react";
import {
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function regressionStats(points, key) {
  const rows = points
    .map((point) => ({ x: finiteNumber(point.game), y: finiteNumber(point[key]) }))
    .filter((row) => row.x !== null && row.y !== null);

  if (!rows.length) return null;

  const meanY = rows.reduce((sum, row) => sum + row.y, 0) / rows.length;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = last.y - first.y;

  if (rows.length < 2) {
    return { mean: meanY, delta: 0, slopePer100: 0, r2: null, count: rows.length };
  }

  const meanX = rows.reduce((sum, row) => sum + row.x, 0) / rows.length;
  let ssX = 0;
  let covariance = 0;

  for (const row of rows) {
    const dx = row.x - meanX;
    ssX += dx * dx;
    covariance += dx * (row.y - meanY);
  }

  const slope = ssX ? covariance / ssX : 0;
  const intercept = meanY - slope * meanX;
  let ssResidual = 0;
  let ssTotal = 0;

  for (const row of rows) {
    const predicted = intercept + slope * row.x;
    ssResidual += (row.y - predicted) ** 2;
    ssTotal += (row.y - meanY) ** 2;
  }

  const r2 = rows.length >= 3
    ? (ssTotal > 0 ? Math.max(0, Math.min(1, 1 - ssResidual / ssTotal)) : 1)
    : null;

  return {
    mean: meanY,
    delta,
    slopePer100: slope * 100,
    r2,
    count: rows.length,
  };
}

function formatNumber(value, decimals = 1, signed = false) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (!signed || value === 0) return `${value < 0 ? "−" : ""}${abs}`;
  return `${value > 0 ? "+" : "−"}${abs}`;
}

export default function RangeLineChart({
  data,
  metrics = [],
  detailKey,
  selection = null,
  onSelectionChange,
  children,
}) {
  const [dragStartGame, setDragStartGame] = useState(null);
  const [dragCurrentGame, setDragCurrentGame] = useState(null);

  const gameForLabel = (label) => {
    const point = data.find((item) => String(item.game) === String(label));
    return point ? finiteNumber(point.game) : null;
  };

  const beginSelection = (state) => {
    if (state?.activeLabel == null) return;
    const game = gameForLabel(state.activeLabel);
    if (game === null) return;
    setDragStartGame(game);
    setDragCurrentGame(game);
  };

  const moveSelection = (state) => {
    if (dragStartGame === null || state?.activeLabel == null) return;
    const game = gameForLabel(state.activeLabel);
    if (game === null) return;

    setDragCurrentGame(game);
    if (game !== dragStartGame) {
      onSelectionChange?.({
        startGame: Math.min(dragStartGame, game),
        endGame: Math.max(dragStartGame, game),
      });
    }
  };

  const finishSelection = () => {
    if (dragStartGame === null) return;
    const endGame = dragCurrentGame ?? dragStartGame;
    if (endGame !== dragStartGame) {
      onSelectionChange?.({
        startGame: Math.min(dragStartGame, endGame),
        endGame: Math.max(dragStartGame, endGame),
      });
    }
    setDragStartGame(null);
    setDragCurrentGame(null);
  };

  const normalizedSelection = useMemo(() => {
    const startGame = finiteNumber(selection?.startGame);
    const endGame = finiteNumber(selection?.endGame);
    if (startGame === null || endGame === null || !data.length) return null;
    return {
      startGame: Math.min(startGame, endGame),
      endGame: Math.max(startGame, endGame),
    };
  }, [data.length, selection?.startGame, selection?.endGame]);

  const activeBounds = dragStartGame !== null
    ? {
        startGame: Math.min(dragStartGame, dragCurrentGame ?? dragStartGame),
        endGame: Math.max(dragStartGame, dragCurrentGame ?? dragStartGame),
      }
    : normalizedSelection;

  const selectedPoints = useMemo(() => {
    if (!normalizedSelection) return [];
    return data.filter((point) => {
      const game = finiteNumber(point.game);
      return game !== null
        && game >= normalizedSelection.startGame
        && game <= normalizedSelection.endGame;
    });
  }, [data, normalizedSelection]);

  const metricStats = useMemo(() => metrics
    .map((metric) => ({ ...metric, stats: regressionStats(selectedPoints, metric.key) }))
    .filter((metric) => metric.stats), [metrics, selectedPoints]);

  const detailMetric = metricStats.find((metric) => metric.key === detailKey) || metricStats[0];
  const secondaryMetrics = metricStats.filter((metric) => metric !== detailMetric);

  const firstSelected = selectedPoints[0];
  const lastSelected = selectedPoints[selectedPoints.length - 1];
  const rangeStart = firstSelected?.range ? String(firstSelected.range).split("-")[0] : firstSelected?.game;
  const rangeEnd = lastSelected?.range ? String(lastSelected.range).split("-").at(-1) : lastSelected?.game;

  return (
    <div className="range-chart-shell">
      <div className="range-chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            onMouseDown={beginSelection}
            onMouseMove={moveSelection}
            onMouseUp={finishSelection}
            onMouseLeave={finishSelection}
          >
            {children}
            {activeBounds && (
              <ReferenceArea
                x1={activeBounds.startGame}
                x2={activeBounds.endGame}
                fill="#58a6ff"
                fillOpacity={0.09}
                stroke="#58a6ff"
                strokeOpacity={0.4}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className={`range-analysis ${normalizedSelection ? "has-selection" : ""}`}>
        {!normalizedSelection || !detailMetric ? (
          <span>Drag across the chart to analyze a range.</span>
        ) : (
          <>
            <div className="range-analysis-main">
              <strong>Games {rangeStart}–{rangeEnd}</strong>
              <span>{selectedPoints.length} plotted points</span>
              <span>
                {detailMetric.label} avg {formatNumber(detailMetric.stats.mean, detailMetric.decimals ?? 1)}
                {detailMetric.suffix || ""}
              </span>
              <span>
                Δ {formatNumber(detailMetric.stats.delta, detailMetric.decimals ?? 1, true)}
                {detailMetric.suffix || ""}
              </span>
              <span>
                trend {formatNumber(detailMetric.stats.slopePer100, detailMetric.slopeDecimals ?? detailMetric.decimals ?? 1, true)}
                {detailMetric.slopeSuffix || `${detailMetric.suffix || ""} / 100 games`}
              </span>
              {detailMetric.stats.r2 !== null && (
                <span>R² {detailMetric.stats.r2.toFixed(2)}</span>
              )}
            </div>
            {!!secondaryMetrics.length && (
              <div className="range-analysis-secondary">
                {secondaryMetrics.map((metric) => (
                  <span key={metric.key}>
                    {metric.label}: {formatNumber(metric.stats.slopePer100, metric.slopeDecimals ?? metric.decimals ?? 1, true)}
                    {metric.slopeSuffix || `${metric.suffix || ""} / 100 games`}
                    {metric.stats.r2 !== null ? ` · R² ${metric.stats.r2.toFixed(2)}` : ""}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
