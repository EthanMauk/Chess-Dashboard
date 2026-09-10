import React from "react";

export function ChartTooltip({ active, payload, label, coordinate }) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload;
  const displayLabel = point?.range
    ? `Games ${point.range}${point.gamesInBucket ? ` (${point.gamesInBucket} games)` : ""}`
    : label;

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
      {payload.map((entry) => (
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
