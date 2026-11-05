// Index options (F&O) for BANKNIFTY, NIFTY, FINNIFTY, MIDCPNIFTY from Zerodha's daily NFO instrument list.
// Used by: search (type "banknifty 52000 ce"), the price view, the option chain and order checks.
import { kite, istDate } from "./prices.mjs";

export const UNDERLYINGS = {            // option underlying -> its index symbol on NSE (for the spot price)
  BANKNIFTY: "NIFTY BANK", NIFTY: "NIFTY 50", FINNIFTY: "NIFTY FIN SERVICE", MIDCPNIFTY: "NIFTY MID SELECT",
};
export const INDEX_TO_UNDERLYING = Object.fromEntries(Object.entries(UNDERLYINGS).map(([u, i]) => [i, u]));
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// rows: [tradingsymbol, underlying, expiry "YYYY-MM-DD", strike, "CE"|"PE", lot_size, instrument_token, tick_size]
export function parseNfo(csv) {
  const lines = csv.split(/\r?\n/), head = lines.shift()?.split(",") || [];
  const c = (n) => head.indexOf(n);
  const iS = c("tradingsymbol"), iN = c("name"), iE = c("expiry"), iK = c("strike"), iT = c("instrument_type"),
    iL = c("lot_size"), iTok = c("instrument_token"), iTick = c("tick_size");
  const rows = [];
  for (const l of lines) {
    if (!l) continue;
    const f = l.includes('"') ? l.match(/("([^"]*)"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "")) : l.split(",");
    const name = f[iN], type = f[iT];
    if (!UNDERLYINGS[name] || (type !== "CE" && type !== "PE")) continue;
    rows.push([f[iS], name, f[iE], +f[iK], type, +f[iL], +f[iTok], +f[iTick] || 0.05]);
  }
  return rows;
}

// Daily cache in Blobs ("cache" store). The NFO file is large, so it gets a longer timeout.
export async function nfoList(k, cache, fetchImpl = fetch, now = Date.now()) {
  let list = cache ? await cache.get("kite-nfo-v1", { type: "json" }) : null;
  if (!list || list.day !== istDate(now)) {
    list = { day: istDate(now), rows: parseNfo(await kite("/instruments/NFO", k, fetchImpl, 9000)) };
    if (cache && list.rows.length) await cache.setJSON("kite-nfo-v1", list);
  }
  const today = istDate(now);
  return list.rows.filter((r) => r[2] >= today);              // never offer expired contracts
}

const fmtExp = (e) => { const [y, m, d] = e.split("-"); return `${+d} ${MONTHS[+m - 1]} ${y.slice(2)}`; };
export const optionName = (r) => `${r[1]} ${fmtExp(r[2])} ${r[3]} ${r[4]}`;
export const optionMeta = (r) => ({ underlying: r[1], expiry: r[2], strike: r[3], type: r[4], lot_size: r[5], tick_size: r[7], name: optionName(r) });

// "banknifty 52000 ce", "bank nifty pe dec", "nifty 24500" ... -> {underlying, strike, type, month} or null
export function parseOptionQuery(q) {
  let s = String(q).toUpperCase().replace(/\bBANK\s*NIFTY\b/g, "BANKNIFTY").replace(/\bNIFTY\s*BANK\b/g, "BANKNIFTY")
    .replace(/\bFIN\s*NIFTY\b/g, "FINNIFTY").replace(/\bMIDCP\s*NIFTY\b/g, "MIDCPNIFTY");
  const joined = s.replace(/\s+/g, "");
  const u = ["MIDCPNIFTY", "BANKNIFTY", "FINNIFTY", "NIFTY"].find((x) => joined.startsWith(x));
  if (!u) return null;
  const rest = joined.slice(u.length);
  // "NIFTY 50", "NIFTY 500", "NIFTY NEXT 50" are index names, not a strike
  if (u === "NIFTY" && /^(50|100|200|500|NEXT50|MIDCAP\d*|SMALLCAP\d*)$/.test(rest)) return { underlying: u, strike: null, type: null, month: null, wants: false };
  const strike = (rest.match(/\d{2,6}/) || [])[0] || null;
  const type = /CE|CALL/.test(rest) ? "CE" : /PE|PUT/.test(rest) ? "PE" : null;
  const month = MONTHS.findIndex((m) => rest.includes(m));
  const wants = !!(strike || type || month >= 0 || /OPT/.test(rest));
  return { underlying: u, strike, type, month: month >= 0 ? month + 1 : null, wants };
}

export async function searchOptions(q, k, cache, fetchImpl, now) {
  const pq = parseOptionQuery(q);
  if (!pq?.wants) return [];
  let rows = (await nfoList(k, cache, fetchImpl, now)).filter((r) => r[1] === pq.underlying);
  if (pq.type) rows = rows.filter((r) => r[4] === pq.type);
  if (pq.month) rows = rows.filter((r) => +r[2].slice(5, 7) === pq.month);
  if (pq.strike) {
    rows = rows.filter((r) => String(r[3]).startsWith(pq.strike));
    if (!rows.length) return [];                            // no such strike: let the normal share / index search answer
  }
  const want = pq.strike ? +pq.strike : null;
  const dist = (r) => (want != null ? Math.abs(r[3] - want * 10 ** Math.max(0, String(r[3]).length - pq.strike.length)) : 0);
  rows.sort((a, b) => a[2].localeCompare(b[2]) || dist(a) - dist(b) || a[3] - b[3] || a[4].localeCompare(b[4]));
  return rows.slice(0, 10).map((r) => ({ symbol: r[0] + ".NFO", name: optionName(r), exchange: "NFO", option: true, lot_size: r[5] }));
}

export async function optionInfo(sym, k, cache, fetchImpl, now) {
  const ts = String(sym).replace(/\.NFO$/i, "").toUpperCase();
  const r = (await nfoList(k, cache, fetchImpl, now)).find((x) => x[0] === ts);
  return r ? { tradingsymbol: r[0], ...optionMeta(r) } : null;
}

// Option chain around the money: n strikes above and below the spot, for one expiry.
export async function optionChain({ underlying, expiry, n = 10 }, k, cache, fetchImpl = fetch, now = Date.now()) {
  if (!UNDERLYINGS[underlying]) throw new Error("ye underlying support nahi hai");
  const all = (await nfoList(k, cache, fetchImpl, now)).filter((r) => r[1] === underlying);
  const expiries = [...new Set(all.map((r) => r[2]))].sort();
  if (!expiries.length) throw new Error("is underlying ke options nahi mile");
  const exp = expiries.includes(expiry) ? expiry : expiries[0];
  const rows = all.filter((r) => r[2] === exp);
  const spotKey = "NSE:" + UNDERLYINGS[underlying];
  const spot = (await kite(`/quote/ltp?i=${encodeURIComponent(spotKey)}`, k, fetchImpl)).data?.[spotKey]?.last_price ?? null;
  const strikes = [...new Set(rows.map((r) => r[3]))].sort((a, b) => a - b);
  const atmIdx = spot == null ? Math.floor(strikes.length / 2)
    : strikes.reduce((bi, s, i) => (Math.abs(s - spot) < Math.abs(strikes[bi] - spot) ? i : bi), 0);
  const pick = strikes.slice(Math.max(0, atmIdx - n), atmIdx + n + 1);
  const byKey = new Map(rows.map((r) => [r[3] + r[4], r]));
  const syms = pick.flatMap((s) => ["CE", "PE"].map((t) => byKey.get(s + t)).filter(Boolean).map((r) => "NFO:" + r[0]));
  const q = syms.length ? (await kite(`/quote?${syms.map((s) => "i=" + encodeURIComponent(s)).join("&")}`, k, fetchImpl, 6000)).data || {} : {};
  const cell = (r) => { if (!r) return null; const d = q["NFO:" + r[0]] || {}, prev = d.ohlc?.close;
    return { symbol: r[0] + ".NFO", token: r[6] || null, ltp: d.last_price ?? null, chg: d.last_price != null && prev ? d.last_price - prev : null,
             oi: d.oi ?? null, volume: d.volume ?? null }; };
  return {
    underlying, spot, expiry: exp, expiries: expiries.slice(0, 8), lot_size: rows[0]?.[5] ?? null, atm: strikes[atmIdx] ?? null,
    rows: pick.map((s) => ({ strike: s, ce: cell(byKey.get(s + "CE")), pe: cell(byKey.get(s + "PE")) })),
  };
}
