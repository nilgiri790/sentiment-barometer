// Option analytics for the Scalping AI panel. Pure functions (browser + tests), no network.
// Greeks: Black-Scholes on the index spot (no dividends), r = 6.5 %, expiry at 15:30 IST. Zerodha gives no Greeks,
// so these are our own estimates and can differ a little from NSE / other apps.
import { ema, rsi } from "./btengine.mjs";

export const RATE = 0.065;
const SQ2PI = Math.sqrt(2 * Math.PI);
const pdf = (x) => Math.exp(-0.5 * x * x) / SQ2PI;
function cdf(x) {                                          // Abramowitz-Stegun 26.2.17 (error < 7.5e-8)
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = pdf(x);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// years from now to expiry day 15:30 IST (expiry "YYYY-MM-DD")
export function yearsToExpiry(expiry, now = Date.now()) {
  const end = Date.parse(`${expiry}T15:30:00+05:30`);
  return Math.max(0, end - now) / (365 * 864e5);
}

export function bsPrice(S, K, T, sigma, type, r = RATE) {
  if (!(S > 0 && K > 0)) return null;
  if (!(T > 0) || !(sigma > 0)) return Math.max(0, type === "CE" ? S - K : K - S);
  const v = sigma * Math.sqrt(T), d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / v, d2 = d1 - v;
  return type === "CE" ? S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2) : K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
}

// implied volatility by bisection (0.5 % .. 300 %); null when the price is below intrinsic value or not usable
export function impliedVol(price, S, K, T, type, r = RATE) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const intrinsic = Math.max(0, type === "CE" ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S);
  if (price <= intrinsic + 1e-6) return null;
  let lo = 0.005, hi = 3;
  if (bsPrice(S, K, T, hi, type, r) < price) return null;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (bsPrice(S, K, T, mid, type, r) > price) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

// delta, gamma, theta (rupees per calendar day), vega (rupees per 1 % IV)
export function greeks(S, K, T, sigma, type, r = RATE) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const sq = Math.sqrt(T), v = sigma * sq, d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / v, d2 = d1 - v, disc = Math.exp(-r * T);
  const delta = type === "CE" ? cdf(d1) : cdf(d1) - 1;
  const gamma = pdf(d1) / (S * v);
  const theta = (-(S * pdf(d1) * sigma) / (2 * sq) + (type === "CE" ? -r * K * disc * cdf(d2) : r * K * disc * cdf(-d2))) / 365;
  const vega = (S * pdf(d1) * sq) / 100;
  return { delta, gamma, theta, vega };
}
export function contractGreeks({ ltp, spot, strike, expiry, type }, now = Date.now()) {
  const T = yearsToExpiry(expiry, now), iv = impliedVol(ltp, spot, strike, T, type);
  const g = iv ? greeks(spot, strike, T, iv, type) : null;
  return { iv: iv ? r2(iv * 100) : null, delta: g ? r4(g.delta) : null, gamma: g ? +g.gamma.toPrecision(3) : null,
    theta: g ? r2(g.theta) : null, vega: g ? r2(g.vega) : null, daysToExpiry: r2(T * 365) };
}
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;

// OI build-up from a price change and an OI change (since a base snapshot)
export function buildup(dPrice, dOi) {
  if (!dOi || dPrice == null) return null;
  if (dPrice >= 0 && dOi > 0) return "long buildup";
  if (dPrice < 0 && dOi > 0) return "short buildup";
  if (dPrice >= 0 && dOi < 0) return "short covering";
  return "long unwinding";
}

// rows: [{strike, ce:{symbol, ltp, oi}, pe:{...}}]; base: Map symbol -> {ltp, oi} (snapshot to compare with)
export function chainSummary(rows, spot, expiry, base = new Map(), now = Date.now()) {
  const T = yearsToExpiry(expiry, now);
  let ceOi = 0, peOi = 0, ceBase = 0, peBase = 0, res = null, sup = null;
  const out = [], changes = [];
  for (const r of rows) {
    const side = (c, type) => {
      if (!c) return null;
      const b = base.get(c.symbol), dOi = c.oi != null && b?.oi != null ? c.oi - b.oi : null, dPx = c.ltp != null && b?.ltp != null ? r2(c.ltp - b.ltp) : null;
      const iv = spot ? impliedVol(c.ltp, spot, r.strike, T, type) : null;
      if (dOi) changes.push({ symbol: c.symbol, strike: r.strike, type, dOi, dPx, buildup: buildup(dPx, dOi) });
      const g = iv ? greeks(spot, r.strike, T, iv, type) : null;
      return { symbol: c.symbol, ltp: c.ltp, oi: c.oi, dOi, dPx, iv: iv ? r2(iv * 100) : null, delta: g ? r2(g.delta) : null, volume: c.volume ?? null };
    };
    const ce = side(r.ce, "CE"), pe = side(r.pe, "PE");
    ceOi += ce?.oi || 0; peOi += pe?.oi || 0; ceBase += base.get(r.ce?.symbol)?.oi ?? (ce?.oi || 0); peBase += base.get(r.pe?.symbol)?.oi ?? (pe?.oi || 0);
    if (ce?.oi && (!res || ce.oi > res.oi)) res = { strike: r.strike, oi: ce.oi };
    if (pe?.oi && (!sup || pe.oi > sup.oi)) sup = { strike: r.strike, oi: pe.oi };
    out.push({ strike: r.strike, ce, pe });
  }
  const atm = spot && rows.length ? rows.reduce((a, r) => (Math.abs(r.strike - spot) < Math.abs(a.strike - spot) ? r : a)).strike : null;
  const atmRow = out.find((r) => r.strike === atm);
  changes.sort((a, b) => Math.abs(b.dOi) - Math.abs(a.dOi));
  return {
    atm, pcr: ceOi ? r2(peOi / ceOi) : null, pcrBase: ceBase ? r2(peBase / ceBase) : null, maxPain: maxPain(rows),
    resistance: res?.strike ?? null, support: sup?.strike ?? null,
    atmIv: atmRow ? r2(((atmRow.ce?.iv ?? atmRow.pe?.iv ?? 0) + (atmRow.pe?.iv ?? atmRow.ce?.iv ?? 0)) / 2) || null : null,
    totalCeOi: ceOi, totalPeOi: peOi, rows: out, topChanges: changes.slice(0, 8),
  };
}

// strike where option buyers in total get the least (only over the strikes we have)
export function maxPain(rows) {
  let best = null;
  for (const k of rows) {
    let pay = 0;
    for (const r of rows) pay += (r.ce?.oi || 0) * Math.max(0, k.strike - r.strike) + (r.pe?.oi || 0) * Math.max(0, r.strike - k.strike);
    if (!best || pay < best.pay) best = { strike: k.strike, pay };
  }
  return best?.strike ?? null;
}

// bars: [{time, open, high, low, close, volume}] (time = IST-shifted seconds). Summary of common indicators.
export function indicatorSummary(bars) {
  if (!bars?.length) return null;
  const C = bars.map((b) => b.close), last = bars[bars.length - 1], n = bars.length;
  const e9 = ema(C, 9)[n - 1], e21 = ema(C, 21)[n - 1], rs = rsi(C, 14)[n - 1];
  let atr = null; if (n > 14) { let s = 0; for (let i = n - 14; i < n; i++) s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); atr = s / 14; }
  const day = Math.floor(last.time / 86400); let pv = 0, vv = 0, hi = -Infinity, lo = Infinity, open = null;
  for (const b of bars) if (Math.floor(b.time / 86400) === day) { open ??= b.open; const w = b.volume || 0; pv += ((b.high + b.low + b.close) / 3) * w; vv += w; hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
  const vwap = vv ? pv / vv : null;
  let bbPos = null; if (n >= 20) { const w = C.slice(-20), m = w.reduce((a, x) => a + x, 0) / 20, sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / 20); bbPos = sd ? r2((last.close - (m - 2 * sd)) / (4 * sd)) : null; }
  const ago = (k) => (n > k ? r2(last.close - bars[n - 1 - k].close) : null);
  const trend = e9 != null && e21 != null ? (e9 > e21 && (vwap == null || last.close >= vwap) ? "up" : e9 < e21 && (vwap == null || last.close <= vwap) ? "down" : "sideways") : null;
  const f = (x) => (x == null || !Number.isFinite(x) ? null : r2(x));
  return { close: f(last.close), ema9: f(e9), ema21: f(e21), rsi14: f(rs), vwap: f(vwap), atr14: f(atr), bbPos, trend,
    chg5: ago(5), chg15: ago(15), dayOpen: f(open), dayHigh: f(hi === -Infinity ? null : hi), dayLow: f(lo === Infinity ? null : lo) };
}

// merge 1-minute bars into k-minute bars
export function resample(bars, sec) {
  const out = [];
  for (const b of bars) { const t = Math.floor(b.time / sec) * sec, l = out[out.length - 1];
    if (l && l.time === t) { l.high = Math.max(l.high, b.high); l.low = Math.min(l.low, b.low); l.close = b.close; l.volume += b.volume || 0; }
    else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }); }
  return out;
}
export const compact = (bars, k) => bars.slice(-k).map((b) => [new Date(b.time * 1000).toISOString().slice(11, 16), b.open, b.high, b.low, b.close, b.volume || 0]);
