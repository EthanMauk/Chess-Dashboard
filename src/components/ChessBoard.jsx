import React, { useMemo } from "react";
import { Chess } from "chess.js";

export default function ChessBoard({ fen, lastMoveSquares = [], orientation = "white" }) {
  const board = useMemo(() => {
    const chess = new Chess(fen);
    return chess.board();
  }, [fen]);

  const pieceImage = {
    wp: "https://lichess1.org/assets/piece/cburnett/wP.svg",
    wn: "https://lichess1.org/assets/piece/cburnett/wN.svg",
    wb: "https://lichess1.org/assets/piece/cburnett/wB.svg",
    wr: "https://lichess1.org/assets/piece/cburnett/wR.svg",
    wq: "https://lichess1.org/assets/piece/cburnett/wQ.svg",
    wk: "https://lichess1.org/assets/piece/cburnett/wK.svg",
    bp: "https://lichess1.org/assets/piece/cburnett/bP.svg",
    bn: "https://lichess1.org/assets/piece/cburnett/bN.svg",
    bb: "https://lichess1.org/assets/piece/cburnett/bB.svg",
    br: "https://lichess1.org/assets/piece/cburnett/bR.svg",
    bq: "https://lichess1.org/assets/piece/cburnett/bQ.svg",
    bk: "https://lichess1.org/assets/piece/cburnett/bK.svg",
  };
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const displaySquares = [];

  for (let rankIndex = 0; rankIndex < 8; rankIndex++) {
    for (let fileIndex = 0; fileIndex < 8; fileIndex++) {
      displaySquares.push({
        piece: board[rankIndex][fileIndex],
        rankIndex,
        fileIndex,
      });
    }
  }

  if (orientation === "black") displaySquares.reverse();

  return (
    <div className="board-shell">
      <div className="board">
        {displaySquares.map(({ piece, rankIndex, fileIndex }, displayIndex) => {
            const isLight = (rankIndex + fileIndex) % 2 === 0;
            const displayRow = Math.floor(displayIndex / 8);
            const displayCol = displayIndex % 8;
            const rankLabel = displayCol === 0 ? 8 - rankIndex : "";
            const fileLabel = displayRow === 7 ? files[fileIndex] : "";
            const squareName = `${files[fileIndex]}${8 - rankIndex}`;
            const isLastMove = lastMoveSquares.includes(squareName);

            return (
              <div
                key={`${rankIndex}-${fileIndex}`}
                className={`square ${isLight ? "light" : "dark"} ${isLastMove ? "last-move" : ""}`}
              >
                {rankLabel && <span className="rank-label">{rankLabel}</span>}
                {fileLabel && <span className="file-label">{fileLabel}</span>}
                {piece && (
                  <img
                    className="piece"
                    src={pieceImage[`${piece.color}${piece.type}`]}
                    alt=""
                    draggable="false"
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
