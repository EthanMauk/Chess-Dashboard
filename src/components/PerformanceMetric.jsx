import React from "react";

function strengthTier(elo) {
  const n = Number(elo);
  if (!Number.isFinite(n)) return "";
  if (n >= 2850) return "World-class";
  if (n >= 2600) return "Elite";
  if (n >= 2400) return "Master";
  if (n >= 2200) return "Expert";
  if (n >= 1900) return "Advanced";
  if (n >= 1600) return "Strong club";
  if (n >= 1200) return "Developing";
  return "Beginner";
}

function formatElo(value, { approximate = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${approximate ? "~" : ""}${Math.round(n).toLocaleString()}`;
}

function formatDelta(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(n);
  if (rounded === 0) return "Matches current rating";
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()} vs current`;
}

export default function PerformanceMetric({ performance, currentRating }) {
  const estimatedElo = Number(performance?.estimatedElo);
  const currentElo = Number(currentRating);
  const resultPerformance = Number(performance?.resultPerformanceRating);
  const ratingAnchor = Number(performance?.ratingAnchorElo);
  const averageOpponent = Number(performance?.averageOpponentRating);

  const tier = strengthTier(estimatedElo);
  const delta = Number.isFinite(estimatedElo) && Number.isFinite(currentElo)
    ? formatDelta(estimatedElo - currentElo)
    : "";

  const details = [
    {
      label: "Result performance",
      value: Number.isFinite(resultPerformance) ? `${formatElo(resultPerformance, { approximate: true })} Elo` : "—",
      help: "Elo-equivalent performance from score rate and opponent strength.",
    },
    {
      label: "Rating anchor",
      value: Number.isFinite(ratingAnchor) ? `${formatElo(ratingAnchor)} Elo` : "—",
      help: "The player's rating baseline used by the strength model.",
    },
    {
      label: "Opponent field",
      value: Number.isFinite(averageOpponent) ? `${formatElo(averageOpponent)} avg` : "—",
      help: "Recency-weighted average opponent rating in the analyzed window.",
    },
  ];

  return (
    <div className="metric performance-metric strength-card-v4">
      <div className="strength-v4-head">
        <span className="strength-v4-title">Estimated strength</span>
        {tier ? <span className="strength-v4-tier">{tier}</span> : null}
      </div>

      <div className="strength-v4-hero">
        <strong className="strength-v4-value">
          {Number.isFinite(estimatedElo) ? `${formatElo(estimatedElo, { approximate: true })} Elo` : "—"}
        </strong>
        {delta ? (
          <span className={`strength-v4-delta ${estimatedElo >= currentElo ? "is-up" : "is-down"}`}>
            {delta}
          </span>
        ) : null}
      </div>

      <div className="strength-v4-details" aria-label="Estimated strength inputs">
        {details.map((item) => (
          <div className="strength-v4-row" key={item.label} title={item.help}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
