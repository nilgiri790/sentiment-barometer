// Market context for the Scalping page (GET /api/context?u=BANKNIFTY|NIFTY): India VIX, the current-month index future,
// the index's heavyweight shares, the previous day's high / low / close with CPR and pivot levels. One Kite /quote call +
// one day-candles call. The page then keeps VIX, the future and the heavyweights live over its WebSocket.
import { kite, istDate } from "./prices.mjs";
import { nearFuture } from "./options.mjs";

export const CONTEXT_INDEX = { BANKNIFTY: "NIFTY BANK", NIFTY: "NIFTY 50" };
// biggest members (by index weight; the order is approximate and the list can change at index rebalancing)
export const HEAVYWEIGHTS = {
  BANKNIFTY: ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK"],
  NIFTY: ["HDFCBANK", "RELIANCE", "ICICIBANK", "INFY", "BHARTIARTL", "TCS", "LT", "ITC"],
};
const r2 = (x) => Math.round(x * 100) / 100;

// previous day H/L/C -> CPR (central pivot range) and classic pivots
export function levelsFrom({ h, l, c }) {
  const P = (h + l + c) / 3, B = (h + l) / 2, T = 2 * P - B;
  return { cpr: { p: r2(P), bc: r2(Math.min(B, T)), tc: r2(Math.max(B, T)) }, pivots: { r1: r2(2 * P - l), s1: r2(2 * P - h), r2: r2(P + (h - l)), s2: r2(P - (h - l)) } };
}

export async function marketContext(u, k, cache, fetchImpl = fetch, now = Date.now()) {
  const idx = CONTEXT_INDEX[u];
  if (!idx) throw new Error("sirf BANKNIFTY / NIFTY");
  const fut = await nearFuture(u, k, cache, fetchImpl, now).catch(() => null);
  const ins = [`NSE:${idx}`, "NSE:INDIA VIX", ...(fut ? [`NFO:${fut[0]}`] : []), ...HEAVYWEIGHTS[u].map((s) => `NSE:${s}`)];
  const q = (await kite(`/quote?${ins.map((i) => "i=" + encodeURIComponent(i)).join("&")}`, k, fetchImpl, 6000)).data || {};
  const pick = (i) => { const d = q[i]; return d ? { token: d.instrument_token ?? null, last: d.last_price ?? null, prevClose: d.ohlc?.close ?? null, open: d.ohlc?.open ?? null } : null; };
  const index = pick(`NSE:${idx}`) || {};
  let prevDay = null;
  if (index.token) {                                         // last finished day before today (India date)
    const fmt = (ms) => new Date(ms + 19800e3).toISOString().slice(0, 19).replace("T", " ");
    try {
      const h = await kite(`/instruments/historical/${index.token}/day?from=${encodeURIComponent(fmt(now - 12 * 864e5))}&to=${encodeURIComponent(fmt(now))}`, k, fetchImpl, 5000);
      const today = istDate(now), rows = (h.data?.candles || []).filter((c) => String(c[0]).slice(0, 10) < today);
      const d = rows.at(-1); if (d) prevDay = { date: String(d[0]).slice(0, 10), h: d[2], l: d[3], c: d[4] };
    } catch {}
  }
  const fq = fut ? q[`NFO:${fut[0]}`] : null;
  return {
    underlying: u, at: new Date(now).toISOString(),
    index: { name: idx, symbol: `${idx}.NS`, ...index, prevDay, ...(prevDay ? levelsFrom(prevDay) : {}) },
    vix: pick("NSE:INDIA VIX"),
    fut: fut && fq ? { symbol: `${fut[0]}.NFO`, expiry: fut[2], lot: fut[3], token: fq.instrument_token ?? fut[4], last: fq.last_price ?? null, prevClose: fq.ohlc?.close ?? null,
      oi: fq.oi ?? null, avg: fq.average_price ?? null } : null,
    heavy: HEAVYWEIGHTS[u].map((s) => ({ sym: s, ...(pick(`NSE:${s}`) || {}) })).filter((x) => x.token),
  };
}
