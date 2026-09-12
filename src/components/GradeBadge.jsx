import React, { useId } from "react";

export function gradeForScore(score) {
  const value = Number.isFinite(Number(score)) ? Number(score) : 0;
  if (value >= 90) return "S";
  if (value >= 80) return "A";
  if (value >= 70) return "B";
  if (value >= 60) return "C";
  if (value >= 50) return "D";
  return "F";
}

const GRADE_STYLES = {
  F: { accent: "#8b949e", tint: "#22272e" },
  D: { accent: "#c69062", tint: "#241c18" },
  C: { accent: "#c9d1d9", tint: "#20252b" },
  B: { accent: "#79c0ff", tint: "#152235" },
  A: { accent: "#7ee787", tint: "#14281d" },
  S: { accent: "#e3b341", tint: "#2a2415" },
};

export default function GradeBadge({ score, grade: explicitGrade, size = 68, label = "Performance grade" }) {
  const normalizedExplicitGrade = typeof explicitGrade === "string" ? explicitGrade.toUpperCase() : null;
  const grade = GRADE_STYLES[normalizedExplicitGrade] ? normalizedExplicitGrade : gradeForScore(score);
  const style = GRADE_STYLES[grade];
  const rawId = useId();
  const gradientId = `grade-${rawId.replace(/:/g, "")}`;

  return (
    <div className="grade-badge-wrap" title={`${label}: ${grade}`}>
      <svg
        className="grade-badge"
        width={size}
        height={size}
        viewBox="0 0 72 72"
        role="img"
        aria-label={`${label} ${grade}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={style.tint} />
            <stop offset="100%" stopColor="#0d1117" />
          </linearGradient>
        </defs>
        <path
          d="M36 4 61 14v20c0 16-10.2 27-25 34C21.2 61 11 50 11 34V14L36 4Z"
          fill={`url(#${gradientId})`}
          stroke={style.accent}
          strokeOpacity="0.78"
          strokeWidth="2"
        />
        <path
          d="M36 10 56 18v16c0 12.8-7.7 22-20 28-12.3-6-20-15.2-20-28V18l20-8Z"
          fill="none"
          stroke={style.accent}
          strokeOpacity="0.20"
          strokeWidth="1.5"
        />
        <text
          x="36"
          y="44"
          textAnchor="middle"
          fontSize="31"
          fontWeight="900"
          fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          fill={style.accent}
        >
          {grade}
        </text>
      </svg>
    </div>
  );
}
