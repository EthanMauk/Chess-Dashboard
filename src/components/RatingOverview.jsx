import React, { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDate } from "../utils/chessData";

function RatingTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div className="rating-tooltip">
      <strong>{Math.round(point.rating).toLocaleString()} Elo</strong>
      <span>Game #{point.game.toLocaleString()}</span>
      <span>{formatDate(point.date)}</span>
    </div>
  );
}

export default function RatingOverview({ games, movesCount, currentRating, climb }) {
  const data = useMemo(() => [...games]
    .sort((a, b) => Number(a.gameNumber) - Number(b.gameNumber))
    .map((game) => ({
      game: Number(game.gameNumber),
      rating: Number(game.playerRating),
      date: game.date,
    }))
    .filter((point) => Number.isFinite(point.game) && Number.isFinite(point.rating)), [games]);

  const trendStart = Number(climb?.climbStartRating);
  const trendEnd = Number(climb?.climbEndRating);
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
            Current {Number(climb?.sampleSize || 0).toLocaleString()}-game trend leg
          </span>
        </div>

        <div className="rating-overview-stats">
          <div className="rating-overview-stat">
            <span>Games analyzed</span>
            <strong>{games.length.toLocaleString()}</strong>
          </div>
          <div className="rating-overview-stat">
            <span>Moves analyzed</span>
            <strong>{Number(movesCount || 0).toLocaleString()}</strong>
          </div>
          <div className="rating-overview-stat">
            <span>Elo / 100 games</span>
            <strong>
              {Number(climb?.pacePer100 || 0) >= 0 ? "+" : ""}
              {Number(climb?.pacePer100 || 0).toFixed(1)}
            </strong>
          </div>
        </div>
      </div>

      <div className="rating-overview-chart" aria-label="Raw rating by game">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            <Tooltip content={<RatingTooltip />} cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }} />
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
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rating-overview-footnote">
        Raw rating after every analyzed game · no bucketing or averaging
      </div>
    </section>
  );
}
