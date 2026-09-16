import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { Chess } from "chess.js";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import {
  Upload,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Database,
  Trophy,
  Target,
  AlertTriangle,
  Activity,
} from "lucide-react";

const STORAGE_KEY = "protox09-chess-dashboard-v2";

function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: (result) => {
        if (result.errors?.length) {
          reject(new Error(result.errors[0].message));
          return;
        }
        resolve(result.data);
      },
      error: reject,
    });
  });
}

function isGamesRows(rows) {
  return Array.isArray(rows) && rows.length > 0 && (
    "player_acpl" in rows[0] ||
    "player_rating" in rows[0] ||
    "opponent_acpl" in rows[0]
  );
}

function isMovesRows(rows) {
  return Array.isArray(rows) && rows.length > 0 &&
    "ply" in rows[0] &&
    "san" in rows[0] &&
    "category" in rows[0];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return String(v ?? "").trim().toLowerCase() === "true" ||
         String(v ?? "").trim() === "1";
}

function playerResult(result, playerColor) {
  const r = String(result ?? "").trim();
  const c = String(playerColor ?? "").toLowerCase();

  if (r === "1/2-1/2") return "draw";
  if ((r === "1-0" && c === "white") || (r === "0-1" && c === "black")) {
    return "win";
  }
  if ((r === "1-0" && c === "black") || (r === "0-1" && c === "white")) {
    return "loss";
  }
  return "unknown";
}

function normalizeGames(rows) {
  return rows
    .filter((r) => r && r.date != null && r.game_number != null)
    .map((r) => ({
      gameNumber: num(r.game_number),
      date: String(r.date),
      white: String(r.white ?? ""),
      black: String(r.black ?? ""),
      resultRaw: String(r.result ?? ""),
      playerColor: String(r.player_color ?? ""),
      result: playerResult(r.result, r.player_color),
      playerRating: num(r.player_rating),
      opponentRating: num(r.opponent_rating),
      playerAcpl: num(r.player_acpl),
      opponentAcpl: num(r.opponent_acpl),
      playerRawBlunders: num(r.player_raw_blunders),
      opponentRawBlunders: num(r.opponent_raw_blunders),
      playerPracticalBlunders: num(r.player_practical_blunders),
      opponentPracticalBlunders: num(r.opponent_practical_blunders),
      playerConversionErrors: num(r.player_conversion_errors),
      opponentConversionErrors: num(r.opponent_conversion_errors),
      playerMissedOpportunities: num(r.player_missed_opportunities),
      opponentMissedOpportunities: num(r.opponent_missed_opportunities),
      playerMissedMates: num(r.player_missed_mates),
      opponentMissedMates: num(r.opponent_missed_mates),
      playerMistakes: num(r.player_mistakes),
      opponentMistakes: num(r.opponent_mistakes),
      playerInaccuracies: num(r.player_inaccuracies),
      opponentInaccuracies: num(r.opponent_inaccuracies),
      playerMoves: num(r.player_moves),
      opponentMoves: num(r.opponent_moves),
      totalPlies: num(r.total_plies),
      fullMoves: num(r.full_moves),
    }))
    .sort((a, b) => a.gameNumber - b.gameNumber);
}

function normalizeMoves(rows) {
  return rows
    .filter((r) => r && r.game_number != null && r.ply != null)
    .map((r) => ({
      gameNumber: num(r.game_number),
      date: String(r.date ?? ""),
      white: String(r.white ?? ""),
      black: String(r.black ?? ""),
      result: String(r.result ?? ""),
      ply: num(r.ply),
      fullMove: num(r.full_move),
      color: String(r.color ?? ""),
      san: String(r.san ?? ""),
      isTargetPlayer: bool(r.is_target_player),
      evalBeforeCp: num(r.eval_before_cp),
      bestAfterCp: num(r.best_after_cp),
      playedAfterCp: num(r.played_after_cp),
      rawLossCp: num(r.raw_loss_cp),
      beforeIsMate: bool(r.before_is_mate),
      beforeMateIn: r.before_mate_in,
      bestAfterIsMate: bool(r.best_after_is_mate),
      bestMateIn: r.best_mate_in,
      playedAfterIsMate: bool(r.played_after_is_mate),
      playedMateIn: r.played_mate_in,
      category: String(r.category ?? "ok").toLowerCase(),
      practicalBlunder: bool(r.practical_blunder),
      conversionError: bool(r.conversion_error),
      missedOpportunity: bool(r.missed_opportunity),
      missedMate: bool(r.missed_mate),
    }))
    .sort((a, b) => a.gameNumber - b.gameNumber || a.ply - b.ply);
}

function rolling(values, window = 10) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const weight = index - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function quartiles(values) {
  return {
    q1: percentile(values, 0.25),
    median: percentile(values, 0.5),
    q3: percentile(values, 0.75),
  };
}

function quartileAverages(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return { bottom25Avg: 0, top25Avg: 0 };

  const quartileCount = Math.max(1, Math.ceil(sorted.length * 0.25));
  const bottom = sorted.slice(0, quartileCount);
  const top = sorted.slice(-quartileCount);

  return {
    bottom25Avg: bottom.reduce((a, b) => a + b, 0) / bottom.length,
    top25Avg: top.reduce((a, b) => a + b, 0) / top.length,
  };
}

function formatDate(date) {
  if (!date) return "";
  const d = new Date(date.replaceAll(".", "-"));
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString();
}

function resultClass(result) {
  return result === "win"
    ? "win"
    : result === "loss"
      ? "loss"
      : result === "draw"
        ? "draw"
        : "";
}

function Metric({ icon: Icon, label, value, sub }) {
  return (
    <div className="metric">
      <div className="metric-icon"><Icon size={18} /></div>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
        {sub && <div className="metric-sub">{sub}</div>}
      </div>
    </div>
  );
}


function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload;
  const displayLabel = point?.range
    ? `Games ${point.range}${point.gamesInBucket ? ` (${point.gamesInBucket} games)` : ""}`
    : label;

  return (
    <div className="custom-chart-tooltip">
      <div className="custom-chart-tooltip-label">{displayLabel}</div>
      {payload.map((entry) => (
        <div className="custom-chart-tooltip-row" key={`${entry.dataKey}-${entry.name}`}>
          <span>{entry.name || entry.dataKey}</span>
          <strong>
            {typeof entry.value === "number"
              ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 3 })
              : entry.value}
            {String(entry.dataKey).toLowerCase().includes("pct") ? "%" : ""}
          </strong>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <section className="card chart-card">
      <h2>{title}</h2>
      <div className="chart">{children}</div>
    </section>
  );
}


function ChessBoard({ fen, lastMoveSquares = [], orientation = "white" }) {
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


function EvalBar({ evaluation, orientation = "white" }) {
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

function MoveExplorer({ moves, playerColor = "white" }) {
  const [selectedPly, setSelectedPly] = useState(0);
  const moveTableRef = useRef(null);
  const activeMoveRef = useRef(null);

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

  if (!moves.length) {
    return <div className="empty-small">No move data loaded for this game.</div>;
  }

  const maxPly = Math.max(0, positions.length - 1);
  const safePly = Math.min(selectedPly, maxPly);
  const current = positions[safePly];
  const currentMove = current?.move;

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

      // before_* is from the side-to-move POV. At the initial position that is White,
      // so it is already White POV.
      return { cp, mateIn, isMate };
    }

    if (nextMove) {
      const sideToMove = String(nextMove.color ?? "").toLowerCase();
      const rawCp = Number(nextMove.evalBeforeCp ?? nextMove.eval_before_cp ?? 0);
      const rawMateIn = Number(nextMove.beforeMateIn ?? nextMove.before_mate_in ?? 0);

      // Normalize side-to-move evaluation to White POV.
      const sign = sideToMove === "black" ? -1 : 1;
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

      // Preserve the sign convention already established for played-after values.
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

  useEffect(() => {
    const container = moveTableRef.current;
    const row = activeMoveRef.current;
    if (!container || !row) return;

    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (rowTop < viewTop) {
      container.scrollTop = rowTop;
    } else if (rowBottom > viewBottom) {
      container.scrollTop = rowBottom - container.clientHeight;
    }
  }, [safePly]);

  return (
    <div className="explorer">
      <div className="board-panel">
        <div className="board-with-eval">
          <EvalBar evaluation={boardEvaluation} orientation={String(playerColor).toLowerCase()} />
          <ChessBoard
            fen={current.fen}
            lastMoveSquares={[current?.from, current?.to].filter(Boolean)}
            orientation={String(playerColor).toLowerCase()}
          />
        </div>

        <div className="board-controls">
          <button className="nav-button" onClick={() => setSelectedPly(0)}>⏮</button>
          <button className="nav-button" onClick={() => setSelectedPly(Math.max(0, safePly - 1))}>◀</button>
          <div className="ply-label">
            {safePly === 0
              ? "Starting position"
              : `Ply ${currentMove?.ply}: ${currentMove?.fullMove}${currentMove?.color?.toLowerCase() === "white" ? "." : "..."} ${currentMove?.san}`}
          </div>
          <button className="nav-button" onClick={() => setSelectedPly(Math.min(maxPly, safePly + 1))}>▶</button>
          <button className="nav-button" onClick={() => setSelectedPly(maxPly)}>⏭</button>
        </div>
        <div className="keyboard-hint">← / → step through moves</div>

      </div>

      <div className="move-table-wrap" ref={moveTableRef}>
        <table className="move-table">
          <thead>
            <tr>
              <th>Move #</th>
              <th>Move</th>
              <th>Side</th>
              <th>Category</th>
              <th>Loss (cp)</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((m, i) => (
              <tr
                key={`${m.gameNumber}-${m.ply}`}
                ref={Number(currentMove?.ply) === Number(m.ply) ? activeMoveRef : null}
                className={Number(currentMove?.ply) === Number(m.ply) ? "selected-move" : ""}
                onClick={() => {
                  const positionIndex = positions.findIndex((p) => p.ply === m.ply);
                  if (positionIndex >= 0) setSelectedPly(positionIndex);
                }}
              >
                <td>{m.fullMove}</td>
                <td className="san">{m.san}</td>
                <td>{m.isTargetPlayer ? "You" : "Opp"}</td>
                <td><span className={`category ${m.category}`}>{m.category}</span></td>
                <td>{m.rawLossCp.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GameRow({ game, moves, expanded, onToggle }) {
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

export default function App() {
  const [games, setGames] = useState([]);
  const [moves, setMoves] = useState([]);
  const [expandedGame, setExpandedGame] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [gamePage, setGamePage] = useState(1);
  const GAMES_PER_PAGE = 15;
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;

      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed.games)) setGames(parsed.games);
      if (Array.isArray(parsed.moves)) setMoves(parsed.moves);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!games.length && !moves.length) return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ games, moves }));
    } catch {
      // Still usable if browser storage quota is exceeded.
    }
  }, [games, moves]);

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    setError("");
    setStatus("Loading CSV files...");

    try {
      let nextGames = games;
      let nextMoves = moves;

      for (const file of files) {
        const rows = await parseCSV(file);

        if (isMovesRows(rows)) {
          nextMoves = normalizeMoves(rows);
        } else if (isGamesRows(rows)) {
          nextGames = normalizeGames(rows);
        } else {
          throw new Error(
            `${file.name} does not match the expected games or moves schema.`
          );
        }
      }

      setGames(nextGames);
      setMoves(nextMoves);
      setExpandedGame(null);
      setStatus("");

      if (!nextGames.length && nextMoves.length) {
        setError("Moves loaded, but no games CSV is loaded yet.");
      }
    } catch (e) {
      setError(e.message || "Could not load CSV.");
      setStatus("");
    }
  }

  function clearData() {
    localStorage.removeItem(STORAGE_KEY);
    setGames([]);
    setMoves([]);
    setExpandedGame(null);
    setStatus("Dashboard cleared.");
    setError("");
  }

  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();

    return games
      .filter((g) => {
        const resultOK = filter === "all" || g.result === filter;
        const opponent =
          g.playerColor.toLowerCase() === "white" ? g.black : g.white;

        const searchOK =
          !q ||
          opponent.toLowerCase().includes(q) ||
          String(g.gameNumber).includes(q) ||
          g.date.toLowerCase().includes(q);

        return resultOK && searchOK;
      })
      .sort((a, b) => b.gameNumber - a.gameNumber);
  }, [games, filter, search]);

  const totalGamePages = Math.max(
    1,
    Math.ceil(filteredGames.length / GAMES_PER_PAGE)
  );

  const pagedGames = useMemo(() => {
    const start = (gamePage - 1) * GAMES_PER_PAGE;
    return filteredGames.slice(start, start + GAMES_PER_PAGE);
  }, [filteredGames, gamePage]);

  useEffect(() => {
    setGamePage((page) => Math.min(Math.max(1, page), totalGamePages));
  }, [totalGamePages]);

  const chartData = useMemo(() => {
    const ordered = [...games].sort((a, b) => a.gameNumber - b.gameNumber);
    if (!ordered.length) return [];

    // Target roughly 20 plotted points regardless of dataset size.
    // Example: 1,000 games -> 50 games per plotted point.
    const bucketSize = Math.max(1, Math.ceil(ordered.length / 20));
    const points = [];

    for (let start = 0; start < ordered.length; start += bucketSize) {
      const bucket = ordered.slice(start, start + bucketSize);
      const first = bucket[0];
      const last = bucket[bucket.length - 1];

      const average = (key) =>
        bucket.reduce((sum, game) => sum + num(game[key]), 0) / bucket.length;

      const playerAcpls = bucket.map((g) => g.playerAcpl);
      const opponentAcpls = bucket.map((g) => g.opponentAcpl);
      const playerPractical = bucket.map((g) => g.playerPracticalBlunders);

      const playerAcplQuartiles = quartiles(playerAcpls);
      const practicalQuartileAverages = quartileAverages(playerPractical);

      points.push({
        game: last.gameNumber,
        range: `${first.gameNumber}-${last.gameNumber}`,
        gamesInBucket: bucket.length,

        rating: Number(average("playerRating").toFixed(1)),

        acplAvg: Number(average("playerAcpl").toFixed(2)),
        acplQ1: Number(playerAcplQuartiles.q1.toFixed(2)),
        acplMedian: Number(playerAcplQuartiles.median.toFixed(2)),
        acplQ3: Number(playerAcplQuartiles.q3.toFixed(2)),

        blunderAvg: Number(
          (playerPractical.reduce((a, b) => a + b, 0) / playerPractical.length).toFixed(3)
        ),
        blunderBottom25Avg: Number(
          practicalQuartileAverages.bottom25Avg.toFixed(3)
        ),
        blunderTop25Avg: Number(
          practicalQuartileAverages.top25Avg.toFixed(3)
        ),
        zeroPracticalBlunderPct: Number(
          (
            100 *
            bucket.filter((g) => g.playerPracticalBlunders === 0).length /
            bucket.length
          ).toFixed(1)
        ),
      });
    }

    return points;
  }, [games]);

  const blunderYAxisMax = useMemo(() => {
    const values = chartData.flatMap((point) => [
      point.blunderAvg,
      point.blunderTop25Avg,
      point.blunderBottom25Avg,
    ]).filter(Number.isFinite);

    if (!values.length) return 1;

    const maxValue = Math.max(...values);
    const padded = maxValue * 1.08;
    return Math.max(0.5, Math.ceil(padded * 4) / 4);
  }, [chartData]);

  const stats = useMemo(() => {
    const wins = games.filter((g) => g.result === "win").length;
    const losses = games.filter((g) => g.result === "loss").length;
    const draws = games.filter((g) => g.result === "draw").length;

    const latest = [...games].sort(
      (a, b) => b.gameNumber - a.gameNumber
    )[0];

    const recent = [...games]
      .sort((a, b) => b.gameNumber - a.gameNumber)
      .slice(0, 10);

    return {
      wins,
      losses,
      draws,
      latestRating: latest?.playerRating ?? 0,
      recentAcpl: recent.length
        ? recent.reduce((s, g) => s + g.playerAcpl, 0) / recent.length
        : 0,
      recentBlunders: recent.length
        ? recent.reduce((s, g) => s + g.playerPracticalBlunders, 0) /
          recent.length
        : 0,
    };
  }, [games]);

  const movesByGame = useMemo(() => {
    const map = new Map();

    for (const move of moves) {
      if (!map.has(move.gameNumber)) map.set(move.gameNumber, []);
      map.get(move.gameNumber).push(move);
    }

    return map;
  }, [moves]);

  const distribution = useMemo(() => ({
    acpl: quartiles(games.map((g) => g.playerAcpl)),
  }), [games]);

  return (
    <div className="app">
      <style>{`
        * { box-sizing: border-box; }

        html, body, #root {
          margin: 0 !important;
          padding: 0 !important;
          width: 100% !important;
          min-width: 100% !important;
          min-height: 100% !important;
          border: 0 !important;
          outline: 0 !important;
          box-shadow: none !important;
          background: #0d1117 !important;
        }

        #root {
          max-width: none !important;
        }

        body {
          margin: 0;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system,
            BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #0d1117;
          color: #e6edf3;
        }

        button, input, select {
          font: inherit;
          color: #f0f6fc;
        }


        h1, h2, h3, h4, h5, h6,
        .card h1, .card h2, .card h3,
        .chart-card h2,
        .section-title,
        .metric-label,
        .metric-value {
          color: #f0f6fc !important;
        }

        .chart svg text {
          fill: #c9d1d9 !important;
          font-size: 11px !important;
        }

        .recharts-tooltip-wrapper,
        .recharts-tooltip-wrapper * {
          color: #f0f6fc !important;
        }

        .recharts-default-tooltip {
          background: #161b22 !important;
          background-color: #161b22 !important;
          border: 1px solid #30363d !important;
          border-radius: 8px !important;
          color: #f0f6fc !important;
          box-shadow: 0 8px 24px rgba(0,0,0,.35);
        }

        .recharts-tooltip-wrapper {
          pointer-events: none !important;
          z-index: 20 !important;
        }

        .recharts-default-tooltip .recharts-tooltip-label,
        .recharts-default-tooltip .recharts-tooltip-item,
        .recharts-default-tooltip .recharts-tooltip-item-name,
        .recharts-default-tooltip .recharts-tooltip-item-value {
          color: #f0f6fc !important;
        }

        .custom-chart-tooltip {
          min-width: 150px;
          padding: 9px 11px;
          border: 1px solid #30363d;
          border-radius: 8px;
          background: #161b22;
          color: #f0f6fc;
          box-shadow: 0 8px 24px rgba(0,0,0,.35);
          font-size: 12px;
          white-space: nowrap;
        }

        .custom-chart-tooltip-label {
          margin-bottom: 6px;
          color: #8b949e;
          font-size: 11px;
        }

        .custom-chart-tooltip-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          line-height: 1.55;
          color: #c9d1d9;
        }

        .custom-chart-tooltip-row strong {
          color: #f0f6fc;
          font-weight: 600;
        }

        .app {
          min-height: 100vh;
          width: 100%;
          margin: 0;
          padding: 0;
          border: 0;
          outline: 0;
          box-shadow: none;
          background: #0d1117;
        }

        .header {
          padding: 28px max(20px, calc((100vw - 1450px)/2));
          border-bottom: 1px solid #21262d;
          background: #11161d;
        }

        .header-inner {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 20px;
        }

        h1 {
          margin: 0 0 5px;
          font-size: 28px;
          letter-spacing: -0.5px;
        }

        .subtitle {
          color: #8b949e;
          font-size: 14px;
        }

        .actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: none;
          background: #21262d;
          color: #e6edf3;
          border-radius: 7px;
          padding: 9px 13px;
          cursor: pointer;
        }

        .button:hover { background: #30363d; }

        .button.primary {
          background: #238636;
          border-color: #2ea043;
        }

        .button.primary:hover { background: #2ea043; }

        .main {
          max-width: 1450px;
          margin: 0 auto;
          padding: 24px 20px 60px;
        }

        .notice {
          margin-bottom: 18px;
          padding: 12px 14px;
          border-radius: 7px;
          border: 1px solid #30363d;
          background: #161b22;
          color: #8b949e;
        }

        .notice.error {
          border-color: #f85149;
          color: #ff7b72;
        }

        .metrics {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 14px;
          margin-bottom: 18px;
        }

        .metric, .card {
          background: #161b22;
          border: 1px solid #21262d;
          border-radius: 9px;
        }

        .metric {
          padding: 17px;
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .metric-icon {
          width: 34px;
          height: 34px;
          border-radius: 7px;
          background: #21262d;
          display: grid;
          place-items: center;
          color: #8b949e;
        }

        .metric-label {
          color: #8b949e;
          font-size: 12px;
        }

        .metric-value {
          font-size: 23px;
          font-weight: 700;
          margin-top: 2px;
        }

        .metric-sub {
          color: #6e7681;
          font-size: 11px;
          margin-top: 2px;
        }

        .chart-note {
          margin: 0 0 12px;
          color: #8b949e;
          font-size: 12px;
        }

        .charts {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 18px;
          margin-bottom: 18px;
        }

        .chart-card {
          padding: 18px;
          min-width: 0;
        }

        h2 {
          margin: 0 0 15px;
          font-size: 16px;
        }

        .chart {
          width: 100%;
          height: 285px;
          overflow: visible;
          position: relative;
        }

        .toolbar {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
          margin-bottom: 12px;
        }

        .search {
          flex: 1;
          min-width: 220px;
          background: #0d1117;
          color: #e6edf3;
          border: 1px solid #30363d;
          border-radius: 7px;
          padding: 9px 11px;
          outline: none;
        }

        .filter {
          background: #0d1117;
          color: #e6edf3;
          border: 1px solid #30363d;
          border-radius: 7px;
          padding: 9px 11px;
        }

        .table-card { overflow: hidden; }

        .table-header {
          padding: 18px 18px 8px;
        }

        .table-wrap { overflow-x: auto; }

        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .game-table {
          table-layout: fixed;
          width: 100%;
          min-width: 870px;
        }

        .game-table th,
        .game-table td {
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .game-table .opponent-cell {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        th {
          color: #8b949e;
          font-weight: 600;
          text-align: left;
          background: #11161d;
        }

        th, td {
          padding: 10px 11px;
          border-top: 1px solid #21262d;
          white-space: nowrap;
        }

        .game-row { cursor: pointer; }

        .game-row:hover { background: #1c2128; }

        .game-row td:first-child {
          padding-right: 0;
        }

        .result {
          font-size: 11px;
          font-weight: 700;
          border-radius: 999px;
          padding: 3px 7px;
        }

        .result.win {
          color: #3fb950;
          background: #12261a;
        }

        .result.loss {
          color: #f85149;
          background: #2b1717;
        }

        .result.draw {
          color: #d29922;
          background: #2b2414;
        }

        .expanded-row td {
          padding: 0;
          background: #0f141a;
        }

        .game-detail {
          padding: 18px;
          min-width: 0;
          overflow: hidden;
        }

        .detail-stats {
          display: flex;
          flex-wrap: wrap;
          gap: 18px;
          color: #8b949e;
          margin-bottom: 15px;
        }

        .detail-stats b { color: #e6edf3; }

        .move-table { font-size: 12px; }

        .move-table th, .move-table td {
          padding: 7px 9px;
        }

        .san {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e6edf3;
        }

        .category {
          font-size: 10px;
          border-radius: 4px;
          padding: 3px 5px;
          background: #21262d;
        }

        .category.blunder,
        .category.missed_mate { color: #ff7b72; }

        .category.mistake { color: #d29922; }

        .category.inaccuracy { color: #79c0ff; }

        .empty {
          text-align: center;
          padding: 75px 20px;
          color: #8b949e;
        }

        .empty h2 { color: #e6edf3; }

        .empty-small {
          padding: 15px 0;
          color: #8b949e;
        }

        .footer-note {
          margin-top: 12px;
          color: #6e7681;
          font-size: 12px;
        }

        .quartile-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 18px;
          margin-bottom: 18px;
        }

        .quartile-card { padding: 18px; }

        .quartile-values {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
        }

        .quartile-values span {
          background: #0d1117;
          border: 1px solid #21262d;
          border-radius: 7px;
          padding: 10px;
          font-size: 18px;
          font-weight: 700;
        }

        .quartile-values b {
          display: block;
          color: #8b949e;
          font-size: 11px;
          margin-bottom: 3px;
        }

        .explorer {
          display: grid;
          grid-template-columns: minmax(420px, 560px) minmax(0, 1fr);
          gap: 22px;
          align-items: start;
        }

        .board-panel {
          position: sticky;
          top: 16px;
          min-width: 0;
        }

        .board-with-eval {
          display: grid;
          grid-template-columns: 26px minmax(0, 1fr);
          gap: 8px;
          align-items: stretch;
          width: 100%;
          max-width: 594px;
          margin: 0 auto;
        }

        .eval-bar {
          position: relative;
          width: 26px;
          height: 100%;
          min-height: 320px;
          overflow: hidden;
          border: 1px solid #30363d;
          border-radius: 6px;
          background: #11161d;
          display: flex;
          flex-direction: column;
        }

        .eval-black {
          width: 100%;
          background: #1f2328;
          transition: height 140ms ease;
        }

        .eval-white {
          width: 100%;
          background: #f6f8fa;
          transition: height 140ms ease;
        }

        .eval-score {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          font-size: 10px;
          font-weight: 600;
          line-height: 1;
          white-space: nowrap;
          pointer-events: none;
          z-index: 3;
        }

        .eval-score.score-bottom {
          bottom: 7px;
        }

        .eval-score.score-top {
          top: 7px;
        }

        .eval-score.white-winning {
          color: #111;
          text-shadow: none;
        }

        .eval-score.black-winning {
          color: #fff;
          text-shadow: 0 1px 2px rgba(0,0,0,.45);
        }

        .board-shell {
          width: 100%;
          max-width: 560px;
          margin: 0 auto;
        }

        .board {
          width: 100%;
          aspect-ratio: 1 / 1;
          display: grid;
          grid-template-columns: repeat(8, minmax(0, 1fr));
          grid-template-rows: repeat(8, minmax(0, 1fr));
          border: 2px solid #30363d;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 10px 30px rgba(0,0,0,.25);
        }

        .square {
          position: relative;
          min-width: 0;
          min-height: 0;
          display: grid;
          place-items: center;
          overflow: hidden;
          line-height: 1;
          user-select: none;
        }

        .square.light { background: #f4f4ed; }
        .square.dark { background: #769656; }

        .square.last-move::after {
          content: "";
          position: absolute;
          inset: 0;
          background: rgba(255, 215, 0, 0.28);
          box-shadow: inset 0 0 0 3px rgba(255, 215, 0, 0.72);
          pointer-events: none;
          z-index: 1;
        }

        .piece {
          width: 86%;
          height: 86%;
          object-fit: contain;
          user-select: none;
          pointer-events: none;
          position: relative;
          z-index: 2;
        }

        .rank-label,
        .file-label {
          position: absolute;
          z-index: 2;
          font-size: 10px;
          font-weight: 700;
          opacity: .65;
          color: #f8fafc;
          text-shadow: 0 1px 2px rgba(0,0,0,.8);
          pointer-events: none;
        }

        .rank-label {
          top: 3px;
          left: 4px;
        }

        .file-label {
          right: 4px;
          bottom: 3px;
        }

        .board-controls {
          width: 100%;
          max-width: 560px;
          margin: 10px auto 0;
          display: grid;
          grid-template-columns: 42px 42px minmax(0, 1fr) 42px 42px;
          align-items: center;
          gap: 7px;
        }

        .nav-button {
          height: 38px;
          border: 1px solid #30363d;
          background: #21262d;
          color: #e6edf3;
          border-radius: 7px;
          cursor: pointer;
        }

        .nav-button:hover { background: #30363d; }

        .ply-label {
          min-width: 0;
          text-align: center;
          color: #c9d1d9;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .keyboard-hint {
          width: 100%;
          max-width: 560px;
          margin: 6px auto 0;
          text-align: center;
          color: #6e7681;
          font-size: 11px;
        }

        .position-stats {
          width: 100%;
          max-width: 560px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          color: #8b949e;
          font-size: 12px;
          padding-top: 10px;
        }

        .position-stats span {
          min-width: 0;
          background: #11161d;
          border: 1px solid #21262d;
          border-radius: 6px;
          padding: 8px 10px;
        }

        .position-stats b { color: #e6edf3; }

        .move-table-wrap {
          min-width: 0;
          max-height: 650px;
          overflow: auto;
          border: 1px solid #21262d;
          border-radius: 8px;
          background: #11161d;
          scrollbar-width: none;
          -ms-overflow-style: none;
        }

        .move-table-wrap::-webkit-scrollbar {
          display: none;
        }

        .move-table {
          table-layout: auto;
          min-width: 0;
          width: 100%;
        }

        .move-table th,
        .move-table td {
          height: 36px;
          line-height: 1.2;
          vertical-align: middle;
        }

        .move-table th:nth-child(1),
        .move-table td:nth-child(1) { width: 52px; }

        .move-table th:nth-child(3),
        .move-table td:nth-child(3) { width: 62px; }

        .move-table th:nth-child(4),
        .move-table td:nth-child(4) { width: 105px; }

        .move-table th:nth-child(5),
        .move-table td:nth-child(5) { width: 78px; }

        .move-table tbody tr { cursor: pointer; }
        .move-table tbody tr:hover { background: #1c2128; }
        .move-table tbody tr.selected-move,
        .move-table tbody tr.selected-move td {
          background: rgba(88, 166, 255, 0.16) !important;
        }

        .move-table tbody tr.selected-move td:first-child {
          box-shadow: inset 3px 0 0 #58a6ff;
        }

        .search-input,
        .filter-select {
          font-size: 12px;
        }

        .game-pagination {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          margin-top: 14px;
          color: #c9d1d9;
          font-size: 13px;
        }

        .page-button {
          min-width: 38px;
          width: 38px;
          height: 34px;
          padding: 0;
          display: grid;
          place-items: center;
          font-size: 20px;
          border: 1px solid #30363d;
          border-radius: 7px;
          background: #21262d;
          color: #f0f6fc;
          cursor: pointer;
        }

        .page-button:hover:not(:disabled) {
          background: #30363d;
        }

        .page-button:disabled {
          opacity: .4;
          cursor: default;
        }

        @media (max-width: 1050px) {
          .metrics { grid-template-columns: repeat(3, 1fr); }
          .charts { grid-template-columns: 1fr; }
          .quartile-grid { grid-template-columns: 1fr; }
          .explorer { grid-template-columns: 1fr; }
          .board-panel { position: static; }
          .board-shell { max-width: 520px; }
          .move-table-wrap { max-height: 500px; }
        }

        @media (max-width: 700px) {
          .header-inner {
            align-items: flex-start;
            flex-direction: column;
          }

          .metrics { grid-template-columns: 1fr 1fr; }
        }
      `}</style>

      <header className="header">
        <div className="header-inner">
          <div>
            <h1>ProtoX09 Chess Dashboard</h1>
            <div className="subtitle">
              Game-level performance + move-level analysis
            </div>
          </div>

          <div className="actions">
            <label className="button primary">
              <Upload size={16} />
              Load CSVs
              <input
                type="file"
                accept=".csv"
                multiple
                hidden
                onChange={(e) => loadFiles(e.target.files)}
              />
            </label>

            <button className="button" onClick={clearData}>
              <RefreshCw size={16} />
              Clear
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        {status && <div className="notice">{status}</div>}
        {error && <div className="notice error">{error}</div>}

        {!games.length ? (
          <section className="card empty">
            <Database size={42} />
            <h2>Load your chess analysis CSVs</h2>
            <p>
              Select your <b>games_*.csv</b> and <b>moves_*.csv</b> together.
              The dashboard detects them automatically from their columns.
            </p>
            <p>
              The games CSV supplies ratings, ACPL, blunders, mistakes,
              inaccuracies and game-level stats. The moves CSV supplies
              move-by-move categories.
            </p>

            <label className="button primary">
              <Upload size={16} />
              Choose CSV files
              <input
                type="file"
                accept=".csv"
                multiple
                hidden
                onChange={(e) => loadFiles(e.target.files)}
              />
            </label>
          </section>
        ) : (
          <>
            <section className="metrics">
              <Metric
                icon={Trophy}
                label="Current rating"
                value={stats.latestRating}
                sub={`${games.length} analyzed games`}
              />

              <Metric
                icon={Target}
                label="Record"
                value={`${stats.wins}-${stats.losses}-${stats.draws}`}
                sub={`${games.length ? ((stats.wins / games.length) * 100).toFixed(1) : 0}% wins`}
              />

              <Metric
                icon={Activity}
                label="ACPL · last 10"
                value={stats.recentAcpl.toFixed(1)}
                sub="lower is better"
              />

              <Metric
                icon={AlertTriangle}
                label="Blunders · last 10"
                value={stats.recentBlunders.toFixed(2)}
                sub="per game"
              />

              <Metric
                icon={Database}
                label="Move records"
                value={`${moves.length.toLocaleString()} moves`}
                sub={`from ${games.length.toLocaleString()} games`}
              />
            </section>


            <div className="chart-note">
              Each graph is compressed to about 20 points. With {games.length} games,
              each point represents about {Math.max(1, Math.ceil(games.length / 20))} games.
            </div>

            <div className="charts">
              <ChartCard title="Rating over games">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                      reverseDirection={{ x: true, y: false }}
                      offset={14}
                      wrapperStyle={{ pointerEvents: "none", zIndex: 20 }}
                    />
                    <Line
                      name="Average rating"
                      type="monotone"
                      dataKey="rating"
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="ACPL per Game">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, "auto"]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                      reverseDirection={{ x: true, y: false }}
                      offset={14}
                      wrapperStyle={{ pointerEvents: "none", zIndex: 20 }}
                    />
                    <Line
                      name="Average ACPL"
                      type="monotone"
                      dataKey="acplAvg"
                      dot={false}
                      strokeWidth={2.5}
                    />
                    <Line
                      name="Upper quartile (Q3)"
                      type="monotone"
                      dataKey="acplQ3"
                      dot={false}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                    <Line
                      name="Lower quartile (Q1)"
                      type="monotone"
                      dataKey="acplQ1"
                      dot={false}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="% of games without blunders">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                      reverseDirection={{ x: true, y: false }}
                      offset={14}
                      wrapperStyle={{ pointerEvents: "none", zIndex: 20 }}
                    />
                    <Line
                      name="Zero blunders"
                      type="monotone"
                      dataKey="zeroPracticalBlunderPct"
                      dot={false}
                      strokeWidth={2.5}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Average Blunders per Game">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="game"
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <YAxis
                      domain={[0, blunderYAxisMax]}
                      allowDecimals
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                      reverseDirection={{ x: true, y: false }}
                      offset={14}
                      wrapperStyle={{ pointerEvents: "none", zIndex: 20 }}
                    />
                    <Line
                      name="Average"
                      type="monotone"
                      dataKey="blunderAvg"
                      dot={false}
                      stroke="#3fb950"
                      strokeWidth={2.5}
                    />
                    <Line
                      name="Top 25% avg"
                      type="monotone"
                      dataKey="blunderTop25Avg"
                      dot={false}
                      stroke="#ffa657"
                      strokeWidth={1.7}
                      strokeDasharray="5 4"
                    />
                    <Line
                      name="Bottom 25% avg"
                      type="monotone"
                      dataKey="blunderBottom25Avg"
                      dot={false}
                      stroke="#79c0ff"
                      strokeWidth={1.7}
                      strokeDasharray="5 4"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <section className="card table-card">
              <div className="table-header">
                <h2>Game history</h2>

                <div className="toolbar">
                  <input
                    className="search"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setGamePage(1); }}
                    placeholder="Search opponent, game number, or date..."
                  />

                  <select
                    className="filter"
                    value={filter}
                    onChange={(e) => { setFilter(e.target.value); setGamePage(1); }}
                  >
                    <option value="all">All results</option>
                    <option value="win">Wins</option>
                    <option value="loss">Losses</option>
                    <option value="draw">Draws</option>
                  </select>
                </div>

                <div className="footer-note">
                  Showing {filteredGames.length ? ((gamePage - 1) * GAMES_PER_PAGE + 1) : 0}
                  –{Math.min(gamePage * GAMES_PER_PAGE, filteredGames.length)} of{" "}
                  {filteredGames.length} matching games.
                  Click a row to inspect its move records.
                </div>
              </div>

              <div className="table-wrap">
                <table className="game-table">
                  <colgroup>
                    <col style={{ width: "34px" }} />
                    <col style={{ width: "88px" }} />
                    <col style={{ width: "150px" }} />
                    <col style={{ width: "72px" }} />
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
                    {pagedGames.map((game) => (
                      <GameRow
                        key={game.gameNumber}
                        game={game}
                        moves={movesByGame.get(game.gameNumber) || []}
                        expanded={expandedGame === game.gameNumber}
                        onToggle={() =>
                          setExpandedGame(
                            expandedGame === game.gameNumber
                              ? null
                              : game.gameNumber
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="game-pagination">
                <button
                  className="page-button"
                  disabled={gamePage <= 1}
                  onClick={() => {
                    setExpandedGame(null);
                    setGamePage((page) => Math.max(1, page - 1));
                  }}
                >
                  ‹
                </button>

                <span>
                  Page {gamePage} of {totalGamePages}
                </span>

                <button
                  className="page-button"
                  disabled={gamePage >= totalGamePages}
                  onClick={() => {
                    setExpandedGame(null);
                    setGamePage((page) => Math.min(totalGamePages, page + 1));
                  }}
                >
                  ›
                </button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
