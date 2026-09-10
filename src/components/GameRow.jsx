import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import MoveExplorer from "./MoveExplorer";
import { formatDate, resultClass } from "../utils/chessData";

export default function GameRow({ game, moves, expanded, onToggle }) {
  const opponent = game.playerColor.toLowerCase() === "white" ? game.black : game.white;

  return (
    <>
      <tr className="game-row" onClick={onToggle}>
        <td>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
        <td>{formatDate(game.date)}</td>
        <td className="opponent-cell" title={opponent}>{opponent}</td>
        <td>
          <span className={`result ${resultClass(game.result)}`}>
            {game.result.toUpperCase()}
          </span>
        </td>
        <td>{game.playerRating}</td>
        <td>{game.opponentRating}</td>
        <td>{game.playerAcpl.toFixed(1)}</td>
        <td>{game.opponentAcpl.toFixed(1)}</td>
        <td>{game.playerPracticalBlunders}</td>
        <td>{game.playerMistakes}</td>
        <td>{game.playerInaccuracies}</td>
      </tr>

      {expanded && (
        <tr className="expanded-row">
          <td colSpan="11">
            <div className="game-detail">
              <div className="detail-stats">
                <div><b>Game</b> #{game.gameNumber}</div>
                <div><b>Result</b> {game.resultRaw}</div>
                <div><b>Color</b> {game.playerColor}</div>
                <div><b>Moves</b> {game.fullMoves}</div>
                <div><b>Raw blunders</b> {game.playerRawBlunders}</div>
                <div><b>Blunders</b> {game.playerPracticalBlunders}</div>
                <div><b>Missed opportunities</b> {game.playerMissedOpportunities}</div>
                <div><b>Missed mates</b> {game.playerMissedMates}</div>
              </div>

              <MoveExplorer moves={moves} playerColor={game.playerColor} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
