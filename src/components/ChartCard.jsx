import React from "react";

export function ChartTooltip({ active, payload, label, coordinate }) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload;
  const displayLabel = point?.range
    ? `Games ${point.range}${point.gamesInBucket ? ` (${point.gamesInBucket} games)` : ""}`
    : label;

  const sortedPayload = [...payload].sort((a, b) => {
    const aValue = typeof a?.value === "number" && Number.isFinite(a.value) ? a.value : -Infinity;
    const bValue = typeof b?.value === "number" && Number.isFinite(b.value) ? b.value : -Infinity;
    return bValue - aValue;
  });

  return (
    <div
      className="custom-chart-tooltip"
      style={{
        position: "absolute",
        left: (coordinate?.x ?? 0) + 24,
        top: Math.max(8, (coordinate?.y ?? 0) - 18),
      }}
    >
      <div className="custom-chart-tooltip-label">{displayLabel}</div>
      {sortedPayload.map((entry) => (
        <div className="custom-chart-tooltip-row" key={`${entry.dataKey}-${entry.name}`}>
          <span>{entry.name || entry.dataKey}</span>
          <strong>
            {typeof entry.value === "number"
              ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 3 })
              : entry.value}
            {String(entry.dataKey).toLowerCase().includes("pct") ? "%" : ""}
          </strong>
        </div>
      ))}
    </div>
  );
}

export default function ChartCard({ title, children }) {
  return (
    <section className="card chart-card">
      <h2>{title}</h2>
      <div className="chart">{children}</div>
    </section>
  );
}

export function PhaseBlunderTooltip({ active, payload, label, coordinate }) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload || {};
  const displayLabel = point?.range
    ? `Games ${point.range}${point.gamesInBucket ? ` (${point.gamesInBucket} games)` : ""}`
    : label;

  const phases = [
    {
      name: 'Opening',
      total: point.openingBlundersPer100,
      normal: point.openingNormalBlundersPer100,
      mate: point.openingMateBlundersPer100,
      moves: point.openingPhaseMoves,
    },
    {
      name: 'Middlegame',
      total: point.middlegameBlundersPer100,
      normal: point.middlegameNormalBlundersPer100,
      mate: point.middlegameMateBlundersPer100,
      moves: point.middlegamePhaseMoves,
    },
    {
      name: 'Endgame',
      total: point.endgameBlundersPer100,
      normal: point.endgameNormalBlundersPer100,
      mate: point.endgameMateBlundersPer100,
      moves: point.endgamePhaseMoves,
    },
  ].filter((phase) => typeof phase.total === 'number' && Number.isFinite(phase.total))
    .sort((a, b) => b.total - a.total);

  const fmt = (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : '—';

  return (
    <div
      className="custom-chart-tooltip phase-blunder-tooltip"
      style={{
        position: "absolute",
        left: (coordinate?.x ?? 0) + 24,
        top: Math.max(8, (coordinate?.y ?? 0) - 18),
      }}
    >
      <div className="custom-chart-tooltip-label">{displayLabel}</div>
      {phases.map((phase) => (
        <div className="phase-blunder-tooltip-group" key={phase.name}>
          <div className="custom-chart-tooltip-row">
            <span>{phase.name}</span>
            <strong>{fmt(phase.total)}</strong>
          </div>
          <div className="custom-chart-tooltip-row phase-blunder-tooltip-subrow">
            <span>Normal</span>
            <strong>{fmt(phase.normal)}</strong>
          </div>
          <div className="custom-chart-tooltip-row phase-blunder-tooltip-subrow">
            <span>Mate-related</span>
            <strong>{fmt(phase.mate)}</strong>
          </div>
          <div className="custom-chart-tooltip-row phase-blunder-tooltip-subrow">
            <span>Moves</span>
            <strong>{Number(phase.moves || 0).toLocaleString()}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}
