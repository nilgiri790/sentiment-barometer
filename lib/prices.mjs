// Prices for the dashboard. Zerodha Kite (real time) when it is connected today, else Yahoo Finance (~15 min delay).
//   /api/search?q=zomato              -> matching symbols, NSE first
//   /api/price?sym=TCS.NS&range=1mo   -> {symbol, source, points:[[ms, close]], last, prevClose, high, low, notice?}
import { kiteTokenValid } from "./secrets.mjs";
import { searchOptions, optionInfo, optionChain, parseOptionQuery } from "./options.mjs";

export const RANGES = ["1d", "5d", "1mo"];
const IST = 5.5 * 36e5;
export const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
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
// "BANKNIFTY25NOV52000CE.NFO" -> "NFO:BANKNIFTY25NOV52000CE" (index options, see lib/options.mjs).
export const toKite = (sym) => {
  const m = /^(.+)\.(NS|BO|NFO)$/i.exec(sym); if (!m) return null;
  return `${{ NS: "NSE", BO: "BSE", NFO: "NFO" }[m[2].toUpperCase()]}:${m[1].toUpperCase()}`;
};
export const isOptionSym = (sym) => /\.NFO$/i.test(sym);

export class KiteError extends Error {}
export async function kite(path, k, fetchImpl, timeoutMs = 4000) {
  const r = await fetchImpl("https://api.kite.trade" + path, {
    headers: { "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}` }, signal: AbortSignal.timeout(timeoutMs) });
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

// ---------------- Candles for the full chart page ----------------
// Kite historical intervals -> how many days to load (kept within Kite's per-request limits).
export const KITE_INTERVALS = { minute: 4, "3minute": 10, "5minute": 15, "10minute": 30, "15minute": 45, "30minute": 60, "60minute": 120, day: 730 };
const Y_CANDLE = { minute: ["1m", "5d"], "5minute": ["5m", "1mo"], "15minute": ["15m", "1mo"], "30minute": ["30m", "1mo"], "60minute": ["60m", "3mo"], day: ["1d", "2y"] };

// -> { candles: [[epochSec, open, high, low, close, volume]], instrument_token, last, prevClose, source }
export async function kiteCandles(sym, interval, k, fetchImpl = fetch, now = Date.now()) {
  const ins = toKite(sym);
  if (!ins || !KITE_INTERVALS[interval]) return null;
  const q = (await kite(`/quote?i=${encodeURIComponent(ins)}`, k, fetchImpl)).data?.[ins];
  if (!q?.instrument_token) return null;
  const from = istStamp(now - KITE_INTERVALS[interval] * 864e5), to = istStamp(now);
  const h = await kite(`/instruments/historical/${q.instrument_token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, k, fetchImpl, 8000);
  const candles = (h.data?.candles || []).map((x) => [Math.floor(candleMs(x[0]) / 1000), +x[1], +x[2], +x[3], +x[4], +(x[5] || 0)])
    .filter((x) => Number.isFinite(x[0]) && x.slice(1, 5).every(Number.isFinite));
  return { symbol: sym, source: "Zerodha", interval, instrument_token: q.instrument_token, last: q.last_price ?? null,
           prevClose: q.ohlc?.close ?? null, candles };
}

export async function yahooCandles(sym, interval, fetchImpl = fetch) {
  const m = Y_CANDLE[interval]; if (!m) return null;
  const d = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${m[1]}&interval=${m[0]}`, fetchImpl);
  const r = d.chart?.result?.[0]; if (!r?.timestamp) return null;
  const q = r.indicators.quote[0], candles = [];
  r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every((v) => v != null)) candles.push([t, q.open[i], q.high[i], q.low[i], q.close[i], q.volume?.[i] || 0]); });
  return { symbol: sym, source: "Yahoo", interval, instrument_token: null, last: candles.at(-1)?.[4] ?? null, prevClose: r.meta?.chartPreviousClose ?? null, candles };
}

// NSE equity + index list from Zerodha, refreshed once a day, used for search. Rows: [symbol, name, kind]
// kind "EQ" = share (tradable), "IDX" = index such as NIFTY BANK (price only, cannot be bought directly).
export function parseInstruments(csv) {
  const lines = csv.split(/\r?\n/), head = lines.shift()?.split(",") || [];
  const col = (n) => head.indexOf(n), iS = col("tradingsymbol"), iN = col("name"), iT = col("instrument_type"), iSeg = col("segment");
  const split = (l) => { const o = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(cur); cur = ""; } else cur += ch; }
    o.push(cur); return o; };
  const rows = [];
  for (const l of lines) {
    if (!l) continue; const f = split(l);
    if (f[iT] === "EQ" && f[iSeg] === "NSE") rows.push([f[iS], f[iN] || "", "EQ"]);
    else if (f[iSeg] === "INDICES") rows.push([f[iS], f[iN] || f[iS], "IDX"]);
  }
  return rows;
}

// Common ways people type index names -> Zerodha's index symbol.
export const INDEX_ALIASES = {
  BANKNIFTY: "NIFTY BANK", NIFTYBANK: "NIFTY BANK", BANKNIFTI: "NIFTY BANK", NIFTY: "NIFTY 50", NIFTY50: "NIFTY 50",
  FINNIFTY: "NIFTY FIN SERVICE", NIFTYFIN: "NIFTY FIN SERVICE", MIDCPNIFTY: "NIFTY MID SELECT", VIX: "INDIA VIX", INDIAVIX: "INDIA VIX",
  NIFTYIT: "NIFTY IT", NIFTYPHARMA: "NIFTY PHARMA", NIFTYAUTO: "NIFTY AUTO", NIFTYMETAL: "NIFTY METAL", NIFTYFMCG: "NIFTY FMCG",
};
// Yahoo symbols for the main indices (used only when Zerodha is not connected).
const INDEX_YAHOO = { "NIFTY 50": "^NSEI", "NIFTY BANK": "^NSEBANK", "NIFTY IT": "^CNXIT", "INDIA VIX": "^INDIAVIX", "NIFTY FIN SERVICE": "NIFTY_FIN_SERVICE.NS" };
const KNOWN_INDEX = new Set([...Object.values(INDEX_ALIASES), ...Object.keys(INDEX_YAHOO)]);

async function nseList(k, cache, fetchImpl, now) {
  let list = cache ? await cache.get("kite-nse-v2", { type: "json" }) : null;
  if (!list || list.day !== istDate(now)) {
    list = { day: istDate(now), rows: parseInstruments(await kite("/instruments/NSE", k, fetchImpl)) };
    if (cache && list.rows.length) await cache.setJSON("kite-nse-v2", list);
  }
  return list;
}

export async function kiteSearch(q, k, cache, fetchImpl = fetch, now = Date.now()) {
  const list = await nseList(k, cache, fetchImpl, now);
  const Q = q.toUpperCase().replace(/\s+/g, " ").trim(), Qs = Q.replace(/ /g, "");
  const alias = Object.entries(INDEX_ALIASES).filter(([a]) => a.startsWith(Qs) && Qs.length >= 3).map(([, v]) => v);
  const rank = ([s, n, kind]) => {
    const S = s.replace(/ /g, ""), N = n.toUpperCase();
    if (alias.includes(s)) return 0;                       // BANKNIFTY -> NIFTY BANK
    if (S === Qs) return kind === "IDX" ? 0 : 1;
    if (S.startsWith(Qs)) return 2;
    if (N.startsWith(Q)) return 3;
    if (N.split(/[ .&-]+/).some((w) => w.startsWith(Q))) return 4;   // any word starts with what was typed
    if (N.includes(Q) || S.includes(Qs)) return 5;
    return 9;
  };
  return list.rows.map((r) => [rank(r), r]).filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0] || (a[1][2] === "IDX" ? -1 : 0) - (b[1][2] === "IDX" ? -1 : 0) || a[1][0].length - b[1][0].length)
    .slice(0, 10).map(([, [s, n, kind]]) => ({ symbol: s + ".NS", name: n, exchange: kind === "IDX" ? "NSE INDEX" : "NSE", index: kind === "IDX" }));
}

// Is this symbol an index (price only)? Uses the daily Zerodha list when available, else the known names.
async function isIndex(sym, k, cache, fetchImpl, now) {
  if (!/\.(NS|BO)$/i.test(sym)) return false;                       // only Indian symbols can be NSE indices
  const base = sym.replace(/\.(NS|BO)$/i, "").toUpperCase();
  if (KNOWN_INDEX.has(base)) return true;
  try { if (k) return (await nseList(k, cache, fetchImpl, now)).rows.some(([s, , kind]) => kind === "IDX" && s === base); } catch {}
  return false;
}

// ---------------- request handler ----------------
export async function handlePrice(req, { secrets = {}, cache = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const u = new URL(req.url), k = secrets.kite, useKite = kiteReady(k);
  try {
    if (u.pathname.endsWith("/search")) {
      const q = (u.searchParams.get("q") || "").trim().slice(0, 60);
      if (!q) return json([], 200, 600);
      if (useKite && parseOptionQuery(q)?.wants) {               // "banknifty 52000 ce" -> option contracts
        try { const r = await searchOptions(q, k, cache, fetchImpl, now); if (r.length) return json(r, 200, 300); } catch {}
      }
      if (useKite) { try { const r = await kiteSearch(q, k, cache, fetchImpl, now); if (r.length) return json(r, 200, 600); } catch {} }
      return json(await yahooSearch(q, fetchImpl), 200, 600);
    }
    if (u.pathname.endsWith("/candles")) {
      const sym = (u.searchParams.get("sym") || "").trim().slice(0, 30), interval = u.searchParams.get("interval") || "minute";
      if (!/^[\w.\-^=& ]+$/.test(sym) || !KITE_INTERVALS[interval]) return json({ error: "bad request" }, 400, 0);
      const maxAge = interval === "day" ? 300 : 15;
      if (useKite) {
        try { const c = await kiteCandles(sym, interval, k, fetchImpl, now); if (c) return json(c, 200, maxAge); }
        catch (e) { if (isOptionSym(sym)) return json({ error: e.message }, 502, 0); }
      }
      if (isOptionSym(sym)) return json({ error: "Options ka chart sirf Zerodha se aata hai. API Keys mein 'Login with Zerodha' kariye." }, 400, 0);
      const idx = await isIndex(sym, null, cache, fetchImpl, now);
      const ysym = idx ? INDEX_YAHOO[sym.replace(/\.(NS|BO)$/i, "").toUpperCase()] : sym;
      const c = ysym ? await yahooCandles(ysym, interval, fetchImpl) : null;
      if (!c) return json({ error: "Is timeframe ka data nahi mila." }, 404, 0);
      return json({ ...c, symbol: sym, notice: "Zerodha login nahi hai, isliye Yahoo se (15 min late)." }, 200, maxAge);
    }
    if (u.pathname.endsWith("/context")) {                    // Scalping market context: VIX, future, heavyweights, levels
      if (!useKite) return json({ error: "Market context sirf Zerodha se aata hai. API Keys mein 'Login with Zerodha' kariye." }, 400, 0);
      const { marketContext } = await import("./context.mjs");
      return json(await marketContext((u.searchParams.get("u") || "").toUpperCase(), k, cache, fetchImpl, now), 200, 30);
    }
    if (u.pathname.endsWith("/chain")) {
      if (!useKite) return json({ error: "Option chain sirf Zerodha se aati hai. API Keys mein 'Login with Zerodha' kariye." }, 400, 0);
      const und = (u.searchParams.get("u") || "").toUpperCase(), exp = u.searchParams.get("expiry") || "";
      return json(await optionChain({ underlying: und, expiry: exp, n: 10 }, k, cache, fetchImpl, now), 200, 15);
    }
    const sym = (u.searchParams.get("sym") || "").trim().slice(0, 30);
    const range = RANGES.includes(u.searchParams.get("range")) ? u.searchParams.get("range") : "1mo";
    if (!/^[\w.\-^=& ]+$/.test(sym)) return json({ error: "bad symbol" }, 400);
    if (isOptionSym(sym)) {                                     // index option: Zerodha only (Yahoo has no Indian options)
      if (!useKite) return json({ error: "Options ke daam sirf Zerodha se aate hain. API Keys mein 'Login with Zerodha' kariye." }, 400, 0);
      const meta = await optionInfo(sym, k, cache, fetchImpl, now);
      if (!meta) return json({ error: "Ye option contract nahi mila (shayad expire ho gaya)." }, 404, 0);
      const p = await kitePrice(sym, range, k, fetchImpl, now);
      return p ? json({ ...p, option: meta }, 200, 15) : json({ error: "no price data" }, 404, 0);
    }
    const idx = await isIndex(sym, useKite ? k : null, cache, fetchImpl, now);
    const tag = (p) => (idx ? { ...p, index: true } : p);
    let notice = null;
    if (useKite && toKite(sym)) {
      try { const p = await kitePrice(sym, range, k, fetchImpl, now); if (p) return json(tag(p), 200, range === "1mo" ? 300 : 15); notice = "Zerodha par ye symbol nahi mila, Yahoo se dikha rahe hain."; }
      catch (e) { notice = (e instanceof KiteError ? e.message : "Zerodha se jawab nahi aaya") + " Abhi Yahoo se dikha rahe hain."; }
    } else if (k?.api_key && toKite(sym)) {
      notice = "Aaj Zerodha login nahi hua, isliye Yahoo se (15 min late). Manage API Keys mein 'Login with Zerodha' dabaiye.";
    }
    const ysym = idx ? INDEX_YAHOO[sym.replace(/\.(NS|BO)$/i, "").toUpperCase()] : sym;
    const p = ysym ? await yahooPrice(ysym, range, fetchImpl) : null;
    if (!p) return json({ error: notice || "no price data" }, 404);
    if (ysym !== sym) p.symbol = sym;
    return json(tag(notice ? { ...p, notice } : p));
  } catch (e) {
    return json({ error: e.message }, 502, 0);
  }
}
