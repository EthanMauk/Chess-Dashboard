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

function formatSignedElo(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(n);
  if (rounded === 0) return "Matches current rating";
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()} Elo vs current rating`;
}

export default function PerformanceMetric({ performance, currentRating }) {
  const estimatedElo = Number(performance?.estimatedElo);
  const currentElo = Number(currentRating);
  const estimateText = Number.isFinite(estimatedElo)
    ? `${Math.round(estimatedElo).toLocaleString()} Elo`
    : "—";
  const tierText = strengthTier(estimatedElo);
  const deltaText = Number.isFinite(estimatedElo) && Number.isFinite(currentElo)
    ? formatSignedElo(estimatedElo - currentElo)
    : "";

  return (
    <div className="metric performance-metric strength-card-clean">
      <div className="strength-card-title">Estimated strength</div>

      <div className="strength-card-value">{estimateText}</div>

      <div className="strength-card-subline">
        {tierText ? <span className="strength-card-tier">{tierText}</span> : null}
        {deltaText ? <span className="strength-card-delta">{deltaText}</span> : null}
      </div>
    </div>
  );
}
