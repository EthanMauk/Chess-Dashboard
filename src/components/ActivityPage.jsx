import React, { useMemo, useState } from "react";
import { CalendarDays, Clock3, Flame, Gauge, TimerReset } from "lucide-react";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseDateParts(value) {
  const text = String(value || "").trim().replaceAll(".", "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) return null;

  return { year, month, day, timestamp };
}

function dateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(timestamp, options = {}) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: options.year === false ? undefined : "numeric",
    timeZone: "UTC",
  });
}

function plural(value, singular, pluralValue = `${singular}s`) {
  return `${value.toLocaleString()} ${value === 1 ? singular : pluralValue}`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;

  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);

  if (hours >= 1) return `${hours.toLocaleString()}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function durationSecondsForGame(game) {
  const directCandidates = [
    game?.durationSeconds,
    game?.duration_seconds,
    game?.gameDurationSeconds,
    game?.game_duration_seconds,
  ];

  for (const candidate of directCandidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const minuteCandidates = [
    game?.durationMinutes,
    game?.duration_minutes,
    game?.gameDurationMinutes,
    game?.game_duration_minutes,
  ];

  for (const candidate of minuteCandidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value * 60;
  }

  return null;
}

function heatLevel(count, maxCount) {
  if (!count || !maxCount) return 0;
  const ratio = count / maxCount;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.65) return 3;
  if (ratio <= 0.85) return 4;
  return 5;
}

function StatCard({ icon: Icon, label, value, detail }) {
  return (
    <div className="activity-stat-card">
      <div className="activity-stat-icon" aria-hidden="true"><Icon size={15} /></div>
      <div className="activity-stat-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function MonthCalendar({ year, month, counts, maxCount, dayRanges, onViewDay }) {
  const first = Date.UTC(year, month, 1);
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const offset = new Date(first).getUTCDay();

  const cells = Array.from({ length: offset + days }, (_, index) => {
    if (index < offset) return null;
    const day = index - offset + 1;
    const timestamp = Date.UTC(year, month, day);
    const key = dateKey(timestamp);
    return {
      day,
      count: counts.get(key) || 0,
      timestamp,
    };
  });

  return (
    <div className="activity-month">
      <div className="activity-month-title">{MONTHS[month]}</div>
      <div className="activity-weekday-row" aria-hidden="true">
        {WEEKDAYS.map((day) => <span key={day}>{day[0]}</span>)}
      </div>
      <div className="activity-month-grid">
        {cells.map((cell, index) => {
          if (!cell) return <span className="activity-day activity-day-empty" key={`empty-${index}`} />;
          const level = heatLevel(cell.count, maxCount);
          const range = dayRanges?.get(key);
          if (cell.count > 0 && range && onViewDay) {
            return (
              <button
                type="button"
                key={cell.day}
                className={`activity-day activity-day-button heat-${level}`}
                title={`${formatDate(cell.timestamp)} · ${plural(cell.count, "game")} · view games`}
                aria-label={`${formatDate(cell.timestamp)}, ${plural(cell.count, "game")}. View games.`}
                onClick={() => onViewDay(range)}
              >
                {cell.day}
              </button>
            );
          }

          return (
            <span
              key={cell.day}
              className={`activity-day heat-${level}`}
              title={`${formatDate(cell.timestamp)} · ${plural(cell.count, "game")}`}
              aria-label={`${formatDate(cell.timestamp)}, ${plural(cell.count, "game")}`}
            >
              {cell.day}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function ActivityPage({ games, timeClass = "rapid", focusRange = null, onClearFocus, onViewGamesRange }) {
  const activity = useMemo(() => {
    const dated = (games || [])
      .map((game) => {
        const parsed = parseDateParts(game?.date);
        return parsed ? { game, ...parsed } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp || Number(a.game?.gameNumber || 0) - Number(b.game?.gameNumber || 0));

    const counts = new Map();
    const weekdayCounts = Array(7).fill(0);
    const monthlyCounts = new Map();
    const dayRanges = new Map();
    let maxCount = 0;

    for (const row of dated) {
      const key = dateKey(row.timestamp);
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      maxCount = Math.max(maxCount, next);

      const gameNumber = Number(row.game?.gameNumber);
      if (Number.isFinite(gameNumber)) {
        const currentRange = dayRanges.get(key);
        dayRanges.set(key, currentRange
          ? {
              startGame: Math.min(currentRange.startGame, gameNumber),
              endGame: Math.max(currentRange.endGame, gameNumber),
            }
          : { startGame: gameNumber, endGame: gameNumber });
      }

      weekdayCounts[new Date(row.timestamp).getUTCDay()] += 1;
      const monthKey = `${row.year}-${String(row.month).padStart(2, "0")}`;
      monthlyCounts.set(monthKey, (monthlyCounts.get(monthKey) || 0) + 1);
    }

    const activeTimestamps = [...counts.keys()]
      .map((key) => Date.parse(`${key}T00:00:00Z`))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    let longestStreak = 0;
    let streak = 0;
    let previous = null;
    let longestGap = 0;

    for (const timestamp of activeTimestamps) {
      if (previous == null) {
        streak = 1;
      } else {
        const gapDays = Math.round((timestamp - previous) / DAY_MS);
        streak = gapDays === 1 ? streak + 1 : 1;
        if (gapDays > 1) longestGap = Math.max(longestGap, gapDays - 1);
      }
      longestStreak = Math.max(longestStreak, streak);
      previous = timestamp;
    }

    let currentStreak = 0;
    if (activeTimestamps.length) {
      currentStreak = 1;
      for (let i = activeTimestamps.length - 1; i > 0; i -= 1) {
        const gapDays = Math.round((activeTimestamps[i] - activeTimestamps[i - 1]) / DAY_MS);
        if (gapDays !== 1) break;
        currentStreak += 1;
      }
    }

    const first = activeTimestamps[0] ?? null;
    const last = activeTimestamps[activeTimestamps.length - 1] ?? null;
    const spanDays = Number.isFinite(first) && Number.isFinite(last)
      ? Math.max(1, Math.round((last - first) / DAY_MS) + 1)
      : 0;

    let busiestDay = null;
    let busiestCount = 0;
    for (const [key, count] of counts) {
      if (count > busiestCount) {
        busiestCount = count;
        busiestDay = Date.parse(`${key}T00:00:00Z`);
      }
    }

    const durationRows = (games || [])
      .map((game) => durationSecondsForGame(game))
      .filter((value) => Number.isFinite(value) && value > 0);
    const totalDurationSeconds = durationRows.reduce((sum, value) => sum + value, 0);

    const years = [...new Set(dated.map((row) => row.year))].sort((a, b) => b - a);

    return {
      dated,
      counts,
      weekdayCounts,
      monthlyCounts,
      dayRanges,
      maxCount,
      activeDays: counts.size,
      first,
      last,
      spanDays,
      longestStreak,
      currentStreak,
      longestGap,
      busiestDay,
      busiestCount,
      totalDurationSeconds,
      durationCoverage: games?.length ? durationRows.length / games.length : 0,
      years,
    };
  }, [games]);

  const latestYear = activity.years[0] || new Date().getUTCFullYear();
  const [selectedYear, setSelectedYear] = useState(latestYear);
  const visibleYear = activity.years.includes(selectedYear) ? selectedYear : latestYear;

  const yearGames = useMemo(() => (
    activity.dated.filter((row) => row.year === visibleYear).length
  ), [activity.dated, visibleYear]);

  const avgPerActiveDay = activity.activeDays
    ? games.length / activity.activeDays
    : 0;
  const gamesPerWeek = activity.spanDays
    ? games.length / (activity.spanDays / 7)
    : 0;
  const activeDayRate = activity.spanDays
    ? (activity.activeDays / activity.spanDays) * 100
    : 0;

  const focusSummary = useMemo(() => {
    const rawStart = Number(focusRange?.startGame);
    const rawEnd = Number(focusRange?.endGame);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;

    const startGame = Math.min(rawStart, rawEnd);
    const endGame = Math.max(rawStart, rawEnd);
    const selected = (games || [])
      .filter((game) => {
        const number = Number(game?.gameNumber);
        return Number.isFinite(number) && number >= startGame && number <= endGame;
      })
      .sort((a, b) => Number(a.gameNumber) - Number(b.gameNumber));

    if (!selected.length) return null;

    const wins = selected.filter((game) => game.result === "win").length;
    const draws = selected.filter((game) => game.result === "draw").length;
    const losses = selected.filter((game) => game.result === "loss").length;
    const scorePct = 100 * (wins + (0.5 * draws)) / selected.length;

    const dates = selected
      .map((game) => parseDateParts(game?.date)?.timestamp)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const activeDays = new Set(dates.map(dateKey)).size;

    const acpls = selected.map((game) => Number(game?.playerAcpl)).filter(Number.isFinite);
    const avgAcpl = acpls.length
      ? acpls.reduce((sum, value) => sum + value, 0) / acpls.length
      : NaN;

    const firstRating = Number(selected[0]?.playerRating);
    const lastRating = Number(selected[selected.length - 1]?.playerRating);
    const ratingChange = Number.isFinite(firstRating) && Number.isFinite(lastRating)
      ? lastRating - firstRating
      : NaN;

    return {
      startGame,
      endGame,
      gameCount: selected.length,
      wins,
      draws,
      losses,
      scorePct,
      activeDays,
      gamesPerActiveDay: activeDays ? selected.length / activeDays : NaN,
      avgAcpl,
      ratingChange,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
    };
  }, [focusRange, games]);

  const maxWeekday = Math.max(1, ...activity.weekdayCounts);
  const hasDuration = activity.totalDurationSeconds > 0;
  const totalTime = hasDuration ? formatDuration(activity.totalDurationSeconds) : "Unavailable";
  const totalTimeDetail = hasDuration
    ? `${Math.round(activity.durationCoverage * 100)}% of games include duration data`
    : "Current game data does not include reliable game durations";

  return (
    <>
      <div className="page-heading activity-page-heading">
        <div>
          <div className="page-eyebrow">Playing habits</div>
          <h2>Activity</h2>
        </div>
        <p>When this player plays, how often they return, and how concentrated their game volume is.</p>
      </div>

      {focusSummary && (
        <section className="activity-focus-card" aria-label="Analysis selection activity">
          <div className="activity-focus-head">
            <div>
              <div className="page-eyebrow">From Statistics</div>
              <strong>Games {focusSummary.startGame}–{focusSummary.endGame}</strong>
              <span>
                {focusSummary.firstDate && focusSummary.lastDate
                  ? `${formatDate(focusSummary.firstDate)} – ${formatDate(focusSummary.lastDate)}`
                  : `${focusSummary.gameCount.toLocaleString()} games`}
              </span>
            </div>
            <div className="activity-focus-actions">
              {onViewGamesRange ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => onViewGamesRange(focusSummary)}
                >
                  View games
                </button>
              ) : null}
              {onClearFocus ? (
                <button type="button" className="button" onClick={onClearFocus}>
                  Clear
                </button>
              ) : null}
            </div>
          </div>
          <div className="activity-focus-metrics">
            <div><span>Activity</span><strong>{focusSummary.activeDays} active days</strong><small>{Number.isFinite(focusSummary.gamesPerActiveDay) ? `${focusSummary.gamesPerActiveDay.toFixed(1)} games / active day` : "—"}</small></div>
            <div><span>Record</span><strong>{focusSummary.wins}W {focusSummary.draws}D {focusSummary.losses}L</strong><small>{focusSummary.scorePct.toFixed(1)}% score</small></div>
            <div><span>Rating</span><strong>{Number.isFinite(focusSummary.ratingChange) ? `${focusSummary.ratingChange >= 0 ? "+" : ""}${Math.round(focusSummary.ratingChange)} Elo` : "—"}</strong><small>Selected-range change</small></div>
            <div><span>ACPL</span><strong>{Number.isFinite(focusSummary.avgAcpl) ? focusSummary.avgAcpl.toFixed(1) : "—"}</strong><small>Selected-range average</small></div>
          </div>
        </section>
      )}

      <section className="activity-stat-grid" aria-label="Activity summary">
        <StatCard
          icon={CalendarDays}
          label="Active days"
          value={activity.activeDays.toLocaleString()}
          detail={`${activeDayRate.toFixed(1)}% of ${activity.spanDays.toLocaleString()} calendar days`}
        />
        <StatCard
          icon={Gauge}
          label="Games / active day"
          value={avgPerActiveDay.toFixed(1)}
          detail={`${gamesPerWeek.toFixed(1)} games / calendar week`}
        />
        <StatCard
          icon={Flame}
          label="Longest streak"
          value={plural(activity.longestStreak, "day")}
          detail={`Current run: ${plural(activity.currentStreak, "day")}`}
        />
        <StatCard
          icon={TimerReset}
          label="Longest break"
          value={plural(activity.longestGap, "day")}
          detail={activity.last ? `Last game ${formatDate(activity.last)}` : "No dated games"}
        />
        <StatCard
          icon={Clock3}
          label="Total playing time"
          value={totalTime}
          detail={totalTimeDetail}
        />
      </section>

      <section className="card activity-calendar-card">
        <div className="activity-card-head">
          <div>
            <div className="page-eyebrow">Calendar</div>
            <h3>{visibleYear} activity</h3>
            <p>{yearGames.toLocaleString()} rated {timeClass} games · darker days mean more games. Select any active day to open its games.</p>
          </div>
          {activity.years.length > 1 ? (
            <div className="activity-year-switcher" aria-label="Calendar year">
              {activity.years.map((year) => (
                <button
                  type="button"
                  key={year}
                  className={year === visibleYear ? "active" : ""}
                  onClick={() => setSelectedYear(year)}
                >
                  {year}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="activity-calendar-legend" aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4, 5].map((level) => <i key={level} className={`heat-${level}`} />)}
          <span>More</span>
        </div>

        <div className="activity-year-grid">
          {Array.from({ length: 12 }, (_, month) => (
            <MonthCalendar
              key={`${visibleYear}-${month}`}
              year={visibleYear}
              month={month}
              counts={activity.counts}
              maxCount={activity.maxCount}
              dayRanges={activity.dayRanges}
              onViewDay={onViewGamesRange}
            />
          ))}
        </div>
      </section>

      <section className="activity-detail-grid">
        <div className="card activity-breakdown-card">
          <div className="activity-card-head compact">
            <div>
              <div className="page-eyebrow">Weekly pattern</div>
              <h3>Games by day</h3>
            </div>
          </div>

          <div className="activity-bar-list">
            {WEEKDAYS.map((weekday, index) => {
              const count = activity.weekdayCounts[index];
              return (
                <div className="activity-bar-row" key={weekday}>
                  <span>{weekday}</span>
                  <div className="activity-bar-track">
                    <div className="activity-bar-fill" style={{ width: `${(count / maxWeekday) * 100}%` }} />
                  </div>
                  <strong>{count.toLocaleString()}</strong>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card activity-breakdown-card">
          <div className="activity-card-head compact">
            <div>
              <div className="page-eyebrow">Volume</div>
              <h3>Activity extremes</h3>
            </div>
          </div>

          <div className="activity-fact-list">
            <div>
              <span>Busiest day</span>
              <strong>{activity.busiestDay ? formatDate(activity.busiestDay) : "—"}</strong>
              <small>{activity.busiestCount ? plural(activity.busiestCount, "game") : "No dated games"}</small>
            </div>
            <div>
              <span>First recorded game</span>
              <strong>{activity.first ? formatDate(activity.first) : "—"}</strong>
              <small>{activity.spanDays ? `${activity.spanDays.toLocaleString()}-day recorded span` : "—"}</small>
            </div>
            <div>
              <span>Last recorded game</span>
              <strong>{activity.last ? formatDate(activity.last) : "—"}</strong>
              <small>{plural(games.length, "game")} in this dataset</small>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
