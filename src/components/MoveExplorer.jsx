import React, { useEffect, useMemo, useRef, useState } from "react";
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

function normalizeMoveEval(move) {
  if (!move) return 0;
  const mover = String(move.color || "").toLowerCase();
  const isMate = Boolean(move.playedAfterIsMate ?? move.played_after_is_mate);
  const mateIn = Number(move.playedMateIn ?? move.played_mate_in ?? 0);
  const rawCp = Number(move.playedAfterCp ?? move.played_after_cp ?? 0);
  const sign = mover === "black" ? -1 : 1;
  if (isMate) {
    const signedMate = mateIn * sign;
    return signedMate >= 0 ? 1000 : -1000;
  }
  return Math.max(-1000, Math.min(1000, rawCp * sign));
}

function EvaluationTimeline({ moves, selectedPly, onSelectPly }) {
  const svgRef = useRef(null);
  const draggingRef = useRef(false);

  const points = useMemo(() => {
    if (!moves.length) return [{ ply: 0, value: 0 }];
    const first = moves[0];
    const firstSide = String(first.color || "").toLowerCase();
    const firstRaw = Number(first.evalBeforeCp ?? first.eval_before_cp ?? 0);
    const firstMate = Boolean(first.beforeIsMate ?? first.before_is_mate);
    const firstMateIn = Number(first.beforeMateIn ?? first.before_mate_in ?? 0);
    const firstSign = firstSide === "black" ? -1 : 1;
    const startValue = firstMate
      ? ((firstMateIn * firstSign) >= 0 ? 1000 : -1000)
      : Math.max(-1000, Math.min(1000, firstRaw * firstSign));
    return [{ ply: 0, value: startValue }, ...moves.map((move, index) => ({
      ply: index + 1,
      value: normalizeMoveEval(move),
    }))];
  }, [moves]);

  const width = 1000;
  const height = 154;
  const padX = 12;
  const padY = 12;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const maxPly = Math.max(1, points.length - 1);
  const xFor = (ply) => padX + (Math.max(0, Math.min(maxPly, ply)) / maxPly) * innerW;
  const yFor = (value) => {
    // Symmetric ±10 pawn display range; mate positions clamp to the edges.
    const clamped = Math.max(-1000, Math.min(1000, Number(value) || 0));
    return padY + ((1000 - clamped) / 2000) * innerH;
  };
  const path = points.map((point, index) => `${index ? "L" : "M"}${xFor(point.ply).toFixed(2)},${yFor(point.value).toFixed(2)}`).join(" ");
  const eventMarkers = moves.flatMap((move, index) => {
    const category = String(move.category ?? move.qualityCategory ?? move.quality_category ?? "").toLowerCase();
    let kind = null;
    let symbol = null;
    let label = null;

    if (category === "blunder") {
      kind = "blunder";
      symbol = "!";
      label = "Blunder";
    } else if (category === "miss" || category === "missed_mate") {
      kind = "miss";
      symbol = "×";
      label = "Miss";
    } else if (category === "great") {
      kind = "great";
      symbol = "★";
      label = "Great";
    }

    if (!kind) return [];
    const ply = index + 1;
    return [{ kind, symbol, label, ply, value: points[ply]?.value ?? 0 }];
  });
  const currentPoint = points[Math.max(0, Math.min(points.length - 1, selectedPly))] || points[0];
  const displayEval = Math.abs(currentPoint.value) >= 1000
    ? (currentPoint.value >= 0 ? "White mate" : "Black mate")
    : `${currentPoint.value >= 0 ? "+" : ""}${(currentPoint.value / 100).toFixed(2)}`;

  function scrub(event) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onSelectPly(Math.round(ratio * maxPly));
  }

  function onPointerDown(event) {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrub(event);
  }

  function onPointerMove(event) {
    if (draggingRef.current || event.buttons === 1) scrub(event);
  }

  function stopDrag(event) {
    draggingRef.current = false;
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="evaluation-timeline-wrap">
      <div className="evaluation-timeline-header">
        <strong>Evaluation · {displayEval}</strong>
        <span>Move {Math.max(0, Math.min(maxPly, selectedPly))}/{maxPly} · drag to scrub</span>
      </div>
      <svg
        ref={svgRef}
        className="evaluation-timeline"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="slider"
        aria-label="Game evaluation by move"
        aria-valuemin={0}
        aria-valuemax={maxPly}
        aria-valuenow={Math.max(0, Math.min(maxPly, selectedPly))}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); onSelectPly(Math.max(0, selectedPly - 1)); }
          if (event.key === "ArrowRight") { event.preventDefault(); onSelectPly(Math.min(maxPly, selectedPly + 1)); }
        }}
      >
        <rect className="evaluation-timeline-white-zone" x={padX} y={padY} width={innerW} height={innerH / 2} />
        <rect className="evaluation-timeline-black-zone" x={padX} y={padY + innerH / 2} width={innerW} height={innerH / 2} />
        <line className="evaluation-timeline-zero" x1={padX} x2={width - padX} y1={yFor(0)} y2={yFor(0)} />
        <path className="evaluation-timeline-path-shadow" d={path} />
        <path className="evaluation-timeline-path" d={path} />
        {eventMarkers.map((marker) => (
          <text
            key={`${marker.kind}-${marker.ply}`}
            className={`evaluation-timeline-marker evaluation-timeline-marker-${marker.kind}`}
            x={xFor(marker.ply)}
            y={yFor(marker.value)}
            dy={marker.value >= 0 ? -9 : 14}
            textAnchor="middle"
            dominantBaseline="middle"
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${marker.label} · ply ${marker.ply}`}</title>
            {marker.symbol}
          </text>
        ))}
        <line className="evaluation-timeline-cursor" x1={xFor(selectedPly)} x2={xFor(selectedPly)} y1={padY} y2={height - padY} />
        <circle className="evaluation-timeline-point" cx={xFor(selectedPly)} cy={yFor(currentPoint.value)} r="5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="evaluation-timeline-axis" aria-hidden="true">
        <span>White</span><span>0.0</span><span>Black</span>
      </div>
    </div>
  );
}

export default function MoveExplorer({ moves, playerColor = "white", initialClockSeconds = null }) {
  const [selectedPly, setSelectedPly] = useState(0);
  const moveListScrubbingRef = useRef(false);

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

  const moveColumns = useMemo(() => {
    const rowsPerColumn = 16;
    const columns = [];
    for (let i = 0; i < movePairs.length; i += rowsPerColumn) {
      columns.push(movePairs.slice(i, i + rowsPerColumn));
    }
    return columns;
  }, [movePairs]);

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

  function beginMoveListScrub(event, move) {
    // Prevent the browser's persistent button focus ring while preserving the
    // selected-move highlight controlled by aria-current.
    event.preventDefault();
    moveListScrubbingRef.current = true;
    selectMove(move);
  }

  function scrubMoveList(event, move) {
    if (moveListScrubbingRef.current || event.buttons === 1) selectMove(move);
  }

  function endMoveListScrub() {
    moveListScrubbingRef.current = false;
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

      <div className="compact-move-panel" onPointerUp={endMoveListScrub} onPointerCancel={endMoveListScrub} onPointerLeave={endMoveListScrub}>
        <EvaluationTimeline moves={moves} selectedPly={safePly} onSelectPly={setSelectedPly} />
        <div className="compact-move-panel-header">
          <strong>Moves</strong>
          <span>{moves.length} plies</span>
        </div>
        <div className="tournament-score-columns" aria-label="Game moves">
          {moveColumns.map((column, columnIndex) => (
            <div className="compact-move-list tournament-move-list tournament-score-block" role="table" key={columnIndex}>
              <div className="tournament-move-header" role="row">
                <span role="columnheader">#</span>
                <span role="columnheader">White</span>
                <span role="columnheader">Black</span>
              </div>
              {column.map((pair) => (
                <div className="compact-move-pair tournament-move-row" key={pair.fullMove} role="row">
                  <span className="compact-move-number" role="cell">{pair.fullMove}.</span>
                  <span className="tournament-move-cell" role="cell">
                    {pair.white && (
                      <button
                        className="compact-move-token"
                        onPointerDown={(event) => beginMoveListScrub(event, pair.white)}
                        onPointerEnter={(event) => scrubMoveList(event, pair.white)}
                        onClick={() => selectMove(pair.white)}
                        aria-current={Number(currentMove?.ply) === Number(pair.white.ply) ? "true" : undefined}
                        title={moveNotation(pair.white)}
                      >
                        <span className="compact-move-san">{pair.white.san}</span>
                      </button>
                    )}
                  </span>
                  <span className="tournament-move-cell" role="cell">
                    {pair.black && (
                      <button
                        className="compact-move-token"
                        onPointerDown={(event) => beginMoveListScrub(event, pair.black)}
                        onPointerEnter={(event) => scrubMoveList(event, pair.black)}
                        onClick={() => selectMove(pair.black)}
                        aria-current={Number(currentMove?.ply) === Number(pair.black.ply) ? "true" : undefined}
                        title={moveNotation(pair.black)}
                      >
                        <span className="compact-move-san">{pair.black.san}</span>
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="compact-move-legend">
          Click a move or drag across the scoresheet to scrub through the game.
        </div>
      </div>
    </div>
  );
}
