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
  "Cadence": "The combined playing-rhythm score. Daily volume regularity contributes 50%, active-week continuity 30%, and inactivity-gap control 20%.",
  "Vs expectation": "How much the player's actual results outperform or underperform the score expected from the Elo ratings of the player and opponents.",
  "Consistency": "How consistently rolling windows inside the current trend leg finish higher than they begin. Repeated positive windows score better than a single isolated surge.",
  "Drawdown": "How well the trend avoids deep peak-to-trough rating losses. Smaller and better-controlled drawdowns receive a stronger grade.",
  "Volume regularity": "How even daily game volume is during the current trend leg. Steady output scores better than alternating between very large binges and very small or empty days.",
  "Active weeks": "The share of calendar weeks in the current trend leg that contain at least one game. This captures continuity without requiring identical daily volume.",
  "Gap control": "How well the trend avoids long inactivity gaps. Short breaks are tolerated; progressively longer gaps reduce this score, while a 90+ day gap is a hard regime boundary.",
  "Previous performance": "How strongly recent prior directional legs support the current direction. Older legs receive diminishing weight, contrary legs weaken support, and structural breaks reduce carryover.",
  "Evidence confidence": "How much evidence backs the current trajectory score. It combines current-leg games with recency-weighted supportive games from previous legs, then increases smoothly with diminishing returns.",
  "Trend health": "The final guardrail applied to the trajectory score. A finish below the trend-leg mean or a flat/negative recent slope can cap the score even when earlier parts of the leg were strong.",
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

function CategoryRow({ label, value }) {
  const categoryScore = clampScore(value);
  const grade = gradeForScore(categoryScore);
  return (
    <div className="climb-category">
      <span className="climb-category-name">{label}</span>
      <strong className={`grade-letter grade-${grade.toLowerCase()}`} aria-label={`${label} grade ${grade}`}>
        {grade}
      </strong>
      <CategoryTooltip
        label={label}
        help={CATEGORY_HELP[label]}
        score={categoryScore}
        grade={grade}
      />
    </div>
  );
}

export default function ClimbScoreMetric({ climb }) {
  const score = clampScore(climb?.score);
  const evidenceConfidence = clampScore((Number(climb?.maturityConfidence) || 0) * 100);
  const priorSupport = clampScore(climb?.historySupportScore);
  const recentSlope = Number(climb?.recentSlopePer100) || 0;
  const trendGames = Math.max(0, Number(climb?.sampleSize) || 0);
  const [expandedSections, setExpandedSections] = useState({});
  const sections = [
    {
      label: "Score inputs",
      summaryScore: clampScore(climb?.rawScore),
      categories: [
        ["New territory", climb?.newTerritoryScore],
        ["Rating progress", climb?.gainScore],
        ["Elo / 100", climb?.velocityScore],
        ["30-day change", climb?.calendarVelocityScore],
        ["Cadence", climb?.cadenceScore],
        ["Vs expectation", climb?.pressureScore],
        ["Consistency", climb?.consistencyScore],
        ["Drawdown", climb?.drawdownScore],
      ],
    },
    {
      label: "Cadence inputs",
      summaryScore: clampScore(climb?.cadenceScore),
      categories: [
        ["Volume regularity", climb?.volumeRegularityScore],
        ["Active weeks", climb?.activeWeekPct],
        ["Gap control", climb?.gapControlScore],
      ],
    },
    {
      label: "Evidence & adjustments",
      summaryScore: clampScore((
        clampScore(climb?.historySupportScore)
        + clampScore((Number(climb?.maturityConfidence) || 0) * 100)
        + clampScore(climb?.scoreCap)
      ) / 3),
      categories: [
        ["Previous performance", climb?.historySupportScore],
        ["Evidence confidence", (Number(climb?.maturityConfidence) || 0) * 100],
        ["Trend health", climb?.scoreCap],
      ],
    },
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
        <div className="climb-trajectory-snapshot" aria-label="Current climb evidence summary">
          <div className="climb-snapshot-item">
            <span>Trend leg</span>
            <strong>{trendGames.toLocaleString()} games</strong>
          </div>
          <div className="climb-snapshot-item">
            <span>Evidence</span>
            <strong>{Math.round(evidenceConfidence)}%</strong>
          </div>
          <div className="climb-snapshot-item">
            <span>Prior support</span>
            <strong>{Math.round(priorSupport)}/100</strong>
          </div>
          <div className="climb-snapshot-item">
            <span>Recent slope</span>
            <strong>{recentSlope >= 0 ? "+" : ""}{recentSlope.toFixed(1)} Elo/100</strong>
          </div>
        </div>
      </div>

      <div className="climb-category-grid" aria-label="Climb score category grades">
        {sections.map((section) => {
          const expanded = Boolean(expandedSections[section.label]);
          const sectionGrade = gradeForScore(section.summaryScore);
          const sectionId = `climb-section-${section.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
          return (
            <div className={`climb-category-section ${expanded ? "is-expanded" : ""}`} key={section.label}>
              <button
                type="button"
                className="climb-category-section-toggle"
                aria-expanded={expanded}
                aria-controls={sectionId}
                onClick={() => setExpandedSections((current) => ({
                  ...current,
                  [section.label]: !current[section.label],
                }))}
              >
                <span className="climb-category-section-label">{section.label}</span>
                <strong
                  className={`grade-letter grade-${sectionGrade.toLowerCase()} climb-section-grade`}
                  aria-label={`${section.label} grade ${sectionGrade}`}
                >
                  {sectionGrade}
                </strong>
                <span className="climb-section-chevron" aria-hidden="true">›</span>
              </button>

              <div id={sectionId} className="climb-category-section-body" hidden={!expanded}>
                {section.categories.map(([label, value]) => (
                  <CategoryRow key={label} label={label} value={value} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
