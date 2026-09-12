import React from "react";
import { Target } from "lucide-react";

export default function RecordMetric({ wins = 0, losses = 0, draws = 0 }) {
  const total = Math.max(1, wins + losses + draws);
  const winPct = (wins / total) * 100;
  const drawPct = (draws / total) * 100;
  const lossPct = (losses / total) * 100;

  return (
    <div className="metric record-metric">
      <div className="metric-icon"><Target size={18} /></div>
      <div className="record-metric-body">
        <div className="metric-label">Record</div>
        <div className="metric-value">{wins}-{losses}-{draws}</div>
        <div className="metric-sub">{winPct.toFixed(1)}% wins</div>

        <div className="record-bar" role="img" aria-label={`${winPct.toFixed(1)}% wins, ${drawPct.toFixed(1)}% draws, ${lossPct.toFixed(1)}% losses`}>
          <span className="record-bar-win" style={{ width: `${winPct}%` }} />
          <span className="record-bar-draw" style={{ width: `${drawPct}%` }} />
          <span className="record-bar-loss" style={{ width: `${lossPct}%` }} />
        </div>

        <div className="record-legend" aria-hidden="true">
          <span className="record-legend-win">W {wins}</span>
          <span className="record-legend-draw">D {draws}</span>
          <span className="record-legend-loss">L {losses}</span>
        </div>
      </div>
    </div>
  );
}
