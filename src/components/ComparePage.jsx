import React, { useMemo, useState } from "react";
import { GitCompareArrows, Search } from "lucide-react";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()}${suffix}`;
}

function buildSummary(name, games, stats) {
  const rows = [...(games || [])].sort(
    (a, b) => Number(a.gameNumber || 0) - Number(b.gameNumber || 0)
  );

  const wins = rows.filter((g) => g.result === "win").length;
  const draws = rows.filter((g) => g.result === "draw").length;
  const losses = rows.filter((g) => g.result === "loss").length;
  const scorePct = rows.length
    ? 100 * (wins + (0.5 * draws)) / rows.length
    : null;

  const acpl = rows.map((g) => num(g.playerAcpl)).filter((v) => v != null && v > 0);
  const practical = rows
    .map((g) => num(g.playerPracticalBlunders))
    .filter((v) => v != null);

  const activeDays = new Set(
    rows
      .map((g) => String(g.date || "").slice(0, 10))
      .filter((value) => /^\d{4}[-.]\d{2}[-.]\d{2}$/.test(value))
      .map((value) => value.replaceAll(".", "-"))
  ).size;

  const firstRating = num(rows[0]?.playerRating);
  const lastRating = num(rows[rows.length - 1]?.playerRating);

  return {
    name,
    games: rows.length,
    wins,
    draws,
    losses,
    scorePct,
    currentRating: num(stats?.latestRating) ?? lastRating,
    estimatedStrength: num(stats?.performance?.estimatedElo),
    climbScore: num(stats?.climb?.score),
    avgAcpl: acpl.length ? acpl.reduce((a, b) => a + b, 0) / acpl.length : null,
    practicalBlunders: practical.length
      ? practical.reduce((a, b) => a + b, 0) / practical.length
      : null,
    activeDays,
    ratingChange: firstRating != null && lastRating != null ? lastRating - firstRating : null,
  };
}

function MetricRow({ label, left, right, lowerIsBetter = false, suffix = "" }) {
  const leftNum = Number(left);
  const rightNum = Number(right);
  const comparable = Number.isFinite(leftNum) && Number.isFinite(rightNum);
  const leftWins = comparable && (lowerIsBetter ? leftNum < rightNum : leftNum > rightNum);
  const rightWins = comparable && (lowerIsBetter ? rightNum < leftNum : rightNum > leftNum);

  return (
    <div className="compare-metric-row">
      <div className={`compare-metric-value ${leftWins ? "is-better" : ""}`}>
        {Number.isFinite(leftNum) ? `${fmt(leftNum, Number.isInteger(leftNum) ? 0 : 1)}${suffix}` : "—"}
      </div>
      <div className="compare-metric-label">{label}</div>
      <div className={`compare-metric-value is-right ${rightWins ? "is-better" : ""}`}>
        {Number.isFinite(rightNum) ? `${fmt(rightNum, Number.isInteger(rightNum) ? 0 : 1)}${suffix}` : "—"}
      </div>
    </div>
  );
}

export default function ComparePage({
  primaryName,
  primaryGames,
  primaryStats,
  comparisonName,
  comparisonGames,
  comparisonStats,
  knownProfiles = [],
  loading = false,
  error = "",
  onCompare,
  timeClass = "rapid",
}) {
  const [query, setQuery] = useState(comparisonName || "");

  const left = useMemo(
    () => buildSummary(primaryName, primaryGames, primaryStats),
    [primaryName, primaryGames, primaryStats]
  );
  const right = useMemo(
    () => buildSummary(comparisonName, comparisonGames, comparisonStats),
    [comparisonName, comparisonGames, comparisonStats]
  );

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return knownProfiles
      .filter((name) => name.toLowerCase() !== String(primaryName || "").toLowerCase())
      .filter((name) => !q || name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [knownProfiles, primaryName, query]);

  function submit(event) {
    event.preventDefault();
    const player = query.trim();
    if (player) onCompare(player);
  }

  return (
    <>
      <div className="page-heading compare-page-heading">
        <div>
          <div className="page-eyebrow">Head-to-head</div>
          <h2>Compare</h2>
        </div>
        <p>Compare two analyzed players using the same rating, engine, climb, and activity metrics.</p>
      </div>

      <section className="card compare-search-card">
        <form className="compare-search-form" onSubmit={submit}>
          <div className="compare-search-copy">
            <GitCompareArrows size={18} aria-hidden="true" />
            <div>
              <strong>Compare {primaryName || "this player"} with</strong>
              <span>Choose any player already archived in the dashboard database.</span>
            </div>
          </div>

          <div className="compare-search-control">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              list="dashboard-profile-names"
              placeholder="Start typing a username"
              aria-label="Comparison player"
              autoComplete="off"
            />
          </div>

          <button className="button primary" type="submit" disabled={loading || !query.trim()}>
            {loading ? "Loading…" : "Compare"}
          </button>
        </form>

        {suggestions.length > 0 ? (
          <div className="compare-suggestions" aria-label="Matching archived players">
            {suggestions.map((name) => (
              <button
                type="button"
                key={name}
                onClick={() => {
                  setQuery(name);
                  onCompare(name);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <div className="compare-error">{error}</div> : null}
      </section>

      {comparisonGames?.length ? (
        <section className="compare-board">
          <div className="compare-player-head">
            <div>
              <span>{timeClass}</span>
              <strong>{left.name}</strong>
              <small>{left.games.toLocaleString()} analyzed games</small>
            </div>
            <div className="compare-versus">VS</div>
            <div className="is-right">
              <span>{timeClass}</span>
              <strong>{right.name}</strong>
              <small>{right.games.toLocaleString()} analyzed games</small>
            </div>
          </div>

          <div className="compare-metrics-card card">
            <MetricRow label="Current Elo" left={left.currentRating} right={right.currentRating} />
            <MetricRow label="Estimated strength" left={left.estimatedStrength} right={right.estimatedStrength} />
            <MetricRow label="Climb score" left={left.climbScore} right={right.climbScore} />
            <MetricRow label="Score rate" left={left.scorePct} right={right.scorePct} suffix="%" />
            <MetricRow label="Average ACPL" left={left.avgAcpl} right={right.avgAcpl} lowerIsBetter />
            <MetricRow label="Practical blunders / game" left={left.practicalBlunders} right={right.practicalBlunders} lowerIsBetter />
            <MetricRow label="Active days" left={left.activeDays} right={right.activeDays} />
            <MetricRow label="Rating change" left={left.ratingChange} right={right.ratingChange} />
          </div>

          <div className="compare-record-grid">
            <div className="card compare-record-card">
              <span>Record</span>
              <strong>{left.wins}W {left.draws}D {left.losses}L</strong>
              <small>{left.scorePct != null ? `${left.scorePct.toFixed(1)}% score` : "—"}</small>
            </div>
            <div className="card compare-record-card is-right">
              <span>Record</span>
              <strong>{right.wins}W {right.draws}D {right.losses}L</strong>
              <small>{right.scorePct != null ? `${right.scorePct.toFixed(1)}% score` : "—"}</small>
            </div>
          </div>
        </section>
      ) : (
        <section className="compare-empty card">
          <GitCompareArrows size={24} aria-hidden="true" />
          <strong>Pick another archived player</strong>
          <span>The comparison will appear here without replacing the profile you are currently viewing.</span>
        </section>
      )}
    </>
  );
}
