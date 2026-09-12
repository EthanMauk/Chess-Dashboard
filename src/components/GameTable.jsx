import React from "react";
import GameRow from "./GameRow";

export default function GameTable({ games, movesByGame, expandedGame, onToggle }) {
  return (
    <div className="table-wrap">
      <table className="game-table">
        <colgroup>
          <col style={{ width: "34px" }} />
          <col style={{ width: "88px" }} />
          <col style={{ width: "150px" }} />
          <col style={{ width: "72px" }} />
          <col style={{ width: "60px" }} />
          <col style={{ width: "72px" }} />
          <col style={{ width: "82px" }} />
          <col style={{ width: "68px" }} />
          <col style={{ width: "78px" }} />
          <col style={{ width: "72px" }} />
          <col style={{ width: "72px" }} />
          <col style={{ width: "82px" }} />
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>Date</th>
            <th>Opponent</th>
            <th>Result</th>
            <th>Moves</th>
            <th>Rating</th>
            <th>Opp. rating</th>
            <th>ACPL</th>
            <th>Opp. ACPL</th>
            <th>Blunders</th>
            <th>Mistakes</th>
            <th>Inaccuracies</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <GameRow
              key={game.gameNumber}
              game={game}
              moves={movesByGame.get(game.gameNumber) || []}
              expanded={expandedGame === game.gameNumber}
              onToggle={() => onToggle(game.gameNumber)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
