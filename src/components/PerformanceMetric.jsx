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

function formatElo(value, approximate = false) {
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
    ["Result performance", Number.isFinite(resultPerformance) ? `~${formatElo(resultPerformance)} Elo` : "—"],
    ["Rating anchor", Number.isFinite(ratingAnchor) ? `${formatElo(ratingAnchor)} Elo` : "—"],
    ["Opponent field", Number.isFinite(averageOpponent) ? `${formatElo(averageOpponent)} avg` : "—"],
  ];

  return (
    <div className="metric performance-metric strength-card-v5">
      <div className="strength-v5-title">Estimated strength</div>

      <div className="strength-v5-value">
        {Number.isFinite(estimatedElo) ? `${formatElo(estimatedElo, true)} Elo` : "—"}
      </div>

      {(tier || delta) && (
        <div className="strength-v5-context">
          {tier ? <span className="strength-v5-tier">{tier}</span> : null}
          {delta ? (
            <span className={`strength-v5-delta ${estimatedElo >= currentElo ? "is-up" : "is-down"}`}>
              {delta}
            </span>
          ) : null}
        </div>
      )}

      <div className="strength-v5-details" aria-label="Estimated strength inputs">
        {details.map(([label, value]) => (
          <div className="strength-v5-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
