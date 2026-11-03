/* SGP Finder - core logic (data + rules). No DOM code here. */
(function (root) {
  "use strict";

  const VERSION = 4;
  const BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
  const CACHE_PREFIX = "sgp:box:v1:";

  const LADDERS = {
    PTS: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
    REB: [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16],
    AST: [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14],
  };

  const SCORING = {
    DraftKings: { pts: 1, fg3m: 0.5, reb: 1.25, ast: 1.5, stl: 2, blk: 2, tov: -0.5, dd: 1.5, td: 3 },
    FanDuel: { pts: 1, fg3m: 0, reb: 1.2, ast: 1.5, stl: 3, blk: 3, tov: -1, dd: 0, td: 0 },
  };

  const DEFAULTS = {
    minUsage: 24, bottomN: 10, minHitRate: 0.93, minGames: 5, minMpg: 20,
    lineStyle: "ladder", scoring: "DraftKings", oddsFormat: "american",
  };

  // ------------------------------------------------------------------ dates
  const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  function seasonStart(d) {
    const y = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    return new Date(y, 9, 1); // Oct 1
  }

  // ------------------------------------------------------------------ cache (localStorage, optional)
  const memCache = new Map();
  function cacheGet(id) {
    if (memCache.has(id)) return memCache.get(id);
    try {
      const s = root.localStorage && root.localStorage.getItem(CACHE_PREFIX + id);
      if (s) { const v = JSON.parse(s); memCache.set(id, v); return v; }
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function cacheSet(id, v) {
    memCache.set(id, v);
    try { root.localStorage && root.localStorage.setItem(CACHE_PREFIX + id, JSON.stringify(v)); } catch (e) { /* full or blocked */ }
  }
  function clearCache() {
    memCache.clear();
    try {
      const ls = root.localStorage; if (!ls) return;
      Object.keys(ls).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => ls.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ fetch
  async function getJSON(url, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await root.fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) {
        last = e;
        await new Promise((res) => setTimeout(res, 800 * (i + 1)));
      }
    }
    throw new Error("Couldn't load " + url.replace(BASE, "ESPN") + " (" + last.message + ")");
  }

  function eventsFrom(json) {
    return (json.events || []).map((ev) => {
      const comp = (ev.competitions || [])[0] || {};
      const teams = (comp.competitors || []).map((c) => ({ id: String(c.team.id), abbr: c.team.abbreviation }));
      const st = (ev.status && ev.status.type) || (comp.status && comp.status.type) || {};
      return {
        id: String(ev.id), date: ev.date, teams,
        completed: !!st.completed,
        seasonType: ev.season ? ev.season.type : 2,
      };
    }).filter((e) => e.teams.length === 2);
  }

  // One day's games. ESPN only accepts a single date here (ranges return HTTP 400).
  async function fetchScoreboard(day) {
    return eventsFrom(await getJSON(`${BASE}/scoreboard?dates=${ymd(day)}`));
  }

  // Past days never change once every game is final, so those are cached.
  async function fetchDay(day) {
    const key = "day:" + ymd(day);
    const cached = cacheGet(key);
    if (cached) return cached;
    const events = await fetchScoreboard(day);
    const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    if (day < twoDaysAgo && events.every((e) => e.completed)) cacheSet(key, events);
    return events;
  }

  // All completed regular-season games from season start up to (not including) the slate date
  async function fetchSeasonEvents(slateDate, onProgress) {
    const start = seasonStart(slateDate);
    const end = new Date(slateDate); end.setDate(end.getDate() - 1);
    const days = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(new Date(d));
    const events = []; let i = 0, done = 0;
    async function worker() {
      while (i < days.length) {
        const day = days[i++];
        const dayEvents = await fetchDay(day);
        events.push(...dayEvents);
        done++;
        onProgress && onProgress({ stage: "schedule", text: `Loading schedule ${done} of ${days.length} days…` });
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, days.length) }, worker));
    const seen = new Set();
    return events.filter((e) => e.completed && e.seasonType === 2 && !seen.has(e.id) && seen.add(e.id));
  }

  // ------------------------------------------------------------------ box score parsing
  const LABEL_ALIASES = {
    MIN: ["MIN", "minutes"], FG: ["FG", "fieldGoalsMade-fieldGoalsAttempted"],
    "3PT": ["3PT", "threePointFieldGoalsMade-threePointFieldGoalsAttempted"],
    FT: ["FT", "freeThrowsMade-freeThrowsAttempted"], REB: ["REB", "rebounds"],
    AST: ["AST", "assists"], STL: ["STL", "steals"], BLK: ["BLK", "blocks"],
    TO: ["TO", "turnovers"], PTS: ["PTS", "points"],
  };
  const num = (s) => { const n = parseFloat(s); return isFinite(n) ? n : 0; };
  const pair = (s) => { const [m, a] = String(s || "0-0").split("-"); return [num(m), num(a)]; };
  const mins = (s) => { s = String(s || ""); if (s.includes(":")) { const [m, x] = s.split(":"); return num(m) + num(x) / 60; } return num(s); };
  function posGroup(p) {
    p = String(p || "").toUpperCase();
    if (p === "C") return "C";
    if (p.includes("G")) return "G";
    if (p.includes("F")) return "F";
    if (p.startsWith("C")) return "C";
    return "F";
  }

  // -> { id, date, rows: [...] }  (compact per-player lines for one game)
  function parseSummary(json, ev) {
    const sides = (json.boxscore && json.boxscore.players) || [];
    if (sides.length !== 2) throw new Error("No box score for game " + ev.id);
    const rows = [];
    const teamAbbr = sides.map((s) => s.team.abbreviation);
    const teamId = sides.map((s) => String(s.team.id));
    sides.forEach((side, i) => {
      const block = (side.statistics || [])[0];
      if (!block) return;
      const labels = (block.labels || block.names || []).map(String);
      const keys = (block.keys || []).map(String);
      const idx = {};
      for (const [k, aliases] of Object.entries(LABEL_ALIASES)) {
        let j = labels.findIndex((l) => l.toUpperCase() === aliases[0]);
        if (j < 0) j = keys.indexOf(aliases[1]);
        idx[k] = j;
      }
      for (const a of block.athletes || []) {
        if (a.didNotPlay || !a.stats || !a.stats.length) continue;
        const g = (k) => (idx[k] >= 0 ? a.stats[idx[k]] : "0");
        const m = mins(g("MIN"));
        if (m <= 0) continue;
        const [fgm, fga] = pair(g("FG")); const [fg3m] = pair(g("3PT")); const [, fta] = pair(g("FT"));
        rows.push({
          pid: String(a.athlete.id), name: a.athlete.displayName || a.athlete.shortName,
          pos: posGroup(a.athlete.position && a.athlete.position.abbreviation),
          team: teamId[i], teamAbbr: teamAbbr[i], opp: teamId[1 - i], oppAbbr: teamAbbr[1 - i],
          min: m, pts: num(g("PTS")), reb: num(g("REB")), ast: num(g("AST")), stl: num(g("STL")),
          blk: num(g("BLK")), tov: num(g("TO")), fgm, fga, fg3m, fta,
        });
      }
    });
    // team totals (for usage rate)
    const tot = {};
    for (const r of rows) {
      const t = tot[r.team] || (tot[r.team] = { min: 0, fga: 0, fta: 0, tov: 0 });
      t.min += r.min; t.fga += r.fga; t.fta += r.fta; t.tov += r.tov;
    }
    for (const r of rows) { const t = tot[r.team]; r.tmMin = t.min; r.tmFga = t.fga; r.tmFta = t.fta; r.tmTov = t.tov; }
    return { id: ev.id, date: ev.date, rows };
  }

  async function fetchBoxes(events, onProgress, concurrency = 8) {
    const out = []; let done = 0; let i = 0; const errors = [];
    const todo = events.filter((e) => { const c = cacheGet(e.id); if (c) { out.push(c); return false; } return true; });
    done = out.length;
    const total = events.length;
    onProgress && onProgress({ stage: "boxes", done, total });
    async function worker() {
      while (i < todo.length) {
        const ev = todo[i++];
        try {
          const box = parseSummary(await getJSON(`${BASE}/summary?event=${ev.id}`), ev);
          cacheSet(ev.id, box); out.push(box);
        } catch (e) { errors.push(e.message); }
        done++; onProgress && onProgress({ stage: "boxes", done, total });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    if (errors.length && errors.length > events.length * 0.2) throw new Error(errors[0]);
    return out;
  }

  async function loadAll(slateDate, onProgress) {
    const [season, slate] = await Promise.all([
      fetchSeasonEvents(slateDate, onProgress),
      fetchScoreboard(slateDate),
    ]);
    const boxes = await fetchBoxes(season, onProgress);
    return { boxes, slate };
  }

  // ------------------------------------------------------------------ rules
  function fantasyPoints(r, scoring) {
    const w = SCORING[scoring];
    const tens = [r.pts, r.reb, r.ast, r.stl, r.blk].filter((x) => x >= 10).length;
    return r.pts * w.pts + r.fg3m * w.fg3m + r.reb * w.reb + r.ast * w.ast + r.stl * w.stl +
      r.blk * w.blk + r.tov * w.tov + (tens >= 2 ? w.dd : 0) + (tens >= 3 ? w.td : 0);
  }

  // Fantasy points allowed per game by each team to each position. rank 1 = allows the most.
  function defenseVsPosition(boxes, scoring) {
    const agg = {}; // `${opp}|${pos}` -> {sum, games:Set}
    const abbr = {};
    for (const b of boxes) {
      for (const r of b.rows) {
        abbr[r.opp] = r.oppAbbr;
        const k = r.opp + "|" + r.pos;
        const a = agg[k] || (agg[k] = { opp: r.opp, pos: r.pos, sum: 0, games: new Set() });
        a.sum += fantasyPoints(r, scoring); a.games.add(b.id);
      }
    }
    const list = Object.values(agg).map((a) => ({ opp: a.opp, abbr: abbr[a.opp], pos: a.pos, fp: a.sum / a.games.size, games: a.games.size }));
    for (const pos of ["G", "F", "C"]) {
      const p = list.filter((x) => x.pos === pos).sort((x, y) => y.fp - x.fp);
      p.forEach((x, i) => { x.rank = i > 0 && Math.abs(x.fp - p[i - 1].fp) < 1e-9 ? p[i - 1].rank : i + 1; });
    }
    return list;
  }

  function bestAltLine(values, minRate, ladder, floor) {
    const n = values.length; if (!n) return null;
    const max = Math.max(...values);
    const cands = ladder || Array.from({ length: Math.max(0, max - floor + 1) }, (_, i) => floor + i);
    let best = null;
    for (const line of cands) {
      const hits = values.filter((v) => v >= line).length;
      if (hits / n >= minRate) best = { line, hits, n, rate: hits / n };
    }
    return best;
  }

  function usageRate(games) {
    let num_ = 0, den = 0;
    for (const g of games) {
      num_ += (g.fga + 0.44 * g.fta + g.tov) * (g.tmMin / 5);
      den += g.min * (g.tmFga + 0.44 * g.tmFta + g.tmTov);
    }
    return den > 0 ? (100 * num_) / den : 0;
  }

  // ------------------------------------------------------------------ stat types
  const range = (a, b, step) => { const out = []; for (let x = a; x <= b; x += step) out.push(x); return out; };
  const STATS = {
    PTS: { label: "Points", get: (g) => g.pts, ladder: LADDERS.PTS },
    REB: { label: "Rebounds", get: (g) => g.reb, ladder: LADDERS.REB },
    AST: { label: "Assists", get: (g) => g.ast, ladder: LADDERS.AST },
    "3PM": { label: "3-pointers", get: (g) => g.fg3m, ladder: [1, 2, 3, 4, 5, 6, 7] },
    STL: { label: "Steals", get: (g) => g.stl, ladder: [1, 2, 3, 4] },
    BLK: { label: "Blocks", get: (g) => g.blk, ladder: [1, 2, 3, 4] },
    PRA: { label: "Pts+Reb+Ast", get: (g) => g.pts + g.reb + g.ast, ladder: range(10, 70, 5) },
    PR: { label: "Pts+Reb", get: (g) => g.pts + g.reb, ladder: range(10, 60, 5) },
    PA: { label: "Pts+Ast", get: (g) => g.pts + g.ast, ladder: range(10, 60, 5) },
    RA: { label: "Reb+Ast", get: (g) => g.reb + g.ast, ladder: range(4, 24, 2) },
  };

  // ------------------------------------------------------------------ odds (American or decimal)
  // "-900", "+150", "150" -> American; "1.14", "2.5" -> decimal. Returns decimal odds or null.
  function parseOdds(input) {
    const x = parseFloat(String(input == null ? "" : input).replace(/\s|\+/g, ""));
    if (!isFinite(x)) return null;
    if (Math.abs(x) >= 100) return x > 0 ? 1 + x / 100 : 1 + 100 / -x;
    if (x > 1 && x < 100) return x;
    return null;
  }
  function formatOdds(dec, fmt) {
    if (!isFinite(dec) || dec <= 1) return "–";
    if (fmt === "decimal") return dec.toFixed(2);
    return dec >= 2 ? "+" + Math.round((dec - 1) * 100) : String(-Math.round(100 / (dec - 1)));
  }
  const probToDecimal = (p) => (p > 0 ? 1 / p : Infinity);
  // kept for older callers
  const americanOdds = (p) => formatOdds(probToDecimal(p), "american");
  const impliedProb = (o) => { const d = parseOdds(o); return d ? 1 / d : NaN; };

  // ------------------------------------------------------------------ parlay math
  // Legs on the same player are scored together from that player's actual games (captures
  // correlation). Different players are treated as independent and multiplied.
  function parlayEstimate(legs, players) {
    const groups = {};
    for (const l of legs) (groups[l.pid] || (groups[l.pid] = [])).push(l);
    let est = 1, raw = 1;
    const parts = [];
    for (const [pid, ls] of Object.entries(groups)) {
      const games = (players[pid] && players[pid].games) || [];
      const n = games.length;
      const k = games.filter((g) => ls.every((l) => STATS[l.stat].get(g) >= l.line)).length;
      const p = (k + 1) / (n + 2);
      est *= p; raw *= n ? k / n : 0;
      parts.push({ pid, name: ls[0].name, legs: ls.length, k, n, p });
    }
    const gamesUsed = new Set(legs.map((l) => l.gameId));
    const sameGameOthers = [...gamesUsed].some((gid) => new Set(legs.filter((l) => l.gameId === gid).map((l) => l.pid)).size > 1);
    return { est: legs.length ? est : 0, raw, parts, games: gamesUsed.size, sameGameOthers };
  }

  // ------------------------------------------------------------------ main
  function findSGPs(data, settings) {
    const s = Object.assign({}, DEFAULTS, settings);
    const boxes = data.boxes.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const dvp = defenseVsPosition(boxes, s.scoring);
    const rankOf = {}; dvp.forEach((d) => (rankOf[d.opp + "|" + d.pos] = d));

    const oppOf = {}, abbrOf = {}, gameOf = {};
    for (const ev of data.slate) {
      const [a, b] = ev.teams;
      oppOf[a.id] = b.id; oppOf[b.id] = a.id; abbrOf[a.id] = a.abbr; abbrOf[b.id] = b.abbr;
      gameOf[a.id] = gameOf[b.id] = { id: ev.id, label: `${b.abbr} @ ${a.abbr}`, date: ev.date };
    }
    const games = data.slate.map((ev) => ({ id: ev.id, label: `${ev.teams[1].abbr} @ ${ev.teams[0].abbr}`, date: ev.date }));

    const byPlayer = {};
    for (const b of boxes) for (const r of b.rows) (byPlayer[r.pid] || (byPlayer[r.pid] = [])).push(r);

    const players = {}, picks = [], misses = [], legs = [];
    for (const pg of Object.values(byPlayer)) {
      const last = pg[pg.length - 1];
      const team = last.team;
      if (!(team in oppOf)) continue;
      const n = pg.length;
      const mpg = pg.reduce((t, g) => t + g.min, 0) / n;
      if (n < s.minGames || mpg < s.minMpg) continue;
      const usg = usageRate(pg);
      const posCount = {}; pg.forEach((g) => (posCount[g.pos] = (posCount[g.pos] || 0) + 1));
      const pos = Object.keys(posCount).sort((x, y) => posCount[y] - posCount[x])[0];
      const opp = oppOf[team];
      const d = rankOf[opp + "|" + pos];
      const info = {
        pid: last.pid, name: last.name, team: abbrOf[team] || last.teamAbbr, opp: abbrOf[opp], pos, usg, gp: n, mpg,
        oppRank: d ? d.rank : null, oppFp: d ? d.fp : null, gameId: gameOf[team].id, game: gameOf[team].label, games: pg,
        passUsage: usg >= s.minUsage, passMatchup: !!d && d.rank <= s.bottomN,
      };
      players[info.pid] = info;

      // best line for every stat type
      const best = {};
      for (const [stat, def] of Object.entries(STATS)) {
        const ladder = s.lineStyle === "ladder" ? def.ladder : null;
        const b = bestAltLine(pg.map(def.get), s.minHitRate, ladder, def.ladder[0]);
        best[stat] = b;
        if (b) legs.push({
          key: `${info.pid}|${stat}|${b.line}`, pid: info.pid, name: info.name, team: info.team, opp: info.opp, pos,
          gameId: info.gameId, game: info.game, stat, line: b.line, hits: b.hits, n: b.n, rate: b.rate,
          usg, oppRank: info.oppRank, passUsage: info.passUsage, passMatchup: info.passMatchup,
        });
      }

      // auto PTS+REB+AST SGP (rules 1-4)
      if (!info.passUsage) continue;
      const reasons = [];
      if (!info.passMatchup) reasons.push(`${info.opp} ranks #${d ? d.rank : "?"} vs ${pos}`);
      const trio = { PTS: best.PTS, REB: best.REB, AST: best.AST };
      for (const st of ["PTS", "REB", "AST"]) if (!trio[st]) reasons.push(`no ${st} line at ${Math.round(s.minHitRate * 100)}%`);
      const row = Object.assign({}, info, { legs: trio, reasons });
      delete row.games;
      if (trio.PTS && trio.REB && trio.AST) {
        row.multiplied = trio.PTS.rate * trio.REB.rate * trio.AST.rate;
        row.all3 = pg.filter((g) => g.pts >= trio.PTS.line && g.reb >= trio.REB.line && g.ast >= trio.AST.line).length;
        row.est = (row.all3 + 1) / (n + 2);
        row.legKeys = ["PTS", "REB", "AST"].map((st) => `${info.pid}|${st}|${trio[st].line}`);
      }
      (reasons.length ? misses : picks).push(row);
    }
    picks.sort((a, b) => b.est - a.est || b.gp - a.gp || b.usg - a.usg);
    misses.sort((a, b) => a.reasons.length - b.reasons.length || b.usg - a.usg);
    legs.sort((a, b) => b.rate - a.rate || b.n - a.n || b.usg - a.usg);

    const gpList = Object.values(byPlayer).map((g) => g.length).sort((a, b) => a - b);
    const typicalGp = gpList.length ? gpList[Math.floor(gpList.length / 2)] : 0;
    return { picks, misses, legs, players, games, dvp, typicalGp, slateGames: data.slate.length, gamesLoaded: boxes.length };
  }

  const api = { VERSION, LADDERS, STATS, SCORING, DEFAULTS, loadAll, findSGPs, parlayEstimate, parseSummary, eventsFrom,
    bestAltLine, usageRate, defenseVsPosition, parseOdds, formatOdds, probToDecimal, americanOdds, impliedProb,
    clearCache, ymd, seasonStart };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SGP = api;
})(typeof window !== "undefined" ? window : globalThis);
