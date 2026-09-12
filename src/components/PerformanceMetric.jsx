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
      <div className="performance-header">
        <div>
          <div className="metric-label">Performance</div>
          <div className="performance-metric-title">Playing grade</div>
        </div>
        <span className="performance-preview-pill">Preview</span>
      </div>

      <div className="performance-content">
        <div className="performance-grade-stage">
          <GradeBadge grade={grade} size={86} label="Performance grade" />
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

      <div className="metric-sub performance-note">Placeholder grade until the playing-performance model is wired in.</div>
    </div>
  );
}
