import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gradeForScore } from "./GradeBadge";

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

const CATEGORY_HELP = {
  "New territory": "How much of the current trend leg pushes beyond the account's established prior rating peak. Reclaiming an old peak does not count as new territory.",
  "Rating progress": "Total recovery-adjusted rating progress across the current trend leg. Elo that only rebounds from the immediately preceding trough is excluded from this component.",
  "Elo / 100": "Rating progress per 100 games in the current trend leg. This measures how efficiently games are being converted into rating.",
  "30-day change": "Literal rating change across the latest 30 calendar days. This is measured from actual account history and is never extrapolated from a shorter sample.",
  "Cadence": "How steadily the account is playing during the trend: daily volume regularity, active-week continuity, and inactivity gaps all contribute.",
  "Vs expectation": "How much the player's actual results outperform or underperform the score expected from the Elo ratings of the player and opponents.",
  "Consistency": "How consistently rolling windows inside the current trend leg finish higher than they begin. Repeated positive windows score better than a single isolated surge.",
  "Drawdown": "How well the trend avoids deep peak-to-trough rating losses. Smaller and better-controlled drawdowns receive a stronger grade.",
};

function CategoryTooltip({ label, help, score, grade }) {
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
        className="metric-help-tooltip"
        role="tooltip"
        style={{ left: position.left, top: position.top }}
      >
        <strong>{label}</strong>
        <span>{help}</span>
        <em>{score.toFixed(0)}/100 · grade {grade}</em>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="metric-help-trigger"
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

export default function ClimbScoreMetric({ climb }) {
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
    <div className="metric climb-score-metric">
      <div className="climb-score-head">
        <div>
          <div className="metric-label">Climb score</div>
          <div className="climb-score-state">{climb?.label || "—"} · {(climb?.sampleSize || 0).toLocaleString()}-game current trend leg</div>
        </div>
      </div>

      <div className="climb-score-visuals">
        <Speedometer score={score} />
      </div>

      <div className="climb-category-grid" aria-label="Climb score category grades">
        {categories.map(([label, value]) => {
          const categoryScore = clampScore(value);
          const grade = gradeForScore(categoryScore);
          const help = CATEGORY_HELP[label];
          return (
            <div className="climb-category" key={label}>
              <span className="climb-category-name">{label}</span>
              <strong className={`grade-letter grade-${grade.toLowerCase()}`} aria-label={`Grade ${grade}`}>
                {grade}
              </strong>
              <CategoryTooltip label={label} help={help} score={categoryScore} grade={grade} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
