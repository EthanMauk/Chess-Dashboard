import React from "react";
import { Target } from "lucide-react";

export default function RecordMetric({ wins = 0, losses = 0, draws = 0 }) {
  const totalGames = wins + losses + draws;
  const total = Math.max(1, totalGames);
  const winPct = (wins / total) * 100;
  const drawPct = (draws / total) * 100;
  const lossPct = (losses / total) * 100;
  const scorePct = ((wins + draws * 0.5) / total) * 100;
  const decisivePct = ((wins + losses) / total) * 100;
  const netWins = wins - losses;

  return (
    <div className="metric record-metric">
      <div className="record-header">
        <div>
          <div className="metric-label">Record</div>
          <div className="metric-value record-value">{wins}-{losses}-{draws}</div>
          <div className="metric-sub">{winPct.toFixed(1)}% wins · {totalGames.toLocaleString()} games</div>
        </div>
        <div className="metric-icon record-icon" aria-hidden="true"><Target size={17} /></div>
      </div>

      <div className="record-result-block">
        <div className="record-bar" role="img" aria-label={`${winPct.toFixed(1)}% wins, ${drawPct.toFixed(1)}% draws, ${lossPct.toFixed(1)}% losses`}>
          <span className="record-bar-win" style={{ width: `${winPct}%` }} />
          <span className="record-bar-draw" style={{ width: `${drawPct}%` }} />
          <span className="record-bar-loss" style={{ width: `${lossPct}%` }} />
        </div>

        <div className="record-legend" aria-label="Win draw loss totals">
          <span className="record-legend-win"><i />W {wins}</span>
          <span className="record-legend-draw"><i />D {draws}</span>
          <span className="record-legend-loss"><i />L {losses}</span>
        </div>
      </div>

      <div className="record-breakdown" aria-label="Record summary statistics">
        <div><span>Win rate</span><strong>{winPct.toFixed(1)}%</strong></div>
        <div><span>Score rate</span><strong>{scorePct.toFixed(1)}%</strong></div>
        <div><span>Decisive games</span><strong>{decisivePct.toFixed(1)}%</strong></div>
        <div><span>Net wins</span><strong>{netWins >= 0 ? "+" : ""}{netWins}</strong></div>
      </div>
    </div>
  );
}
