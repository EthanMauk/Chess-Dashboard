import React from "react";

export default function EvalBar({ evaluation, orientation = "white" }) {
  const rawCp = Number(evaluation?.cp ?? 0);
  const rawMateIn = Number(evaluation?.mateIn ?? 0);
  const mateFlag =
    Boolean(evaluation?.isMate) ||
    (Number.isFinite(rawMateIn) && rawMateIn !== 0);

  const displayEval = mateFlag
    ? (rawMateIn >= 0 ? 10000 : -10000)
    : rawCp;

  const clamped = Math.max(-1000, Math.min(1000, displayEval));
  const whitePct = 50 + (clamped / 1000) * 50;
  const blackPct = 100 - whitePct;

  // Keep the displayed sign from the player's board orientation:
  // positive means the side at the bottom is better, negative means the
  // opponent at the top is better.
  const orientationSign =
    String(orientation).toLowerCase() === "black" ? -1 : 1;
  const orientedEval = displayEval * orientationSign;
  const orientedMateIn = rawMateIn * orientationSign;

  const label = mateFlag
    ? `${orientedMateIn >= 0 ? "+M" : "-M"}${Math.abs(orientedMateIn || 1)}`
    : `${orientedEval >= 0 ? "+" : ""}${(orientedEval / 100).toFixed(1)}`;

  const blackOnBottom = String(orientation).toLowerCase() === "black";
  const topPct = blackOnBottom ? whitePct : blackPct;
  const bottomPct = blackOnBottom ? blackPct : whitePct;
  const topClass = blackOnBottom ? "eval-white" : "eval-black";
  const bottomClass = blackOnBottom ? "eval-black" : "eval-white";

  const whiteAhead = displayEval >= 0;
  const winningSideOnBottom =
    (whiteAhead && !blackOnBottom) || (!whiteAhead && blackOnBottom);

  return (
    <div className="eval-bar" title={`Evaluation ${label}`}>
      <div className={topClass} style={{ height: `${topPct}%` }} />
      <div className={bottomClass} style={{ height: `${bottomPct}%` }} />
      <div
        className={`eval-score ${
          winningSideOnBottom ? "score-bottom" : "score-top"
        } ${whiteAhead ? "white-winning" : "black-winning"}`}
      >
        {label}
      </div>
    </div>
  );
}
