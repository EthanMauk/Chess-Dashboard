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
  F: { light: "#8b949e", dark: "#484f58", text: "#f0f6fc" },
  D: { light: "#d08a4b", dark: "#7a4623", text: "#fff4e8" },
  C: { light: "#e6edf3", dark: "#8c959f", text: "#0d1117" },
  B: { light: "#79c0ff", dark: "#1f6feb", text: "#ffffff" },
  A: { light: "#56d364", dark: "#238636", text: "#ffffff" },
  S: { light: "#f2cc60", dark: "#9e6a03", text: "#2d2100" },
};

export default function GradeBadge({ score, size = 68, label = "Performance grade" }) {
  const grade = gradeForScore(score);
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
            <stop offset="0%" stopColor={style.light} />
            <stop offset="100%" stopColor={style.dark} />
          </linearGradient>
        </defs>
        <path
          d="M36 4 61 14v20c0 16-10.2 27-25 34C21.2 61 11 50 11 34V14L36 4Z"
          fill={`url(#${gradientId})`}
          stroke="rgba(255,255,255,0.32)"
          strokeWidth="2"
        />
        <path
          d="M36 10 56 18v16c0 12.8-7.7 22-20 28-12.3-6-20-15.2-20-28V18l20-8Z"
          fill="none"
          stroke="rgba(255,255,255,0.22)"
          strokeWidth="1.5"
        />
        <text
          x="36"
          y="44"
          textAnchor="middle"
          fontSize="31"
          fontWeight="900"
          fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          fill={style.text}
          stroke="rgba(0,0,0,0.12)"
          strokeWidth="0.5"
          paintOrder="stroke"
        >
          {grade}
        </text>
      </svg>
    </div>
  );
}
