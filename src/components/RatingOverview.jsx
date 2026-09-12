import React, { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import RangeLineChart from "./RangeLineChart";
import { formatDate } from "../utils/chessData";

function RatingTooltip({ active, payload, coordinate }) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div
      className="custom-chart-tooltip rating-hover-tooltip"
      style={{
        position: "absolute",
        left: (coordinate?.x ?? 0) + 24,
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
        <strong>{formatDate(point.date)}</strong>
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
  const data = useMemo(() => [...games]
    .sort((a, b) => Number(a.gameNumber) - Number(b.gameNumber))
    .map((game) => ({
      game: Number(game.gameNumber),
      rating: Number(game.playerRating),
      date: game.date,
      gamesInBucket: 1,
    }))
    .filter((point) => Number.isFinite(point.game) && Number.isFinite(point.rating)), [games]);

  const trendStart = Number(climb?.climbStartRating);
  const trendEnd = Number(climb?.climbEndRating);
  const trendChange = Number.isFinite(trendStart) && Number.isFinite(trendEnd)
    ? trendEnd - trendStart
    : 0;
  const trendDirection = trendChange > 0 ? "up" : trendChange < 0 ? "down" : "flat";
  const arrow = trendChange > 0 ? "↑" : trendChange < 0 ? "↓" : "→";
  const totalGames = Number(wins) + Number(losses) + Number(draws);
  const winRate = totalGames ? (Number(wins) / totalGames) * 100 : 0;

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
            Current {Number(climb?.sampleSize || 0).toLocaleString()}-game trend leg
          </span>
        </div>

        <div className="rating-overview-stats rating-overview-stats-record">
          <div className="rating-overview-stat">
            <span>Record</span>
            <strong className="rating-record-value">
              <span className="rating-record-win">{Number(wins).toLocaleString()}W</span>
              <span className="rating-record-draw">{Number(draws).toLocaleString()}D</span>
              <span className="rating-record-loss">{Number(losses).toLocaleString()}L</span>
            </strong>
          </div>
          <div className="rating-overview-stat">
            <span>Win rate</span>
            <strong>{winRate.toFixed(1)}%</strong>
          </div>
        </div>
      </div>

      <div className="rating-overview-chart" aria-label="Rating by game">
        <RangeLineChart
          data={data}
          selection={selection}
          onSelectionChange={onSelectionChange}
          detailKey="rating"
          metrics={[{
            key: "rating",
            label: "Rating",
            suffix: " Elo",
            decimals: 0,
            slopeDecimals: 1,
          }]}
          selectionActionLabel="View selected games"
          onSelectionAction={onViewSelectedGames}
          emptySelectionLabel="Drag across the rating chart to select an era."
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
            domain={["dataMin - 20", "dataMax + 20"]}
            tick={{ fill: "#8b949e", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
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
    </section>
  );
}
