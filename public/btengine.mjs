// Backtest engine (no dependencies). Used by the Backtest page and by the server to check AI-made strategies.
// A strategy is plain data, never code:
//   { name, entry: { all: [rule, ...] }, exit: { any: [rule, ...] }, stopLossPct?, takeProfitPct?, maxHoldBars? }
//   rule    = { left: operand, op: ">" | "<" | "crosses_above" | "crosses_below", right: operand }
//   operand = { value: number } | { ind: "close"|"open"|"high"|"low"|"volume"|"sma"|"ema"|"rsi"|"bb_upper"|"bb_mid"|"bb_lower"
//                                      |"highest"|"lowest"|"sma_volume", n?: int, k?: number }
// Long only. Signals are checked on a candle's close and filled at the NEXT candle's open (no look-ahead).
// Stop-loss / target are checked inside each candle using its low/high (stop first when both are hit: conservative).

export const INDICATORS = ["close", "open", "high", "low", "volume", "sma", "ema", "rsi", "bb_upper", "bb_mid", "bb_lower", "highest", "lowest", "sma_volume"];
export const OPS = [">", "<", "crosses_above", "crosses_below"];
const NEEDS_N = new Set(["sma", "ema", "rsi", "bb_upper", "bb_mid", "bb_lower", "highest", "lowest", "sma_volume"]);

// ---------- indicators: arrays aligned with bars, null while warming up ----------
export function sma(v, n) { const o = Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
export function ema(v, n) { const o = Array(v.length).fill(null), k = 2 / (n + 1); let e = null;
  for (let i = 0; i < v.length; i++) { if (i < n - 1) continue; if (e == null) { e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; o[i] = e; continue; } e = v[i] * k + e * (1 - k); o[i] = e; } return o; }
export function rsi(v, n = 14) {                     // Wilder's RSI
  const o = Array(v.length).fill(null); if (v.length <= n) return o;
  let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}
export function bands(v, n = 20, k = 2) { const mid = sma(v, n), up = Array(v.length).fill(null), lo = Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2; const sd = Math.sqrt(s / n); up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd; }
  return { up, mid, lo }; }
// Highest/lowest of the PREVIOUS n candles (so "close > highest(20)" means a real breakout)
export function prevExtreme(v, n, max) { const o = Array(v.length).fill(null);
  for (let i = n; i < v.length; i++) { let x = v[i - 1]; for (let j = i - n; j < i; j++) x = max ? Math.max(x, v[j]) : Math.min(x, v[j]); o[i] = x; } return o; }

function series(bars, op, cache) {
  if ("value" in op) return null;
  const n = Math.round(op.n || 14), k = op.k ?? 2, id = `${op.ind}:${n}:${k}`;
  if (cache.has(id)) return cache.get(id);
  const C = bars.map((b) => b.close);
  let s;
  switch (op.ind) {
    case "close": case "open": case "high": case "low": case "volume": s = bars.map((b) => b[op.ind] ?? 0); break;
    case "sma": s = sma(C, n); break; case "ema": s = ema(C, n); break; case "rsi": s = rsi(C, n); break;
    case "bb_upper": s = bands(C, n, k).up; break; case "bb_mid": s = bands(C, n, k).mid; break; case "bb_lower": s = bands(C, n, k).lo; break;
    case "highest": s = prevExtreme(bars.map((b) => b.high), n, true); break; case "lowest": s = prevExtreme(bars.map((b) => b.low), n, false); break;
    case "sma_volume": s = sma(bars.map((b) => b.volume || 0), n); break;
    default: s = Array(bars.length).fill(null);
  }
  cache.set(id, s); return s;
}
const val = (bars, op, i, cache) => ("value" in op ? op.value : series(bars, op, cache)[i]);
function test(bars, r, i, cache) {
  const a = val(bars, r.left, i, cache), b = val(bars, r.right, i, cache);
  if (a == null || b == null) return false;
  if (r.op === ">") return a > b;
  if (r.op === "<") return a < b;
  const a0 = val(bars, r.left, i - 1, cache), b0 = val(bars, r.right, i - 1, cache);
  if (a0 == null || b0 == null) return false;
  return r.op === "crosses_above" ? a0 <= b0 && a > b : a0 >= b0 && a < b;
}

// ---------- validation (also used on the server for AI-made strategies) ----------
export function validateStrategy(s) {
  const err = (m) => ({ error: m });
  if (!s || typeof s !== "object") return err("strategy missing");
  const opnd = (o) => {
    if (!o || typeof o !== "object") return null;
    if ("value" in o) return Number.isFinite(+o.value) ? { value: +o.value } : null;
    if (!INDICATORS.includes(o.ind)) return null;
    const out = { ind: o.ind };
    if (NEEDS_N.has(o.ind)) { const n = Math.round(+o.n || (o.ind === "rsi" ? 14 : 20)); if (n < 2 || n > 400) return null; out.n = n; }
    if (o.ind.startsWith("bb_")) { const k = +(o.k ?? 2); if (!(k > 0 && k <= 5)) return null; out.k = k; }
    return out;
  };
  const rules = (arr) => { if (!Array.isArray(arr) || !arr.length || arr.length > 6) return null; const o = [];
    for (const r of arr) { const L = opnd(r?.left), R = opnd(r?.right); if (!L || !R || !OPS.includes(r.op)) return null; o.push({ left: L, op: r.op, right: R }); } return o; };
  const entry = rules(s.entry?.all), exit = s.exit?.any?.length ? rules(s.exit.any) : [];
  if (!entry) return err("entry rules theek nahi (1 se 6 niyam chahiye)");
  if (exit == null) return err("exit rules theek nahi");
  const pct = (x, max) => (x == null || x === "" ? null : Number.isFinite(+x) && +x > 0 && +x <= max ? +x : NaN);
  const sl = pct(s.stopLossPct, 50), tp = pct(s.takeProfitPct, 500), mh = s.maxHoldBars == null || s.maxHoldBars === "" ? null : Math.round(+s.maxHoldBars);
  if (Number.isNaN(sl) || Number.isNaN(tp)) return err("stop-loss / target % theek nahi");
  if (mh != null && !(mh >= 1 && mh <= 10000)) return err("max hold candles theek nahi");
  if (!exit.length && sl == null && tp == null && mh == null) return err("bahar nikalne ka koi niyam nahi (exit rule, stop-loss, target ya max hold)");
  return { strategy: { name: String(s.name || "Custom strategy").slice(0, 80), entry: { all: entry }, exit: { any: exit }, stopLossPct: sl, takeProfitPct: tp, maxHoldBars: mh } };
}

// ---------- ready-made strategies ----------
export const TEMPLATES = {
  sma_cross: { label: "SMA crossover", params: { fast: 20, slow: 50 },
    build: ({ fast, slow }) => ({ name: `SMA ${fast}/${slow} crossover`, entry: { all: [{ left: { ind: "sma", n: fast }, op: "crosses_above", right: { ind: "sma", n: slow } }] }, exit: { any: [{ left: { ind: "sma", n: fast }, op: "crosses_below", right: { ind: "sma", n: slow } }] } }) },
  ema_cross: { label: "EMA crossover", params: { fast: 9, slow: 21 },
    build: ({ fast, slow }) => ({ name: `EMA ${fast}/${slow} crossover`, entry: { all: [{ left: { ind: "ema", n: fast }, op: "crosses_above", right: { ind: "ema", n: slow } }] }, exit: { any: [{ left: { ind: "ema", n: fast }, op: "crosses_below", right: { ind: "ema", n: slow } }] } }) },
  rsi: { label: "RSI oversold / overbought", params: { period: 14, buyBelow: 30, sellAbove: 70 },
    build: ({ period, buyBelow, sellAbove }) => ({ name: `RSI ${period}: buy < ${buyBelow}, sell > ${sellAbove}`, entry: { all: [{ left: { ind: "rsi", n: period }, op: "<", right: { value: buyBelow } }] }, exit: { any: [{ left: { ind: "rsi", n: period }, op: ">", right: { value: sellAbove } }] } }) },
  breakout: { label: "Breakout (N-candle high)", params: { entryN: 20, exitN: 10 },
    build: ({ entryN, exitN }) => ({ name: `Breakout ${entryN}/${exitN}`, entry: { all: [{ left: { ind: "close" }, op: ">", right: { ind: "highest", n: entryN } }] }, exit: { any: [{ left: { ind: "close" }, op: "<", right: { ind: "lowest", n: exitN } }] } }) },
  bollinger: { label: "Bollinger reversal", params: { period: 20, k: 2 },
    build: ({ period, k }) => ({ name: `Bollinger ${period},${k} reversal`, entry: { all: [{ left: { ind: "close" }, op: "<", right: { ind: "bb_lower", n: period, k } }] }, exit: { any: [{ left: { ind: "close" }, op: ">", right: { ind: "bb_mid", n: period, k } }] } }) },
};

// ---------- simulation ----------
// bars: [{time, open, high, low, close, volume}] oldest first. opts: { capital, costPct (per side, %) }
export function backtest(bars, strategy, { capital = 100000, costPct = 0.05 } = {}) {
  const { strategy: s, error } = validateStrategy(strategy);
  if (error) return { error };
  const cache = new Map(), trades = [], equity = [], cost = costPct / 100;
  let cash = capital, pos = null, pending = null, peak = capital, maxDD = 0, inBars = 0;
  const exitAt = (i, price, reason) => {
    const gross = pos.qty * price, fee = gross * cost; cash += gross - fee;
    const pnl = gross - fee - pos.spent;
    trades.push({ entryTime: pos.time, entryPrice: pos.price, exitTime: bars[i].time, exitPrice: price, qty: pos.qty, pnl, pnlPct: (pnl / pos.spent) * 100, bars: i - pos.i, reason });
    pos = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (pending && i > 0) {                                  // fill yesterday's signal at today's open
      if (pending === "buy" && !pos) { const price = b.open, qty = Math.floor((cash / (1 + cost)) / price);
        if (qty > 0) { const spent = qty * price * (1 + cost); cash -= spent; pos = { qty, price, spent, time: b.time, i }; } }
      else if (pending === "sell" && pos) exitAt(i, b.open, "exit rule");
      else if (pending === "time" && pos) exitAt(i, b.open, "max hold");
      pending = null;
    }
    if (pos) {                                              // stop-loss / target inside this candle
      const sl = s.stopLossPct != null ? pos.price * (1 - s.stopLossPct / 100) : null, tp = s.takeProfitPct != null ? pos.price * (1 + s.takeProfitPct / 100) : null;
      if (sl != null && b.low <= sl) exitAt(i, Math.min(b.open, sl), "stop-loss");
      else if (tp != null && b.high >= tp) exitAt(i, Math.max(b.open, tp), "target");
    }
    if (i < bars.length - 1) {
      if (!pos && s.entry.all.every((r) => test(bars, r, i, cache))) pending = "buy";
      else if (pos && s.exit.any.some((r) => test(bars, r, i, cache))) pending = "sell";
      else if (pos && s.maxHoldBars != null && i - pos.i + 1 >= s.maxHoldBars) pending = "time";
    }
    if (pos) inBars++;
    const eq = cash + (pos ? pos.qty * b.close : 0);
    equity.push({ time: b.time, value: eq });
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak ? (peak - eq) / peak * 100 : 0);
  }
  let open = null;
  if (pos) { const last = bars[bars.length - 1]; open = { entryTime: pos.time, entryPrice: pos.price, qty: pos.qty, lastPrice: last.close, pnlPct: ((pos.qty * last.close * (1 - cost) - pos.spent) / pos.spent) * 100 }; }
  const end = equity.length ? equity[equity.length - 1].value : capital;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const first = bars[0]?.close, last = bars[bars.length - 1]?.close;
  return {
    strategy: s, trades, open, equity,
    stats: {
      capital, endValue: end, returnPct: (end / capital - 1) * 100, buyHoldPct: first ? (last / first - 1) * 100 : 0,
      trades: trades.length, winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      avgWinPct: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
      avgLossPct: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
      profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, maxDrawdownPct: maxDD, exposurePct: bars.length ? (inBars / bars.length) * 100 : 0,
    },
  };
}

// Plain-words description of a strategy (shown on the page and sent to the AI)
const NAMES = { close: "Close", open: "Open", high: "High", low: "Low", volume: "Volume", sma: "SMA", ema: "EMA", rsi: "RSI", bb_upper: "Bollinger upper", bb_mid: "Bollinger middle", bb_lower: "Bollinger lower", highest: "pichhle N ka High", lowest: "pichhle N ka Low", sma_volume: "Avg volume" };

export function describeOperand(o) { if ("value" in o) return String(o.value); const n = o.n ? `(${o.n}${o.ind.startsWith("bb_") ? "," + o.k : ""})` : ""; return (NAMES[o.ind] || o.ind).replace("N", o.n ?? "N") + (o.ind === "highest" || o.ind === "lowest" ? "" : n); }
export function describeRule(r) {
  const L = describeOperand(r.left), R = describeOperand(r.right);
  return r.op === "crosses_above" ? `${L} ne ${R} ko upar cross kiya` : r.op === "crosses_below" ? `${L} ne ${R} ko neeche cross kiya` : `${L} ${r.op} ${R}`;
}
