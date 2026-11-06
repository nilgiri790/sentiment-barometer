// Trade summary maths, shared by the page and the server: the result of a finished bracket, and stats over many trades.
const r2 = (x) => Math.round(x * 100) / 100;

// e = Bracket.toJSON() of a finished bracket. Returns {qty, entry, exit, gross, exitReason, chases} or null (nothing bought).
export function bracketResult(e) {
  const qty = +e.filled || 0;
  if (!qty) return null;
  const entry = +e.avg || +e.p?.entry, t = e.o?.target, s = e.o?.sl, h = e.o?.hard;
  const done = (o) => o && /COMPLETE|CANCEL/.test(o.status || "") ? +o.filled || 0 : 0;
  const tq = done(t), hq = h && /COMPLETE|CANCEL/.test(h.status || "") ? +h.filled || 0 : 0;
  const sq = s && /COMPLETE/.test(s.status || "") ? +s.filled || qty - tq - hq : 0;
  const tPx = +t?.avg || +t?.price || 0, hPx = +h?.avg || +h?.price || 0, sPx = +s?.avg || +s?.price || 0;
  const soldQty = Math.min(qty, tq + hq + sq);
  if (!soldQty) return { qty, entry, exit: null, gross: null, exitReason: e.state === "stopped" ? "stopped" : "error", chases: (s?.chases || 0) + (h?.chases || 0), open: true };
  const exitValue = tq * tPx + hq * hPx + Math.max(0, soldQty - tq - hq) * sPx, exit = r2(exitValue / soldQty);
  const chases = (s?.chases || 0) + (h?.chases || 0), trail = !!e.slMoved && exit >= entry;
  let exitReason;
  if (hq) exitReason = trail ? "trail_sl" : (h.chases || 0) > 0 ? "sl_chase" : "sl";
  else if (sq === 0) exitReason = "target";
  else if (s.exit === "tp") exitReason = "target";
  else if (s.exit === "time") exitReason = "time_exit";
  else if (s.exit === "slnow") exitReason = "sl";
  else if (s.exit) exitReason = "exit_now";
  else exitReason = trail ? "trail_sl" : (s.chases || 0) > 0 ? "sl_chase" : "sl";
  return { qty: soldQty, entry: r2(entry), exit, gross: r2(exitValue - entry * soldQty), exitReason, chases, open: soldQty < qty, hardSl: !!e.p?.hardSl };
}

export const EXIT_TXT = { target: "Target hit", sl: "Stop-loss", sl_chase: "SL (chase ke baad)", trail_sl: "Trailing SL", time_exit: "Time exit", exit_now: "Exit now", stopped: "Managing band", error: "Gadbad" };

// trades: journal rows with {net, type, signal:{confidence}}; only closed ones (net is a number) count
export function computeStats(trades) {
  const closed = trades.filter((t) => Number.isFinite(t.net));
  const wins = closed.filter((t) => t.net > 0), losses = closed.filter((t) => t.net <= 0);
  const sum = (a, k = "net") => r2(a.reduce((x, t) => x + (+t[k] || 0), 0));
  const group = (f) => { const g = {}; for (const t of closed) { const k = f(t); if (k == null) continue; (g[k] ||= { n: 0, wins: 0, net: 0 }); g[k].n++; if (t.net > 0) g[k].wins++; g[k].net = r2(g[k].net + t.net); } return g; };
  return {
    n: closed.length, wins: wins.length, losses: losses.length, winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
    net: sum(closed), gross: sum(closed, "gross"), charges: sum(closed, "charges"),
    avgWin: wins.length ? r2(sum(wins) / wins.length) : null, avgLoss: losses.length ? r2(sum(losses) / losses.length) : null,
    best: closed.length ? Math.max(...closed.map((t) => t.net)) : null, worst: closed.length ? Math.min(...closed.map((t) => t.net)) : null,
    byType: group((t) => t.type || null), byConf: group((t) => (t.signal?.confidence == null ? null : t.signal.confidence >= 70 ? "70+" : "<70")),
  };
}

// India date (YYYY-MM-DD) of a time in ms
export const istDay = (ms) => new Date(ms + 19800 * 1000).toISOString().slice(0, 10);
// the day's kill switch for one mode (paper / real), all trades (yours + AI); trades newest first
export function riskTodayOf(trades, mode, risk, now = Date.now()) {
  const day = istDay(now), list = trades.filter((t) => t.mode === mode && t.day === day && t.net != null);
  let consec = 0; for (const t of list) { if (t.net < 0) consec++; else break; }
  const net = r2(list.reduce((a, t) => a + t.net, 0)), lastLoss = list.find((t) => t.net < 0);
  let locked = null;
  if (net <= -risk.maxLossDay) locked = `Aaj ka max nuksan ₹${risk.maxLossDay} pahunch gaya`;
  else if (consec >= risk.maxConsecLoss) locked = `Lagataar ${consec} trade nuksan mein`;
  else if (list.length >= risk.maxTradesDay) locked = `Aaj ki ${risk.maxTradesDay} trade ki limit poori`;
  return { trades: list.length, net, consec, lastLossAt: lastLoss ? Date.parse(lastLoss.closedAt) : 0, lastAt: list[0] ? Date.parse(list[0].closedAt) : 0, lastNet: list[0]?.net ?? null, locked };
}

// pro numbers for the Trade summary: equity curve + drawdown, expectancy, R, and how you do by time / type / setup / mood
export const SLOTS = [["9:15–10:00", 555, 600], ["10:00–11:30", 600, 690], ["11:30–1:30", 690, 810], ["1:30–3:30", 810, 931]];
export function proStats(trades) {
  const closed = trades.filter((t) => Number.isFinite(t.net)).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let eq = 0, peak = 0, maxDD = 0; const curve = [];
  for (const t of closed) { eq = r2(eq + t.net); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); curve.push([Date.parse(t.at), eq]); }
  const n = closed.length, rs = closed.filter((t) => Number.isFinite(t.r)), slips = closed.filter((t) => Number.isFinite(t.slip));
  const grp = (f) => { const g = {}; for (const t of closed) { const k = f(t); if (k == null || k === "") continue; (g[k] ||= { n: 0, wins: 0, net: 0 }); g[k].n++; if (t.net > 0) g[k].wins++; g[k].net = r2(g[k].net + t.net); } return g; };
  const minOf = (t) => { const d = new Date(Date.parse(t.at) + 19800e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  return {
    n, curve, maxDD: r2(maxDD), expectancy: n ? r2(eq / n) : null,
    avgR: rs.length ? r2(rs.reduce((a, t) => a + t.r, 0) / rs.length) : null, totalR: rs.length ? r2(rs.reduce((a, t) => a + t.r, 0)) : null,
    avgSlip: slips.length ? r2(slips.reduce((a, t) => a + t.slip, 0) / slips.length) : null,
    bySlot: grp((t) => SLOTS.find(([, a, b]) => minOf(t) >= a && minOf(t) < b)?.[0] ?? "Market ke bahar"), byType: grp((t) => t.type),
    byExpiry: grp((t) => (t.expiryDay ? "Expiry din" : "Aam din")), bySetup: grp((t) => t.setup), byMood: grp((t) => t.mood),
    bySl: grp((t) => (t.hardSl ? "Zerodha SL" : "Page SL")), bySource: grp((t) => (t.source === "ai" ? "AI" : "Aap")),
  };
}
