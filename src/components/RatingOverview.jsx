import React, { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import RangeLineChart from "./RangeLineChart";

function formatDisplayDate(value) {
  const text = String(value || "").trim();
  if (!text) return "—";
  const normalized = text.replaceAll(".", "-");
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return text;
  return new Date(parsed).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function clampPositive(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / (10 ** exponent);
  let niceFraction = 1;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * (10 ** exponent);
}

function buildNiceAxis(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) {
    return { domain: [0, 1000], ticks: [0, 200, 400, 600, 800, 1000] };
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);

  if (min === max) {
    const step = min >= 1000 ? 100 : min >= 500 ? 50 : 25;
    const start = Math.max(0, min - (step * 2));
    return {
      domain: [start, min + (step * 2)],
      ticks: [start, start + step, start + (step * 2), start + (step * 3), start + (step * 4)],
    };
  }

  const range = max - min;
  const targetIntervals = 4;
  const step = niceStep(range / targetIntervals);
  const domainMin = Math.max(0, Math.floor(min / step) * step);
  const domainMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = domainMin; value <= domainMax + (step * 0.001); value += step) {
    ticks.push(Number(value.toFixed(6)));
  }

  if (ticks.length < 4) {
    const fallbackStep = step / 2;
    const fallbackTicks = [];
    const fallbackMin = Math.max(0, Math.floor(min / fallbackStep) * fallbackStep);
    const fallbackMax = Math.ceil(max / fallbackStep) * fallbackStep;
    for (let value = fallbackMin; value <= fallbackMax + (fallbackStep * 0.001); value += fallbackStep) {
      fallbackTicks.push(Number(value.toFixed(6)));
    }
    return {
      domain: [fallbackMin, fallbackMax],
      ticks: fallbackTicks,
    };
  }

  return {
    domain: [domainMin, domainMax],
    ticks,
  };
}

function RatingTooltip({ active, payload, coordinate }) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div
      className="custom-chart-tooltip rating-hover-tooltip"
      style={{
        position: "absolute",
        left: (coordinate?.x ?? 0) + 20,
        top: Math.max(8, (coordinate?.y ?? 0) - 18),
      }}
    >
      <div className="custom-chart-tooltip-label">Game #{point.game.toLocaleString()}</div>
      <div className="custom-chart-tooltip-row">
        <span>Rating</span>
        <strong>{Math.round(point.rating).toLocaleString()} Elo</strong>
      </div>
      <div className="custom-chart-tooltip-row">
        <span>Date</span>
        <strong>{formatDisplayDate(point.date)}</strong>
      </div>
    </div>
  );
}

function RecordPanel({ wins, draws, losses, className = "" }) {
  const totalGames = Number(wins) + Number(losses) + Number(draws);
  const winRate = totalGames ? (Number(wins) / totalGames) * 100 : 0;
  const drawRate = totalGames ? (Number(draws) / totalGames) * 100 : 0;
  const lossRate = totalGames ? (Number(losses) / totalGames) * 100 : 0;
  const scoreRate = totalGames ? ((Number(wins) + Number(draws) * 0.5) / totalGames) * 100 : 0;

  return (
    <div className={`rating-record-panel ${className}`.trim()} aria-label="Overall record summary">
      <div className="rating-record-heading">
        <div>
          <span className="rating-overview-label">Record</span>
          <strong className="rating-record-inline">
            <span className="rating-record-win">{Number(wins).toLocaleString()}W</span>
            <span className="rating-record-draw">{Number(draws).toLocaleString()}D</span>
            <span className="rating-record-loss">{Number(losses).toLocaleString()}L</span>
          </strong>
        </div>
        <div className="rating-winrate-block">
          <span className="rating-overview-label">Win rate</span>
          <strong>{winRate.toFixed(1)}%</strong>
        </div>
      </div>

      <div
        className="rating-record-bar"
        role="img"
        aria-label={`${winRate.toFixed(1)}% wins, ${drawRate.toFixed(1)}% draws, ${lossRate.toFixed(1)}% losses`}
      >
        <span className="rating-record-bar-win" style={{ width: `${winRate}%` }} />
        <span className="rating-record-bar-draw" style={{ width: `${drawRate}%` }} />
        <span className="rating-record-bar-loss" style={{ width: `${lossRate}%` }} />
      </div>

      <div className="rating-record-meta">
        <span>Score rate <strong>{scoreRate.toFixed(1)}%</strong></span>
        <span>{totalGames.toLocaleString()} games</span>
      </div>
    </div>
  );
}

export default function RatingOverview({
  games,
  currentRating,
  climb,
  wins = 0,
  losses = 0,
  draws = 0,
  selection = null,
  onSelectionChange,
  onViewSelectedGames,
}) {
  const data = useMemo(
    () => [...games]
      .sort((a, b) => Number(a.gameNumber) - Number(b.gameNumber))
      .map((game) => ({
        game: Number(game.gameNumber),
        rating: Number(game.playerRating),
        date: game.date,
        gamesInBucket: 1,
      }))
      .filter((point) => Number.isFinite(point.game) && Number.isFinite(point.rating)),
    [games],
  );

  const ratingAxis = useMemo(
    () => buildNiceAxis(data.map((point) => point.rating)),
    [data],
  );

  const trendStart = clampPositive(climb?.climbStartRating, NaN);
  const trendEnd = clampPositive(climb?.climbEndRating, NaN);
  const trendChange = Number.isFinite(trendStart) && Number.isFinite(trendEnd)
    ? trendEnd - trendStart
    : 0;
  const trendDirection = trendChange > 0 ? "up" : trendChange < 0 ? "down" : "flat";
  const arrow = trendChange > 0 ? "↑" : trendChange < 0 ? "↓" : "→";

  return (
    <section className="rating-overview card" aria-label="Rating overview">
      <div className="rating-overview-summary">
        <div className="rating-current-block">
          <span className="rating-overview-label">Current Elo</span>
          <strong className="rating-current-value">{Math.round(Number(currentRating) || 0).toLocaleString()}</strong>
          <div className={`rating-trend-change is-${trendDirection}`}>
            <span className="rating-trend-arrow" aria-hidden="true">{arrow}</span>
            <strong>{trendChange >= 0 ? "+" : ""}{Math.round(trendChange).toLocaleString()} Elo</strong>
            <span className="rating-trend-range">
              {Number.isFinite(trendStart) ? Math.round(trendStart).toLocaleString() : "—"}
              {" → "}
              {Number.isFinite(trendEnd) ? Math.round(trendEnd).toLocaleString() : "—"}
            </span>
          </div>
          <span className="rating-trend-caption">
            Current {Number(climb?.sampleSize || 0).toLocaleString()}-game streak
          </span>
        </div>

        <RecordPanel wins={wins} draws={draws} losses={losses} className="rating-record-panel-summary" />
      </div>

      <div className="rating-overview-chart" aria-label="Rating by game">
        <RangeLineChart
          data={data}
          selection={selection}
          onSelectionChange={onSelectionChange}
          detailKey="rating"
          metrics={[
            {
              key: "rating",
              label: "Rating",
              suffix: " Elo",
              decimals: 0,
              slopeDecimals: 1,
            },
          ]}
          selectionActionLabel="View selected games"
          onSelectionAction={onViewSelectedGames}
          emptySelectionLabel="Drag across the chart to select an era."
        >
          <CartesianGrid stroke="#21262d" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="game"
            type="number"
            domain={["dataMin", "dataMax"]}
            tick={{ fill: "#8b949e", fontSize: 10 }}
            axisLine={{ stroke: "#30363d" }}
            tickLine={false}
            minTickGap={34}
          />
          <YAxis
            domain={ratingAxis.domain}
            ticks={ratingAxis.ticks}
            allowDecimals={false}
            tick={{ fill: "#8b949e", fontSize: 10 }}
            tickFormatter={(value) => Math.round(Number(value)).toLocaleString()}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            content={(props) => <RatingTooltip {...props} />}
            cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
            allowEscapeViewBox={{ x: true, y: true }}
          />
          <Line
            type="linear"
            dataKey="rating"
            name="Rating"
            dot={false}
            activeDot={{ r: 3 }}
            stroke="#58a6ff"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </RangeLineChart>
      </div>

      <RecordPanel wins={wins} draws={draws} losses={losses} className="rating-record-panel-underchart" />
    </section>
  );
}
