// Trade summary maths, shared by the page and the server: the result of a finished bracket, and stats over many trades.
const r2 = (x) => Math.round(x * 100) / 100;

// e = Bracket.toJSON() of a finished bracket. Returns {qty, entry, exit, gross, exitReason, chases} or null (nothing bought).
export function bracketResult(e) {
  const qty = +e.filled || 0;
  if (!qty) return null;
  const entry = +e.avg || +e.p?.entry, t = e.o?.target, s = e.o?.sl;
  const tq = t && /COMPLETE|CANCEL/.test(t.status || "") ? +t.filled || 0 : 0;
  const sq = s && /COMPLETE/.test(s.status || "") ? +s.filled || qty - tq : 0;
  const tPx = +t?.avg || +t?.price || 0, sPx = +s?.avg || +s?.price || 0;
  const soldQty = Math.min(qty, tq + sq);
  if (!soldQty) return { qty, entry, exit: null, gross: null, exitReason: e.state === "stopped" ? "stopped" : "error", chases: s?.chases || 0, open: true };
  const exitValue = tq * tPx + (soldQty - tq) * sPx, exit = r2(exitValue / soldQty);
  const exitReason = sq === 0 ? "target" : s.exit ? "exit_now" : (s.chases || 0) > 0 ? "sl_chase" : "sl";
  return { qty: soldQty, entry: r2(entry), exit, gross: r2(exitValue - entry * soldQty), exitReason, chases: s?.chases || 0, open: soldQty < qty };
}

export const EXIT_TXT = { target: "Target hit", sl: "Stop-loss", sl_chase: "SL (chase ke baad)", exit_now: "Exit now", stopped: "Managing band", error: "Gadbad" };

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
