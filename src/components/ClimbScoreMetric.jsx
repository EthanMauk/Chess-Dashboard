import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function weightedAverage(parts) {
  let total = 0;
  let weightSum = 0;
  parts.forEach(([value, weight]) => {
    const score = Number(value);
    const w = Number(weight);
    if (!Number.isFinite(score) || !Number.isFinite(w) || w <= 0) return;
    total += clampScore(score) * w;
    weightSum += w;
  });
  return weightSum > 0 ? total / weightSum : 0;
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
      <text className="climb-gauge-min" x="17" y="109">0</text>
      <text className="climb-gauge-max" x="166" y="109">100</text>
    </svg>
  );
}

const CATEGORY_HELP = {
  Growth: "Growth measures real forward movement in rating: new territory, total gain, and the speed of the climb both over games played and over the most recent calendar month.",
  Momentum: "Momentum reflects whether the climb currently has sustained forward push. It blends cadence and the share of positive windows rather than a single isolated spike.",
  Performance: "Performance measures whether actual results are beating or lagging Elo expectation during the current climb sample.",
  Stability: "Stability rewards controlled climbs. It blends drawdown control with volume regularity, so sharp collapses or erratic activity drag the grade down.",
};

function InfoTooltip({ label, help, score, grade }) {
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
        <em>{Math.round(clampScore(score))}/100 · grade {grade}</em>
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

function CategoryRow({ label, score }) {
  const value = clampScore(score);
  const grade = gradeForScore(value);

  return (
    <div className="climb-category climb-category-simplified">
      <span className="climb-category-name">{label}</span>
      <div className="climb-category-meter" aria-hidden="true">
        <span style={{ width: `${value}%` }} />
      </div>
      <strong className={`grade-letter grade-${grade.toLowerCase()}`} aria-label={`${label} grade ${grade}`}>
        {grade}
      </strong>
      <InfoTooltip label={label} help={CATEGORY_HELP[label]} score={value} grade={grade} />
    </div>
  );
}

export default function ClimbScoreMetric({ climb }) {
  const score = clampScore(climb?.score);
  const maturityConfidence = clampScore((Number(climb?.maturityConfidence) || 0) * 100);
  const trendGames = Math.max(0, Number(climb?.sampleSize) || 0);
  const growthScore = weightedAverage([
    [climb?.newTerritoryScore, 0.32],
    [climb?.gainScore, 0.28],
    [climb?.velocityScore, 0.22],
    [climb?.calendarVelocityScore, 0.18],
  ]);
  const momentumScore = weightedAverage([
    [climb?.cadenceScore, 0.55],
    [climb?.consistencyScore, 0.45],
  ]);
  const performanceScore = clampScore(climb?.pressureScore);
  const stabilityScore = weightedAverage([
    [climb?.drawdownScore, 0.72],
    [climb?.volumeRegularityScore, 0.28],
  ]);

  const categories = [
    ["Growth", growthScore],
    ["Momentum", momentumScore],
    ["Performance", performanceScore],
    ["Stability", stabilityScore],
  ];

  return (
    <div className="metric climb-score-metric">
      <div className="climb-card-header-v137">
        <div className="climb-card-label-v137">Climb score</div>
        <div className="climb-card-value-v137">{Math.round(score)}/100</div>
        <div className="climb-card-state-v137">
          <span className="climb-card-state-name-v137">{climb?.label || "—"}</span>
          <span className="climb-card-state-separator-v137">·</span>
          <span>{trendGames.toLocaleString()}-game streak</span>
        </div>
      </div>

      <div className="climb-score-visuals climb-score-visuals-clean">
        <div className="climb-gauge-block climb-gauge-block-clean">
          <Speedometer score={score} />
        </div>

        <div className="climb-summary-plain" aria-label="Current climb summary">
          <div className="climb-summary-line">
            <span>Streak</span>
            <strong>{trendGames.toLocaleString()} games</strong>
          </div>
          <div className="climb-summary-line">
            <span>Confidence</span>
            <strong>{Math.round(maturityConfidence)}%</strong>
          </div>
        </div>
      </div>

      <div className="climb-category-grid climb-category-grid-flat climb-category-grid-simplified" aria-label="Climb score category grades">
        {categories.map(([label, value]) => (
          <CategoryRow key={label} label={label} score={value} />
        ))}
      </div>
    </div>
  );
}
