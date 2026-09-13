import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

function strengthTier(elo) {
  const n = Number(elo);
  if (!Number.isFinite(n)) return "";
  if (n >= 2850) return "World-class";
  if (n >= 2600) return "Elite";
  if (n >= 2400) return "Master";
  if (n >= 2200) return "Expert";
  if (n >= 1900) return "Advanced";
  if (n >= 1600) return "Strong club";
  if (n >= 1200) return "Developing";
  return "Beginner";
}

const PERFORMANCE_HELP = {
  "Results strength": "Absolute results strength. The model starts from the opponents' actual Elo and converts the player's score rate into an Elo-equivalent performance rating. This avoids penalizing top-ranked players simply because stronger opponents do not exist.",
  "Engine quality": "Absolute playing strength anchored by the player's Elo, then adjusted by player-vs-opponent ACPL, recent ACPL versus the longer-run baseline, and the bad-game tail. Elite players are not dragged toward 50 merely for playing equally strong elite opponents.",
  "Error control": "Absolute-strength anchored error control using practical blunders, mistakes, inaccuracies, and blunder-free games. Relative cleanliness changes the estimate around the player's established strength instead of replacing that strength.",
  "Critical decisions": "Absolute-strength anchored handling of missed mates, conversion errors, and missed opportunities. Sparse samples receive smaller adjustments so a few rare positions cannot erase the underlying level of play.",
  "Phase quality": "Absolute-strength anchored opening, middlegame, and endgame quality. Each phase is weighted by analyzed move volume and evidence confidence.",
  "Move quality": "Absolute-strength anchored move quality, adjusted by the share of good/best/great moves relative to the player's established baseline.",
  "Consistency & floor": "Absolute-strength anchored repeatability using ACPL variance, the high-ACPL bad-game tail, and blunder-free frequency. It rewards a high floor without treating normal elite variance as mediocre chess.",
  "Current form": "Current absolute level with a short-term modifier from results versus expectation, ACPL edge, and error burden in the newest block of games versus the preceding sample.",
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

function scoreTone(score) {
  const value = clampScore(score);
  if (value >= 85) return "elite";
  if (value >= 70) return "strong";
  if (value >= 55) return "steady";
  if (value >= 40) return "developing";
  return "soft";
}

export default function PerformanceMetric({ performance }) {
  const categories = Array.isArray(performance?.categories) ? performance.categories : [];
  const sampleSize = Math.max(0, Number(performance?.sampleSize) || 0);
  const confidence = Math.max(0, Math.min(1, Number(performance?.confidence) || 0));
  const estimatedElo = Number(performance?.estimatedElo);
  const estimateText = Number.isFinite(estimatedElo)
    ? `~${Math.round(estimatedElo).toLocaleString()} Elo`
    : "—";
  const tierText = strengthTier(estimatedElo);
  const toneClass = `strength-tone-${scoreTone(performance?.score)}`;

  return (
    <div className="metric performance-metric estimated-strength-metric">
      <div className="performance-header estimated-strength-header">
        <div className="performance-metric-copy">
          <div className="metric-label">Performance</div>
          <div className="performance-metric-title">Estimated strength</div>
        </div>
        <div className="performance-preview-pill">Absolute v3</div>
      </div>

      <div className="estimated-strength-hero">
        <div className="estimated-strength-copy">
          <div className={`estimated-strength-value ${toneClass}`}>{estimateText}</div>
          {tierText ? <div className="estimated-strength-tier">{tierText}</div> : null}
          <div className="estimated-strength-meta">
            Based on the latest {sampleSize.toLocaleString()} analyzed games{sampleSize ? ` · ${Math.round(confidence * 100)}% confidence` : ""}.
          </div>
        </div>
      </div>
    </div>
  );
}
