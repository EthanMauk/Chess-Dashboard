import React, { useEffect, useId, useMemo, useState } from "react";
import { Chess } from "chess.js";

export default function ChessBoard({
  fen,
  lastMoveSquares = [],
  orientation = "white",
  arrows = [],
  onMove = null,
}) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const board = useMemo(() => chess.board(), [chess]);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const arrowId = useId().replace(/:/g, "");

  useEffect(() => {
    setSelectedSquare(null);
    setDragFrom(null);
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
      displaySquares.push({ piece: board[rankIndex][fileIndex], rankIndex, fileIndex });
    }
  }

  if (orientation === "black") displaySquares.reverse();

  const legalTargets = useMemo(() => {
    if (!selectedSquare || !onMove) return new Set();
    try {
      return new Set(chess.moves({ square: selectedSquare, verbose: true }).map((move) => move.to));
    } catch {
      return new Set();
    }
  }, [chess, onMove, selectedSquare]);

  function isMovablePiece(piece) {
    return Boolean(onMove && piece && piece.color === chess.turn());
  }

  function tryMove(from, to) {
    if (!onMove || !from || !to) return false;
    let promotion = "q";
    try {
      const candidates = chess.moves({ square: from, verbose: true }).filter((move) => move.to === to);
      const queenPromotion = candidates.find((move) => move.promotion === "q");
      promotion = queenPromotion?.promotion || candidates[0]?.promotion || "q";
    } catch {}
    const accepted = onMove({ from, to, promotion });
    if (accepted !== false) {
      setSelectedSquare(null);
      setDragFrom(null);
      return true;
    }
    return false;
  }

  function handleSquareClick(squareName, piece) {
    if (!onMove) return;

    if (selectedSquare) {
      if (selectedSquare === squareName) {
        setSelectedSquare(null);
        return;
      }
      if (legalTargets.has(squareName) && tryMove(selectedSquare, squareName)) return;
    }

    if (isMovablePiece(piece)) setSelectedSquare(squareName);
    else setSelectedSquare(null);
  }

  function squarePoint(square) {
    const file = files.indexOf(String(square || "")[0]);
    const rank = Number(String(square || "")[1]);
    if (file < 0 || !Number.isFinite(rank) || rank < 1 || rank > 8) return null;

    if (orientation === "black") {
      return { x: (7 - file) + 0.5, y: (rank - 1) + 0.5 };
    }
    return { x: file + 0.5, y: (8 - rank) + 0.5 };
  }

  const arrowColor = "#22c55e";

  return (
    <div className="board-shell" style={{ position: "relative" }}>
      <div className="board">
        {displaySquares.map(({ piece, rankIndex, fileIndex }, displayIndex) => {
          const isLight = (rankIndex + fileIndex) % 2 === 0;
          const displayRow = Math.floor(displayIndex / 8);
          const displayCol = displayIndex % 8;
          const rankLabel = displayCol === 0 ? 8 - rankIndex : "";
          const fileLabel = displayRow === 7 ? files[fileIndex] : "";
          const squareName = `${files[fileIndex]}${8 - rankIndex}`;
          const isLastMove = lastMoveSquares.includes(squareName);
          const isSelected = selectedSquare === squareName;
          const isLegalTarget = legalTargets.has(squareName);
          const movable = isMovablePiece(piece);

          return (
            <div
              key={`${rankIndex}-${fileIndex}`}
              className={`square ${isLight ? "light" : "dark"} ${isLastMove ? "last-move" : ""}`}
              onClick={() => handleSquareClick(squareName, piece)}
              onDragOver={(event) => {
                if (onMove && dragFrom) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragFrom || event.dataTransfer?.getData("text/plain");
                if (from) tryMove(from, squareName);
              }}
              style={{
                cursor: onMove ? (movable ? "grab" : "pointer") : undefined,
                boxShadow: isSelected ? "inset 0 0 0 4px rgba(255,255,255,.62)" : undefined,
              }}
            >
              {rankLabel && <span className="rank-label">{rankLabel}</span>}
              {fileLabel && <span className="file-label">{fileLabel}</span>}
              {isLegalTarget && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    width: piece ? "72%" : "22%",
                    height: piece ? "72%" : "22%",
                    borderRadius: "50%",
                    border: piece ? "4px solid rgba(20,20,20,.34)" : "none",
                    background: piece ? "transparent" : "rgba(20,20,20,.34)",
                    pointerEvents: "none",
                    zIndex: 1,
                  }}
                />
              )}
              {piece && (
                <img
                  className="piece"
                  src={pieceImage[`${piece.color}${piece.type}`]}
                  alt=""
                  draggable={movable}
                  onDragStart={(event) => {
                    if (!movable) {
                      event.preventDefault();
                      return;
                    }
                    setDragFrom(squareName);
                    setSelectedSquare(squareName);
                    event.dataTransfer?.setData("text/plain", squareName);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragFrom(null)}
                  style={{ position: "relative", zIndex: 2 }}
                />
              )}
            </div>
          );
        })}
      </div>

      {arrows.length > 0 && (
        <svg
          viewBox="0 0 8 8"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <defs>
            {arrows.slice(0, 3).map((arrow, index) => (
              <marker
                key={`marker-${index}`}
                id={`engine-arrow-${arrowId}-${index}`}
                markerWidth="3.2"
                markerHeight="3.2"
                refX="2.75"
                refY="1.6"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L3.2,1.6 L0,3.2 z" fill={arrowColor} />
              </marker>
            ))}
          </defs>
          {arrows.slice(0, 3).map((arrow, index) => {
            const from = squarePoint(arrow.from);
            const to = squarePoint(arrow.to);
            if (!from || !to) return null;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy) || 1;
            const shorten = 0.23;
            const x2 = to.x - (dx / length) * shorten;
            const y2 = to.y - (dy / length) * shorten;
            return (
              <line
                key={`${arrow.from}-${arrow.to}-${index}`}
                x1={from.x}
                y1={from.y}
                x2={x2}
                y2={y2}
                stroke={arrowColor}
                strokeWidth={index === 0 ? 0.105 : index === 1 ? 0.082 : 0.066}
                strokeLinecap="round"
                opacity={index === 0 ? 0.82 : index === 1 ? 0.52 : 0.34}
                markerEnd={`url(#engine-arrow-${arrowId}-${index})`}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}
