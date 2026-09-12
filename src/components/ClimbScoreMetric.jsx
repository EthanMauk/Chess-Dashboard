import React from "react";
import GradeBadge, { gradeForScore } from "./GradeBadge";

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function Speedometer({ score }) {
  const value = clampScore(score);
  const needleAngle = 180 + value * 1.8;

  return (
    <svg className="climb-speedometer" viewBox="0 0 190 112" role="img" aria-label={`Climb score ${Math.round(value)} out of 100`}>
      <path className="climb-gauge-track" d="M20 94 A75 75 0 0 1 170 94" pathLength="100" />
      <path
        className="climb-gauge-fill"
        d="M20 94 A75 75 0 0 1 170 94"
        pathLength="100"
        strokeDasharray={`${value} ${100 - value}`}
      />
      {[0, 25, 50, 75, 100].map((tick) => {
        const angle = (180 - tick * 1.8) * Math.PI / 180;
        const x1 = 95 + Math.cos(angle) * 66;
        const y1 = 94 - Math.sin(angle) * 66;
        const x2 = 95 + Math.cos(angle) * 73;
        const y2 = 94 - Math.sin(angle) * 73;
        return <line key={tick} className="climb-gauge-tick" x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
      <line
        className="climb-gauge-needle"
        x1="95"
        y1="94"
        x2="142"
        y2="94"
        transform={`rotate(${needleAngle} 95 94)`}
      />
      <circle className="climb-gauge-hub" cx="95" cy="94" r="5" />
      <text className="climb-gauge-score" x="95" y="76" textAnchor="middle">{Math.round(value)}/100</text>
      <text className="climb-gauge-min" x="17" y="109">0</text>
      <text className="climb-gauge-max" x="166" y="109">100</text>
    </svg>
  );
}

export default function ClimbScoreMetric({ climb, title }) {
  const score = clampScore(climb?.score);
  const categories = [
    ["New territory", climb?.newTerritoryScore],
    ["Rating progress", climb?.gainScore],
    ["Elo / 100", climb?.velocityScore],
    ["30-day change", climb?.calendarVelocityScore],
    ["Cadence", climb?.cadenceScore],
    ["Vs expectation", climb?.pressureScore],
    ["Consistency", climb?.consistencyScore],
    ["Drawdown", climb?.drawdownScore],
  ];

  return (
    <div className="metric climb-score-metric" title={title || undefined}>
      <div className="climb-score-head">
        <div>
          <div className="metric-label">Climb score</div>
          <div className="climb-score-state">{climb?.label || "—"} · {(climb?.sampleSize || 0).toLocaleString()}-game current trend leg</div>
        </div>
      </div>

      <div className="climb-score-visuals">
        <Speedometer score={score} />
        <div className="climb-grade-block">
          <div className="climb-grade-label">Grade</div>
          <GradeBadge score={score} size={70} />
        </div>
      </div>

      <div className="climb-category-grid" aria-label="Climb score category grades">
        {categories.map(([label, value]) => {
          const categoryScore = clampScore(value);
          return (
            <div className="climb-category" key={label} title={`${label}: ${categoryScore.toFixed(0)}/100`}>
              <span>{label}</span>
              <strong className={`grade-letter grade-${gradeForScore(categoryScore).toLowerCase()}`}>
                {gradeForScore(categoryScore)}
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
