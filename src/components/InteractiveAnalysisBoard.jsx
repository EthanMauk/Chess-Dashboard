import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import ChessBoard from "./ChessBoard";
import EvalBar from "./EvalBar";

const ENGINE_URL = "/stockfish/stockfish-18-lite-single.js";
const ENGINE_NODES = 12000;
const MULTIPV = 3;

function fenTurn(fen) {
  return String(fen || "").split(" ")[1] === "b" ? "b" : "w";
}

function parseInfoLine(text, fen) {
  if (!text.startsWith("info ") || !text.includes(" pv ") || !text.includes(" score ")) return null;

  const depthMatch = text.match(/\bdepth\s+(\d+)/);
  const multipvMatch = text.match(/\bmultipv\s+(\d+)/);
  const scoreMatch = text.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
  const pvMatch = text.match(/\bpv\s+(.+)$/);
  if (!scoreMatch || !pvMatch) return null;

  const turnSign = fenTurn(fen) === "w" ? 1 : -1;
  const scoreType = scoreMatch[1];
  const rawScore = Number(scoreMatch[2]);
  const whiteScore = rawScore * turnSign;

  return {
    multipv: Number(multipvMatch?.[1] || 1),
    depth: Number(depthMatch?.[1] || 0),
    cp: scoreType === "cp" ? whiteScore : 0,
    mateIn: scoreType === "mate" ? whiteScore : 0,
    isMate: scoreType === "mate",
    pv: pvMatch[1].trim().split(/\s+/).filter(Boolean),
  };
}

function uciMoveParts(uci) {
  const text = String(uci || "");
  if (text.length < 4) return null;
  return {
    from: text.slice(0, 2),
    to: text.slice(2, 4),
    promotion: text.length >= 5 ? text[4] : undefined,
  };
}

function pvToSan(fen, pv, maxPlies = 8) {
  try {
    const chess = new Chess(fen);
    const sans = [];
    for (const uci of (pv || []).slice(0, maxPlies)) {
      const parts = uciMoveParts(uci);
      if (!parts) break;
      const move = chess.move(parts);
      if (!move) break;
      sans.push(move.san);
    }
    return sans.join(" ");
  } catch {
    return "";
  }
}

function formatEval(line) {
  if (!line) return "—";
  if (line.isMate) return `${line.mateIn >= 0 ? "+M" : "-M"}${Math.abs(line.mateIn || 1)}`;
  return `${line.cp >= 0 ? "+" : ""}${(line.cp / 100).toFixed(2)}`;
}

export default function InteractiveAnalysisBoard({
  fen,
  storedEvaluation,
  orientation = "white",
  lastMoveSquares = [],
}) {
  const [analysisMode, setAnalysisMode] = useState(false);
  const [variation, setVariation] = useState([]);
  const [engineLines, setEngineLines] = useState([]);
  const [engineReady, setEngineReady] = useState(false);
  const [engineError, setEngineError] = useState("");
  const workerRef = useRef(null);
  const searchFenRef = useRef(fen);

  useEffect(() => {
    setVariation([]);
    setEngineLines([]);
  }, [fen]);

  const displayFen = variation.length ? variation[variation.length - 1].fen : fen;
  const variationLast = variation[variation.length - 1] || null;
  const displayLastMoveSquares = variationLast
    ? [variationLast.from, variationLast.to]
    : lastMoveSquares;

  useEffect(() => {
    if (!analysisMode) {
      setEngineLines([]);
      setEngineReady(false);
      setEngineError("");
      if (workerRef.current) {
        try { workerRef.current.postMessage("stop"); } catch {}
        workerRef.current.terminate();
        workerRef.current = null;
      }
      return undefined;
    }

    let worker;
    try {
      worker = new Worker(ENGINE_URL);
    } catch (error) {
      setEngineError(error?.message || "Could not start Stockfish.");
      return undefined;
    }

    workerRef.current = worker;
    setEngineReady(false);
    setEngineError("");

    worker.onmessage = (event) => {
      const text = String(event.data || "").trim();
      if (!text) return;

      if (text === "uciok") {
        worker.postMessage(`setoption name MultiPV value ${MULTIPV}`);
        worker.postMessage("isready");
        return;
      }

      if (text === "readyok") {
        setEngineReady(true);
        return;
      }

      const parsed = parseInfoLine(text, searchFenRef.current);
      if (!parsed || parsed.multipv < 1 || parsed.multipv > MULTIPV) return;

      setEngineLines((previous) => {
        const next = [...previous];
        next[parsed.multipv - 1] = parsed;
        return next.filter(Boolean).sort((a, b) => a.multipv - b.multipv);
      });
    };

    worker.onerror = () => {
      setEngineError("Stockfish failed to load in this browser.");
    };

    worker.postMessage("uci");

    return () => {
      try { worker.postMessage("stop"); } catch {}
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [analysisMode]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!analysisMode || !engineReady || !worker || !displayFen) return;

    searchFenRef.current = displayFen;
    setEngineLines([]);
    try {
      worker.postMessage("stop");
      worker.postMessage(`setoption name MultiPV value ${MULTIPV}`);
      worker.postMessage(`position fen ${displayFen}`);
      worker.postMessage(`go nodes ${ENGINE_NODES}`);
    } catch (error) {
      setEngineError(error?.message || "Engine search failed.");
    }
  }, [analysisMode, engineReady, displayFen]);

  const arrows = useMemo(() => {
    if (!analysisMode) return [];
    return engineLines.slice(0, MULTIPV).flatMap((line, index) => {
      const first = uciMoveParts(line.pv?.[0]);
      if (!first) return [];
      return [{
        from: first.from,
        to: first.to,
        rank: index + 1,
      }];
    });
  }, [analysisMode, engineLines]);

  const engineEvaluation = analysisMode && engineLines[0]
    ? {
        cp: engineLines[0].cp,
        mateIn: engineLines[0].mateIn,
        isMate: engineLines[0].isMate,
      }
    : storedEvaluation;

  function makeMove({ from, to, promotion = "q" }) {
    try {
      const chess = new Chess(displayFen);
      const move = chess.move({ from, to, promotion });
      if (!move) return false;
      setVariation((previous) => [...previous, {
        fen: chess.fen(),
        from: move.from,
        to: move.to,
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion || ""}`,
      }]);
      return true;
    } catch {
      return false;
    }
  }

  function undoVariation() {
    setVariation((previous) => previous.slice(0, -1));
  }

  function returnToGame() {
    setVariation([]);
  }

  return (
    <div>
      <div className="board-with-eval">
        <EvalBar evaluation={engineEvaluation} orientation={orientation} />
        <ChessBoard
          fen={displayFen}
          lastMoveSquares={displayLastMoveSquares}
          orientation={orientation}
          arrows={arrows}
          onMove={makeMove}
        />
      </div>

      <div style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        marginTop: 5,
        minHeight: 26,
      }}>
        <button
          type="button"
          onClick={() => setAnalysisMode((value) => !value)}
          aria-pressed={analysisMode}
          style={{
            appearance: "none",
            border: 0,
            background: "transparent",
            color: "inherit",
            padding: "4px 8px",
            font: "inherit",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: ".01em",
            cursor: "pointer",
            opacity: analysisMode ? 0.78 : 0.48,
          }}
        >
          Analysis · {analysisMode ? "On" : "Off"}
        </button>
      </div>

      {variation.length > 0 && (
        <div style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 2,
        }}>
          <span style={{
            minWidth: 0,
            flex: "1 1 180px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            opacity: 0.72,
          }}>
            {variation.map((item) => item.san).join(" ")}
          </span>
          <button type="button" className="nav-button" onClick={undoVariation} style={{ width: "auto", height: 30, paddingInline: 9 }}>
            Undo
          </button>
          <button type="button" className="nav-button" onClick={returnToGame} style={{ width: "auto", height: 30, paddingInline: 9 }}>
            Played line
          </button>
        </div>
      )}

      {analysisMode && (
        <div style={{ marginTop: 6 }}>
          {engineError ? (
            <div style={{ padding: "6px 2px", fontSize: 12, opacity: 0.72 }}>{engineError}</div>
          ) : engineLines.length ? (
            engineLines.slice(0, MULTIPV).map((line, index) => (
              <div
                key={line.multipv}
                style={{
                  display: "grid",
                  gridTemplateColumns: "48px minmax(0, 1fr)",
                  gap: 10,
                  alignItems: "center",
                  minHeight: 30,
                  padding: "3px 2px",
                  borderTop: index ? "1px solid rgba(139,148,158,.12)" : "none",
                  fontSize: 12,
                }}
              >
                <strong style={{ fontVariantNumeric: "tabular-nums" }}>{formatEval(line)}</strong>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: index === 0 ? 0.9 : 0.68 }}>
                  {pvToSan(displayFen, line.pv) || line.pv?.slice(0, 8).join(" ")}
                </span>
              </div>
            ))
          ) : (
            <div style={{ padding: "6px 2px", fontSize: 12, opacity: 0.55 }}>
              {engineReady ? "Analyzing…" : "Loading engine…"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
