import React from "react";
import GradeBadge, { gradeForScore } from "./GradeBadge";

const MOCK_CATEGORIES = [
  ["Move quality", 96],
  ["Tactical safety", 94],
  ["Conversion", 93],
  ["Consistency", 95],
];

export default function PerformanceMetric({ grade = "S" }) {
  return (
    <div className="metric performance-metric">
      <div className="performance-metric-copy">
        <div className="metric-label">Performance</div>
        <div className="performance-metric-title">Playing grade</div>
        <div className="metric-sub">Preview · performance model not wired yet</div>
      </div>

      <div className="performance-grade-stage">
        <GradeBadge grade={grade} size={98} label="Performance grade" />
      </div>

      <div className="performance-breakdown" aria-label="Mock performance category preview">
        {MOCK_CATEGORIES.map(([label, score]) => {
          const itemGrade = gradeForScore(score);
          return (
            <div className="performance-breakdown-row" key={label}>
              <span>{label}</span>
              <strong className={`grade-letter grade-${itemGrade.toLowerCase()}`}>{itemGrade}</strong>
              <span className="performance-breakdown-score">{score}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
