import React from "react";
import GradeBadge, { gradeForScore } from "./GradeBadge";

const FALLBACK_CATEGORIES = [
  { label: "Move quality", score: 0 },
  { label: "Tactical safety", score: 0 },
  { label: "Conversion", score: 0 },
  { label: "Consistency", score: 0 },
];

export default function PerformanceMetric({ performance }) {
  const score = Number.isFinite(Number(performance?.score)) ? Number(performance.score) : 0;
  const grade = gradeForScore(score);
  const categories = performance?.categories?.length ? performance.categories : FALLBACK_CATEGORIES;
  const sampleSize = Math.max(0, Number(performance?.sampleSize) || 0);

  return (
    <div className="metric performance-metric">
      <div className="performance-header">
        <div>
          <div className="metric-label">Performance</div>
          <div className="performance-metric-title">Playing grade</div>
        </div>
        <span className="performance-preview-pill">Naive v1</span>
      </div>

      <div className="performance-content">
        <div className="performance-grade-stage">
          <GradeBadge grade={grade} size={86} label="Performance grade" />
        </div>

        <div className="performance-breakdown" aria-label="Performance category scores">
          {categories.map(({ label, score: categoryValue }) => {
            const categoryScore = Math.max(0, Math.min(100, Number(categoryValue) || 0));
            const itemGrade = gradeForScore(categoryScore);
            return (
              <div className="performance-breakdown-row" key={label}>
                <span>{label}</span>
                <strong className={`grade-letter grade-${itemGrade.toLowerCase()}`}>{itemGrade}</strong>
                <span className="performance-breakdown-score">{Math.round(categoryScore)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="metric-sub performance-note">
        {sampleSize
          ? `Naive performance model · ${Math.round(score)}/100 across the latest ${sampleSize.toLocaleString()} analyzed game${sampleSize === 1 ? "" : "s"}.`
          : "Performance grade appears after analyzed games are available."}
      </div>
    </div>
  );
}
