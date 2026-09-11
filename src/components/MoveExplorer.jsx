import React, { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import ChessBoard from "./ChessBoard";
import EvalBar from "./EvalBar";

function titleCaseCategory(value) {
  return String(value || "good")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}


function categoryIcon(value) {
  switch (String(value || "").toLowerCase()) {
    case "great": return "✦";
    case "best": return "★";
    case "miss":
    case "missed_mate": return "!";
    case "blunder": return "✕";
    default: return null;
  }
}

function moveNotation(move) {
  if (!move) return "Starting position";
  const dots = String(move.color || "").toLowerCase() === "white" ? "." : "...";
  return `${move.fullMove}${dots} ${move.san}`;
}

export default function MoveExplorer({ moves, playerColor = "white", initialClockSeconds = null }) {
  const [selectedPly, setSelectedPly] = useState(0);

  useEffect(() => {
    setSelectedPly(0);
  }, [moves]);

  const positions = useMemo(() => {
    const chess = new Chess();
    const out = [{ ply: 0, fen: chess.fen(), move: null }];

    for (const move of moves) {
      try {
        const played = chess.move(move.san);
        out.push({
          ply: move.ply,
          fen: chess.fen(),
          move,
          from: played?.from ?? null,
          to: played?.to ?? null,
        });
      } catch {
        break;
      }
    }

    return out;
  }, [moves]);

  const movePairs = useMemo(() => {
    const pairs = [];
    for (const move of moves) {
      const fullMove = Number(move.fullMove);
      let pair = pairs[pairs.length - 1];
      if (!pair || pair.fullMove !== fullMove) {
        pair = { fullMove, white: null, black: null };
        pairs.push(pair);
      }
      if (String(move.color || "").toLowerCase() === "black") pair.black = move;
      else pair.white = move;
    }
    return pairs;
  }, [moves]);

  if (!moves.length) {
    return <div className="empty-small">No move data loaded for this game.</div>;
  }

  const maxPly = Math.max(0, positions.length - 1);
  const safePly = Math.min(selectedPly, maxPly);
  const current = positions[safePly];
  const currentMove = current?.move;

  const clocks = (() => {
    const initial = Number.isFinite(Number(initialClockSeconds)) ? Number(initialClockSeconds) : null;
    const state = { white: initial, black: initial };

    for (let i = 0; i < safePly && i < moves.length; i++) {
      const move = moves[i];
      const side = String(move.color || "").toLowerCase();
      const value = move.clockSeconds;
      if ((side === "white" || side === "black") && value != null && Number.isFinite(Number(value))) {
        state[side] = Number(value);
      }
    }
    return state;
  })();

  const orientation = String(playerColor).toLowerCase() === "black" ? "black" : "white";
  const youColor = orientation;
  const opponentColor = youColor === "white" ? "black" : "white";
  const sideToMove = safePly % 2 === 0 ? "white" : "black";

  function formatClock(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return "--:--";
    const total = Math.max(0, Math.floor(Number(seconds)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const wholeSeconds = total % 60;
    const secText = String(wholeSeconds).padStart(2, "0");
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secText}`;
    return `${minutes}:${secText}`;
  }

  // The board at ply N is the position BEFORE ply N+1.
  // Prefer the next move's "before" evaluation because it describes the exact
  // board currently on screen. At the end of the game, fall back to the
  // current move's played-after evaluation.
  const nextMove = safePly < moves.length ? moves[safePly] : null;

  const boardEvaluation = (() => {
    if (safePly === 0 && moves[0]) {
      const first = moves[0];
      const cp = Number(first.evalBeforeCp ?? first.eval_before_cp ?? 0);
      const mateIn = Number(first.beforeMateIn ?? first.before_mate_in ?? 0);
      const isMate = Boolean(first.beforeIsMate ?? first.before_is_mate);
      return { cp, mateIn, isMate };
    }

    if (nextMove) {
      const nextSide = String(nextMove.color ?? "").toLowerCase();
      const rawCp = Number(nextMove.evalBeforeCp ?? nextMove.eval_before_cp ?? 0);
      const rawMateIn = Number(nextMove.beforeMateIn ?? nextMove.before_mate_in ?? 0);
      const sign = nextSide === "black" ? -1 : 1;
      return {
        cp: rawCp * sign,
        mateIn: rawMateIn * sign,
        isMate: Boolean(nextMove.beforeIsMate ?? nextMove.before_is_mate),
      };
    }

    if (currentMove) {
      const mover = String(currentMove.color ?? "").toLowerCase();
      const rawCp = Number(currentMove.playedAfterCp ?? currentMove.played_after_cp ?? 0);
      const rawMateIn = Number(currentMove.playedMateIn ?? currentMove.played_mate_in ?? 0);
      const sign = mover === "white" ? 1 : -1;
      return {
        cp: rawCp * sign,
        mateIn: rawMateIn * sign,
        isMate: Boolean(currentMove.playedAfterIsMate ?? currentMove.played_after_is_mate),
      };
    }

    return { cp: 0, mateIn: 0, isMate: false };
  })();

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setSelectedPly((ply) => Math.max(0, Math.min(ply, maxPly) - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setSelectedPly((ply) => Math.min(maxPly, Math.max(0, ply) + 1));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maxPly]);


  function selectMove(move) {
    const positionIndex = positions.findIndex((position) => Number(position.ply) === Number(move.ply));
    if (positionIndex >= 0) setSelectedPly(positionIndex);
  }

  const selectedMoveNotation = currentMove ? moveNotation(currentMove) : "Starting position";
  const selectedMoveCategory = currentMove ? titleCaseCategory(currentMove.category) : null;
  const selectedMoveLoss = currentMove ? Math.round(Number(currentMove.rawLossCp) || 0) : null;
  const selectedMoveIcon = currentMove ? categoryIcon(currentMove.category) : null;

  return (
    <div className="explorer compact-explorer">
      <div className="board-panel">
        <div className="board-with-eval">
          <EvalBar evaluation={boardEvaluation} orientation={orientation} />
          <ChessBoard
            fen={current.fen}
            lastMoveSquares={[current?.from, current?.to].filter(Boolean)}
            orientation={orientation}
          />
        </div>

        <div className="review-clocks-below">
          <div className={`review-clock-row ${sideToMove !== youColor ? "is-inactive" : ""}`}>
            <span>You · {youColor[0].toUpperCase() + youColor.slice(1)}</span>
            <strong>{formatClock(clocks[youColor])}</strong>
          </div>
          <div className={`review-clock-row ${sideToMove !== opponentColor ? "is-inactive" : ""}`}>
            <span>Opp · {opponentColor[0].toUpperCase() + opponentColor.slice(1)}</span>
            <strong>{formatClock(clocks[opponentColor])}</strong>
          </div>
        </div>

        <div className="board-controls compact-board-controls">
          <button className="nav-button" onClick={() => setSelectedPly(0)} aria-label="First move">⏮</button>
          <button className="nav-button" onClick={() => setSelectedPly(Math.max(0, safePly - 1))} aria-label="Previous move">◀</button>
          <div className="ply-label selected-move-summary" title={selectedMoveNotation}>
            {currentMove ? (
              <div className="current-move-grade current-move-grade-inline" aria-label={`Move grade: ${selectedMoveCategory}, ${selectedMoveLoss} centipawn loss`}>
                <span className={`current-move-category category ${String(currentMove.category || "good").toLowerCase()}`}>
                  {selectedMoveIcon && <span className="current-move-category-icon" aria-hidden="true">{selectedMoveIcon}</span>}
                  <span>{selectedMoveCategory}</span>
                </span>
                <span className="current-move-grade-separator">·</span>
                <span className="current-move-loss">{selectedMoveLoss} cp loss</span>
              </div>
            ) : (
              <span>Starting position</span>
            )}
          </div>
          <button className="nav-button" onClick={() => setSelectedPly(Math.min(maxPly, safePly + 1))} aria-label="Next move">▶</button>
          <button className="nav-button" onClick={() => setSelectedPly(maxPly)} aria-label="Last move">⏭</button>
        </div>
        <div className="keyboard-hint">← / → step through moves</div>
      </div>

      <div className="compact-move-panel">
        <div className="compact-move-panel-header">
          <strong>Moves</strong>
          <span>{moves.length} plies</span>
        </div>
        <div className="compact-move-list">
          {movePairs.map((pair) => (
            <span className="compact-move-pair" key={pair.fullMove}>
              <span className="compact-move-number">{pair.fullMove}.</span>
              {pair.white && (
                <button
                  className="compact-move-token"
                  onClick={() => selectMove(pair.white)}
                  aria-current={Number(currentMove?.ply) === Number(pair.white.ply) ? "true" : undefined}
                  title={moveNotation(pair.white)}
                >
                  <span className="compact-move-san">{pair.white.san}</span>
                </button>
              )}
              {pair.black && (
                <button
                  className="compact-move-token"
                  onClick={() => selectMove(pair.black)}
                  aria-current={Number(currentMove?.ply) === Number(pair.black.ply) ? "true" : undefined}
                  title={moveNotation(pair.black)}
                >
                  <span className="compact-move-san">{pair.black.san}</span>
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="compact-move-legend">
          Click any move to jump to that position.
        </div>
      </div>
    </div>
  );
}
