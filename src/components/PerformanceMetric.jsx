import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

function gradeForScore(score) {
  const value = clampScore(score);
  if (value >= 90) return "S";
  if (value >= 80) return "A";
  if (value >= 70) return "B";
  if (value >= 60) return "C";
  if (value >= 50) return "D";
  return "F";
}

const PERFORMANCE_HELP = {
  "Results vs expectation": "Compares actual game score with the score predicted by the player/opponent Elo matchup. It is recency weighted, so recent over- or under-performance matters more.",
  "Engine quality": "Combines player-vs-opponent ACPL, the player's recent ACPL versus their longer-run baseline, and the bad-game ACPL tail. It rewards both cleaner average play and fewer severe engine-loss games.",
  "Error control": "Measures practical blunders, mistakes, inaccuracies, and blunder-free games. Opponent-relative error burden is preferred when available, with the player's historical error rate used as a second reference.",
  "Critical decisions": "Tracks high-leverage misses: missed mates, conversion errors, and missed opportunities. Sparse samples are confidence-shrunk so a few rare positions cannot dominate the grade.",
  "Phase quality": "Combines opening, middlegame, and endgame engine quality. Each phase is weighted by the number of analyzed moves and confidence in that phase's sample.",
  "Move quality": "Compares the share of good/excellent/best-type moves and best/great moves with the player's established baseline. It measures how often moves land in the engine's strongest bands.",
  "Consistency & floor": "Measures repeatability: recent ACPL variance, the high-ACPL bad-game tail, and blunder-free frequency. A strong score means fewer performance collapses, not merely a good average.",
  "Current form": "Compares the newest block of games with the preceding sample using results versus expectation, ACPL edge, and error burden. This is the most explicitly short-term component.",
};

function MetricTooltip({ label, score, confidence }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);

  const updatePosition = () => {
    if (!triggerRef.current || !tooltipRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const tip = tooltipRef.current.getBoundingClientRect();
    const margin = 10;
    let left = trigger.left + trigger.width / 2 - tip.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tip.width - margin));
    let top = trigger.top - tip.height - 9;
    if (top < margin) top = trigger.bottom + 9;
    if (top + tip.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - tip.height - margin);
    }
    setPosition({ left, top });
  };

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const tooltip = open && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={tooltipRef}
        className="metric-help-tooltip performance-help-tooltip"
        role="tooltip"
        style={{ left: position.left, top: position.top }}
      >
        <strong>{label}</strong>
        <span>{PERFORMANCE_HELP[label] || "One component of the current performance model."}</span>
        <em>
          {Math.round(clampScore(score))}/100
          {Number.isFinite(Number(confidence)) ? ` · ${Math.round(Number(confidence) * 100)}% evidence` : ""}
        </em>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="metric-help-trigger performance-help-trigger"
        aria-label={`About ${label}`}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
      >
        i
      </button>
      {tooltip}
    </>
  );
}

function GradeShield({ grade }) {
  return (
    <div className={`performance-grade-shield grade-shield-${grade.toLowerCase()}`} aria-label={`Playing grade ${grade}`}>
      <svg viewBox="0 0 92 108" role="img" aria-hidden="true">
        <path className="performance-shield-outer" d="M46 4 82 18v34c0 23-13 40-36 52C23 92 10 75 10 52V18L46 4Z" />
        <path className="performance-shield-inner" d="M46 14 73 24v27c0 17-9 30-27 41C28 81 19 68 19 51V24L46 14Z" />
      </svg>
      <strong>{grade}</strong>
    </div>
  );
}

export default function PerformanceMetric({ performance }) {
  const score = clampScore(performance?.score);
  const grade = gradeForScore(score);
  const categories = Array.isArray(performance?.categories) ? performance.categories : [];
  const sampleSize = Math.max(0, Number(performance?.sampleSize) || 0);
  const confidence = Math.max(0, Math.min(1, Number(performance?.confidence) || 0));

  return (
    <div className="metric performance-metric">
      <div className="performance-header">
        <div className="performance-metric-copy">
          <div className="metric-label">Performance</div>
          <div className="performance-metric-title">Playing grade</div>
        </div>
        <div className="performance-preview-pill">Naive v1</div>
      </div>

      <div className="performance-content">
        <div className="performance-grade-stage">
          <GradeShield grade={grade} />
        </div>

        <div className="performance-breakdown" aria-label="Performance score breakdown">
          {categories.map((category) => {
            const categoryScore = clampScore(category?.score);
            const categoryGrade = gradeForScore(categoryScore);
            return (
              <div className="performance-breakdown-row" key={category.label}>
                <span className="performance-breakdown-label">{category.label}</span>
                <strong className={`grade-letter grade-${categoryGrade.toLowerCase()}`} aria-label={`${category.label} grade ${categoryGrade}`}>
                  {categoryGrade}
                </strong>
                <span className="performance-breakdown-score">{Math.round(categoryScore)}</span>
                <MetricTooltip
                  label={category.label}
                  score={categoryScore}
                  confidence={category?.confidence}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="performance-note">
        Naive performance model · {Math.round(score)}/100 across the latest {sampleSize.toLocaleString()} analyzed games
        {sampleSize ? ` · ${Math.round(confidence * 100)}% confidence` : ""}.
      </div>
    </div>
  );
}
