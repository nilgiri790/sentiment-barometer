// Prices for the dashboard. Zerodha Kite (real time) when it is connected today, else Yahoo Finance (~15 min delay).
//   /api/search?q=zomato              -> matching symbols, NSE first
//   /api/price?sym=TCS.NS&range=1mo   -> {symbol, source, points:[[ms, close]], last, prevClose, high, low, notice?}
import { kiteTokenValid } from "./secrets.mjs";

export const RANGES = ["1d", "5d", "1mo"];
const IST = 5.5 * 36e5;
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const istStamp = (ms) => new Date(ms + IST).toISOString().slice(0, 19).replace("T", " "); // what Kite expects
const json = (body, status = 200, maxAge = 60) =>
  Response.json(body, { status, headers: { "cache-control": `public, max-age=${maxAge}` } });

// ---------------- Yahoo ----------------
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" };
const Y_INTERVAL = { "1d": "5m", "5d": "15m", "1mo": "1d" };

async function yahoo(path, fetchImpl) {
  let r;
  for (const host of ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]) {
    r = await fetchImpl(host + path, { headers: UA, signal: AbortSignal.timeout(4000) });
    if (r.status !== 429) break;          // rate limited on one host: try the other one
  }
  if (!r.ok) throw new Error(`Yahoo answered ${r.status}`);
  return r.json();
}

export async function yahooSearch(q, fetchImpl = fetch) {
  const d = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`, fetchImpl);
  const out = (d.quotes || []).filter((x) => x.symbol).map((x) => ({
    symbol: x.symbol, name: x.shortname || x.longname || "", exchange: x.exchDisp || x.exchange || "" }));
  out.sort((a, b) => (/\.(NS|BO)$/.test(a.symbol) ? 0 : 1) - (/\.(NS|BO)$/.test(b.symbol) ? 0 : 1));
  return out;
}

export async function yahooPrice(sym, range, fetchImpl = fetch) {
  const [d, daily] = await Promise.all([
    yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${Y_INTERVAL[range]}`, fetchImpl),
    yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, fetchImpl),
  ]);
  const res = d.chart?.result?.[0];
  if (!res?.timestamp) return null;
  const q = res.indicators.quote[0], points = [];
  res.timestamp.forEach((t, i) => q.close[i] != null && points.push([t * 1000, +q.close[i].toFixed(2)]));
  if (!points.length) return null;
  const dc = (daily.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  return {
    symbol: sym, source: "Yahoo", currency: res.meta?.currency || "", points,
    last: points.at(-1)[1], prevClose: dc.length >= 2 ? dc.at(-2) : null,
    high: Math.max(...q.high.filter((x) => x != null)), low: Math.min(...q.low.filter((x) => x != null)),
  };
}

// ---------------- Zerodha Kite ----------------
export const kiteReady = (k) => !!(k?.api_key && k?.access_token && kiteTokenValid(k.token_at));
// "TCS.NS" -> "NSE:TCS", "500325.BO"/"RELIANCE.BO" -> "BSE:...". Anything else is not on Kite.
export const toKite = (sym) => { const m = /^(.+)\.(NS|BO)$/i.exec(sym); return m ? `${m[2].toUpperCase() === "NS" ? "NSE" : "BSE"}:${m[1].toUpperCase()}` : null; };

class KiteError extends Error {}
async function kite(path, k, fetchImpl) {
  const r = await fetchImpl("https://api.kite.trade" + path, {
    headers: { "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}` }, signal: AbortSignal.timeout(4000) });
  if (r.status === 403) throw new KiteError("Zerodha login expire ho gaya. Manage API Keys mein 'Login with Zerodha' dabaiye.");
  if (!r.ok) throw new KiteError(`Zerodha answered ${r.status}`);
  return path.startsWith("/instruments/") && !path.includes("historical") ? r.text() : r.json();
}

// Kite candle time looks like "2026-11-04T09:15:00+0530"
const candleMs = (s) => Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));

export async function kitePrice(sym, range, k, fetchImpl = fetch, now = Date.now()) {
  const ins = toKite(sym);
  if (!ins) return null;
  const q = (await kite(`/quote?i=${encodeURIComponent(ins)}`, k, fetchImpl)).data?.[ins];
  if (!q?.instrument_token) return null;                    // symbol not known to Zerodha
  const [interval, days] = { "1d": ["5minute", 6], "5d": ["15minute", 12], "1mo": ["day", 32] }[range];
  const h = await kite(`/instruments/historical/${q.instrument_token}/${interval}?from=${encodeURIComponent(istStamp(now - days * 864e5))}&to=${encodeURIComponent(istStamp(now))}`, k, fetchImpl);
  let c = (h.data?.candles || []).map((x) => [candleMs(x[0]), x[2], x[3], x[4]]).filter((x) => Number.isFinite(x[0]));
  if (interval === "day") c = c.map((x) => [x[0] + 9.25 * 36e5, x[1], x[2], x[3]]);  // day candles: put at market open, IST
  if (range === "1d" && c.length) { const last = istDate(c.at(-1)[0]); c = c.filter((x) => istDate(x[0]) === last); }
  if (range === "5d") { const ds = [...new Set(c.map((x) => istDate(x[0])))].slice(-5); c = c.filter((x) => ds.includes(istDate(x[0]))); }
  const points = c.map((x) => [x[0], +(+x[3]).toFixed(2)]);
  const last = q.last_price ?? points.at(-1)?.[1];
  if (last == null) return null;
  if (range !== "1mo" && points.length) points.push([now, +(+last).toFixed(2)]);   // live tip
  if (!points.length) points.push([now, last]);
  return {
    symbol: sym, source: "Zerodha", currency: "INR", points, last, prevClose: q.ohlc?.close ?? null,
    high: Math.max(...c.map((x) => x[1]), last), low: Math.min(...c.map((x) => x[2]), last),
  };
}

// NSE equity list from Zerodha, refreshed once a day, used for search.
export function parseInstruments(csv) {
  const lines = csv.split(/\r?\n/), head = lines.shift()?.split(",") || [];
  const col = (n) => head.indexOf(n), iS = col("tradingsymbol"), iN = col("name"), iT = col("instrument_type"), iSeg = col("segment");
  const split = (l) => { const o = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(cur); cur = ""; } else cur += ch; }
    o.push(cur); return o; };
  const rows = [];
  for (const l of lines) { if (!l) continue; const f = split(l); if (f[iT] === "EQ" && f[iSeg] === "NSE") rows.push([f[iS], f[iN] || ""]); }
  return rows;
}

export async function kiteSearch(q, k, cache, fetchImpl = fetch, now = Date.now()) {
  let list = cache ? await cache.get("kite-nse", { type: "json" }) : null;
  if (!list || list.day !== istDate(now)) {
    list = { day: istDate(now), rows: parseInstruments(await kite("/instruments/NSE", k, fetchImpl)) };
    if (cache && list.rows.length) await cache.setJSON("kite-nse", list);
  }
  const Q = q.toUpperCase().replace(/\s+/g, " ").trim(), Qs = Q.replace(/ /g, "");
  const rank = ([s, n]) => s === Qs ? 0 : s.startsWith(Qs) ? 1 : n.toUpperCase().startsWith(Q) ? 2 : n.toUpperCase().includes(Q) ? 3 : s.includes(Qs) ? 4 : 9;
  return list.rows.map((r) => [rank(r), r]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || a[1][0].length - b[1][0].length)
    .slice(0, 10).map(([, [s, n]]) => ({ symbol: s + ".NS", name: n, exchange: "NSE" }));
}

// ---------------- request handler ----------------
export async function handlePrice(req, { secrets = {}, cache = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const u = new URL(req.url), k = secrets.kite, useKite = kiteReady(k);
  try {
    if (u.pathname.endsWith("/search")) {
      const q = (u.searchParams.get("q") || "").trim().slice(0, 60);
      if (!q) return json([], 200, 600);
      if (useKite) { try { const r = await kiteSearch(q, k, cache, fetchImpl, now); if (r.length) return json(r, 200, 600); } catch {} }
      return json(await yahooSearch(q, fetchImpl), 200, 600);
    }
    const sym = (u.searchParams.get("sym") || "").trim().slice(0, 30);
    const range = RANGES.includes(u.searchParams.get("range")) ? u.searchParams.get("range") : "1mo";
    if (!/^[\w.\-^=&]+$/.test(sym)) return json({ error: "bad symbol" }, 400);
    let notice = null;
    if (useKite && toKite(sym)) {
      try { const p = await kitePrice(sym, range, k, fetchImpl, now); if (p) return json(p, 200, range === "1mo" ? 300 : 15); notice = "Zerodha par ye symbol nahi mila, Yahoo se dikha rahe hain."; }
      catch (e) { notice = (e instanceof KiteError ? e.message : "Zerodha se jawab nahi aaya") + " Abhi Yahoo se dikha rahe hain."; }
    } else if (k?.api_key && toKite(sym)) {
      notice = "Aaj Zerodha login nahi hua, isliye Yahoo se (15 min late). Manage API Keys mein 'Login with Zerodha' dabaiye.";
    }
    const p = await yahooPrice(sym, range, fetchImpl);
    if (!p) return json({ error: notice || "no price data" }, 404);
    return json(notice ? { ...p, notice } : p);
  } catch (e) {
    return json({ error: e.message }, 502, 0);
  }
}
