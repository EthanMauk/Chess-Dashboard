import React from "react";
import GradeBadge from "./GradeBadge";

export default function PerformanceMetric({ grade = "S" }) {
  return (
    <div className="metric performance-metric" title="Temporary performance grade placeholder. The playing-performance algorithm has not been defined yet.">
      <div className="performance-metric-copy">
        <div className="metric-label">Performance</div>
        <div className="performance-metric-title">Playing grade</div>
        <div className="metric-sub">Performance model coming next</div>
      </div>

      <div className="performance-grade-stage">
        <GradeBadge grade={grade} size={112} label="Performance grade" />
      </div>
    </div>
  );
}
