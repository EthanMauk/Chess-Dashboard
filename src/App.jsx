import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Upload,
  RefreshCw,
  Database,
  Trophy,
  Target,
  AlertTriangle,
  Activity,
} from "lucide-react";

import Metric from "./components/Metric";
import ChartCard, { ChartTooltip } from "./components/ChartCard";
import GameRow from "./components/GameRow";
import {
  parseCSV,
  isGamesRows,
  isMovesRows,
  normalizeGames,
  normalizeMoves,
  num,
} from "./utils/chessData";
import { quartiles, quartileAverages } from "./utils/statistics";
import { browserSync, loadDashboardRows } from "./browser/analyzer";
import { hydrateProfileFromRemote, uploadProfileSnapshot } from "./browser/remotePersistence";
import "./styles.css";

const USERNAME_STORAGE_KEY = "chess-dashboard-username";
const TIME_CLASS_STORAGE_KEY = "chess-dashboard-time-class";
const ENGINE_NODES_STORAGE_KEY = "chess-dashboard-browser-nodes";

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
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem(USERNAME_STORAGE_KEY)?.trim() || "ProtoX09";
    } catch {
      return "ProtoX09";
    }
  });
  const [timeClass, setTimeClass] = useState(() => {
    try {
      const saved = localStorage.getItem(TIME_CLASS_STORAGE_KEY);
      return saved === "blitz" ? "blitz" : "rapid";
    } catch {
      return "rapid";
    }
  });
  const [engineNodes, setEngineNodes] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(ENGINE_NODES_STORAGE_KEY));
      return [5000, 12000, 30000].includes(saved) ? saved : 12000;
    } catch {
      return 12000;
    }
  });
  const [syncing, setSyncing] = useState(false);
  const [syncJob, setSyncJob] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem(USERNAME_STORAGE_KEY, username);
    } catch {
      // Local storage is optional; the dashboard still works without it.
    }
  }, [username]);

  useEffect(() => {
    try {
      localStorage.setItem(TIME_CLASS_STORAGE_KEY, timeClass);
    } catch {
      // Local storage is optional.
    }
  }, [timeClass]);

  useEffect(() => {
    try {
      localStorage.setItem(ENGINE_NODES_STORAGE_KEY, String(engineNodes));
    } catch {
      // Local storage is optional.
    }
  }, [engineNodes]);

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

  async function loadPlayerData(player, selectedTimeClass = timeClass) {
    const data = await loadDashboardRows(player.trim().toLowerCase(), selectedTimeClass);
    const nextGames = normalizeGames(data.games || []);
    const nextMoves = normalizeMoves(data.moves || []);
    setGames(nextGames);
    setMoves(nextMoves);
    setExpandedGame(null);
    setGamePage(1);
    return nextGames.length;
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function autoLoadStoredData() {
      const player = username.trim().toLowerCase();
      if (!player) return;

      try {
        // Cross-device restore happens before the dashboard reads IndexedDB.
        // This prevents a fresh phone/browser from looking empty while archived
        // games already exist remotely.
        let remote = null;
        try {
          remote = await hydrateProfileFromRemote({
            username: player,
            timeClass,
            signal: controller.signal,
          });
        } catch (remoteError) {
          if (remoteError?.name === "AbortError") return;
          console.warn("Shared cache was not auto-hydrated:", remoteError);
        }

        const data = await loadDashboardRows(player, timeClass);
        if (cancelled) return;
        const nextGames = normalizeGames(data.games || []);
        setGames(nextGames);
        setMoves(normalizeMoves(data.moves || []));

        if (remote?.found) {
          setStatus(`Hydrated ${Number(remote.hydrated || remote.available || 0).toLocaleString()} archived ${timeClass} games from remote cache.`);
        }

        // Self-heal older local-only datasets. Opening the dashboard is enough
        // to archive any records that predate the shared-cache implementation.
        if (nextGames.length) {
          try {
            const archive = await uploadProfileSnapshot({
              username: player,
              timeClass,
              nodes: engineNodes,
            });
            if (!cancelled && Number(archive?.uploadedCount || 0) > 0) {
              setStatus(
                `Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games · archived ${Number(archive.uploadedCount).toLocaleString()} previously local-only game(s) remotely.`
              );
            }
          } catch (archiveError) {
            console.warn("Automatic archive repair was unavailable:", archiveError);
          }
        }
      } catch (e) {
        if (e?.name !== "AbortError") console.debug("Browser cache was not auto-loaded:", e);
      }
    }
    autoLoadStoredData();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  async function changeTimeClass(nextTimeClass) {
    if (syncing) return;
    setTimeClass(nextTimeClass);
    setError("");
    setStatus("");
    try {
      const player = username.trim().toLowerCase();
      const remote = await hydrateProfileFromRemote({
        username: player,
        timeClass: nextTimeClass,
      });
      const count = await loadPlayerData(username, nextTimeClass);
      if (!count) {
        setGames([]);
        setMoves([]);
      } else if (remote?.found) {
        setStatus(`Hydrated ${Number(remote.hydrated || remote.available || 0).toLocaleString()} archived ${nextTimeClass} games from remote cache.`);
      }
    } catch (e) {
      setGames([]);
      setMoves([]);
      setExpandedGame(null);
      setGamePage(1);
      setError(e?.message || "Could not restore the shared/browser cache.");
    }
  }

  async function syncPlayer(fullRescan = false) {
    const player = username.trim();
    if (!player || syncing) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setStatus("");
    setSyncing(true);
    setSyncJob({
      username: player,
      timeClass,
      fullRescan,
      phase: "starting",
      message: "Starting browser analysis...",
      current: 0,
      total: 0,
      percent: 0,
      archives: [],
      logs: [],
    });

    try {
      const data = await browserSync({
        username: player,
        timeClass,
        nodes: engineNodes,
        fullRescan,
        signal: controller.signal,
        onProgress: (progress) => {
          setSyncJob((prev) => ({
            ...(prev || {}),
            ...progress,
            username: player,
            timeClass,
            fullRescan,
          }));
        },
      });

      const nextGames = normalizeGames(data.games || []);
      const nextMoves = normalizeMoves(data.moves || []);
      setGames(nextGames);
      setMoves(nextMoves);
      setExpandedGame(null);
      setGamePage(1);

      const analyzedThisRun = Number(data.syncMeta?.analyzedGames || 0);
      if (analyzedThisRun > 0) {
        try {
          const archive = await uploadProfileSnapshot({
            username: player,
            timeClass,
            nodes: engineNodes,
          });
          setStatus(
            `Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games · archived ${Number(archive.recordCount || nextGames.length).toLocaleString()} games remotely.`
          );
        } catch (archiveError) {
          setStatus(`Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games from browser storage.`);
          setError(`Analysis succeeded, but remote archive failed: ${archiveError?.message || "unknown error"}`);
        }
      } else {
        const sharedThisRun = Number(data.syncMeta?.sharedGames || 0);
        if (sharedThisRun > 0) {
          setStatus(
            `Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games · reused ${sharedThisRun.toLocaleString()} game(s) from the shared analysis cache · no Stockfish re-analysis needed for those games.`
          );
        } else {
          setStatus(`Loaded ${nextGames.length.toLocaleString()} rated ${timeClass} games from browser storage.`);
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        try {
          const count = await loadPlayerData(player, timeClass);

          if (count > 0) {
            try {
              const archive = await uploadProfileSnapshot({
                username: player,
                timeClass,
                nodes: engineNodes,
              });
              setStatus(
                `Analysis cancelled safely. ${count.toLocaleString()} completed games are saved in this browser · archived ${Number(archive.recordCount || count).toLocaleString()} games remotely.`
              );
            } catch (archiveError) {
              setStatus(
                `Analysis cancelled. ${count.toLocaleString()} completed games are saved in this browser, but the remote archive could not be updated.`
              );
              setError(`Cancel succeeded locally, but remote archive failed: ${archiveError?.message || "unknown error"}`);
            }
          } else {
            setStatus("Analysis cancelled. No completed games were available to archive.");
          }
        } catch {
          setStatus("Analysis cancelled.");
        }
      } else {
        setError(e?.message || "Browser analysis failed.");
      }
    } finally {
      abortRef.current = null;
      setSyncing(false);
    }
  }

  function cancelSync() {
    if (!syncing) return;
    setSyncJob((job) => job ? { ...job, phase: "cancelling", message: "Cancelling after the current Stockfish search..." } : job);
    abortRef.current?.abort();
  }

  function clearData() {
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

      const phaseMetric = (phase) => {
        const cap = phase[0].toUpperCase() + phase.slice(1);
        let weightedLoss = 0;
        let acplMoves = 0;
        let blunders = 0;
        let phaseMoves = 0;

        for (const game of bucket) {
          const movesInPhase = num(game[`player${cap}Moves`]);
          const acpl = game[`player${cap}Acpl`];
          const phaseBlunders = num(game[`player${cap}Blunders`]);

          phaseMoves += movesInPhase;
          blunders += phaseBlunders;
          if (movesInPhase > 0 && Number.isFinite(acpl)) {
            weightedLoss += acpl * movesInPhase;
            acplMoves += movesInPhase;
          }
        }

        return {
          acpl: acplMoves ? Number((weightedLoss / acplMoves).toFixed(2)) : null,
          blundersPer100: phaseMoves ? Number((100 * blunders / phaseMoves).toFixed(2)) : null,
        };
      };

      const opening = phaseMetric('opening');
      const middlegame = phaseMetric('middlegame');
      const endgame = phaseMetric('endgame');

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
        openingAcpl: opening.acpl,
        middlegameAcpl: middlegame.acpl,
        endgameAcpl: endgame.acpl,
        openingBlundersPer100: opening.blundersPer100,
        middlegameBlundersPer100: middlegame.blundersPer100,
        endgameBlundersPer100: endgame.blundersPer100,
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
<header className="header">
        <div className="header-inner">
          <div>
            <h1>{username.trim() || "Chess"} Dashboard</h1>
            <div className="subtitle">
              Longitudinal chess analysis · runs entirely in your browser
            </div>
          </div>

          <div className="actions">
            <input
              className="player-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") syncPlayer(false);
              }}
              placeholder="Chess.com username"
              aria-label="Chess.com username"
            />

            <select
              className="player-input time-class-select"
              value={timeClass}
              onChange={(e) => changeTimeClass(e.target.value)}
              disabled={syncing}
              aria-label="Chess.com time class"
              title="Rated games only"
            >
              <option value="rapid">Rapid</option>
              <option value="blitz">Blitz</option>
            </select>

            <select
              className="player-input engine-select"
              value={engineNodes}
              onChange={(e) => setEngineNodes(Number(e.target.value))}
              disabled={syncing}
              aria-label="Browser Stockfish work per position"
              title="Stockfish 18 lite, single-threaded"
            >
              <option value={5000}>Fast · 5k nodes</option>
              <option value={12000}>Standard · 12k</option>
              <option value={30000}>Deep · 30k</option>
            </select>

            <button
              className="button primary"
              onClick={() => syncPlayer(false)}
              disabled={syncing || !username.trim()}
            >
              <RefreshCw size={16} className={syncing ? "spin" : ""} />
              {syncing ? "Syncing..." : "Sync"}
            </button>

            <button
              className="button"
              onClick={() => syncPlayer(true)}
              disabled={syncing || !username.trim()}
              title="Clear and reanalyze every rated game in the selected time class inside this browser"
            >
              Full rescan
            </button>

            {syncing && (
              <button className="button danger" onClick={cancelSync}>
                Cancel
              </button>
            )}

            <label className="button">
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

        {syncJob && syncing && (
          <section className="sync-progress card">
            <div className="sync-progress-head">
              <div>
                <div className="sync-title">
                  {syncJob.fullRescan ? "Full rescan" : "Syncing"} {syncJob.username} · rated {syncJob.timeClass || timeClass}
                </div>
                <div className="sync-phase">{syncJob.message || syncJob.phase}</div>
              </div>
              <div className="sync-percent">
                {Number(syncJob.percent || 0).toFixed(1)}%
              </div>
            </div>

            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.max(0, Math.min(100, Number(syncJob.percent || 0)))}%` }}
              />
            </div>

            <div className="sync-stats">
              <span>
                Games: {Number(syncJob.current || 0).toLocaleString()} / {Number(syncJob.total || 0).toLocaleString()}
              </span>
              <span>
                Found: {syncJob.missingGames == null ? "—" : Number(syncJob.missingGames).toLocaleString()}
              </span>
              <span>
                Speed: {syncJob.rate == null ? "—" : `${Number(syncJob.rate).toFixed(2)} games/s`}
              </span>
              <span>
                ETA: {syncJob.etaMinutes == null ? "—" : `${Number(syncJob.etaMinutes).toFixed(1)} min`}
              </span>
            </div>

            {!!syncJob.archives?.length && (
              <div className="archive-summary">
                {syncJob.archives.map((archive) => (
                  <span key={archive.month}>
                    {archive.month}: {archive.games} games · {archive.missing} new
                  </span>
                ))}
              </div>
            )}

            {!!syncJob.logs?.length && (
              <pre className="sync-log">{syncJob.logs.slice(-8).join("\n")}</pre>
            )}
          </section>
        )}

        {games.length ? (
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

              <ChartCard title="ACPL by Game Phase">
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
                    />
                    <Line name="Opening" type="monotone" dataKey="openingAcpl" connectNulls dot={false} stroke="#a371f7" strokeWidth={2.2} />
                    <Line name="Middlegame" type="monotone" dataKey="middlegameAcpl" connectNulls dot={false} stroke="#58a6ff" strokeWidth={2.2} />
                    <Line name="Endgame" type="monotone" dataKey="endgameAcpl" connectNulls dot={false} stroke="#f0883e" strokeWidth={2.2} />
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

              <ChartCard title="Blunders by Game Phase · per 100 moves">
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
                      allowDecimals
                      tick={{ fill: "#c9d1d9" }}
                      axisLine={{ stroke: "#6e7681" }}
                      tickLine={{ stroke: "#6e7681" }}
                    />
                    <Tooltip
                      content={(props) => <ChartTooltip {...props} />}
                      cursor={{ stroke: "#6e7681", strokeDasharray: "3 3" }}
                      allowEscapeViewBox={{ x: true, y: true }}
                    />
                    <Line name="Opening" type="monotone" dataKey="openingBlundersPer100" connectNulls dot={false} stroke="#a371f7" strokeWidth={2.2} />
                    <Line name="Middlegame" type="monotone" dataKey="middlegameBlundersPer100" connectNulls dot={false} stroke="#58a6ff" strokeWidth={2.2} />
                    <Line name="Endgame" type="monotone" dataKey="endgameBlundersPer100" connectNulls dot={false} stroke="#f0883e" strokeWidth={2.2} />
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
        ) : null}
      </main>
    </div>
  );
}
