// Offline tests for index options: list, search, chain, price, and the order safety rules. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNfo, parseOptionQuery, searchOptions, optionChain } from "../lib/options.mjs";
import { handlePrice } from "../lib/prices.mjs";
import { placeOrder } from "../lib/orders.mjs";
import { handleRelay, sign, validOrder } from "../relay/relay.mjs";

const NOW = Date.parse("2026-11-04T08:00:00Z");
const KITE = { api_key: "kk", api_secret: "ss", access_token: "tok", token_at: new Date().toISOString() };
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => b });
const mem = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const H = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n";
const row = (tok, ts, name, exp, k, t, lot = 35) => `${tok},1,${ts},"${name}",0,${exp},${k},0.05,${lot},${t},NFO-OPT,NFO\n`;
let CSV = H + row(1, "BANKNIFTY26OCT52000CE", "BANKNIFTY", "2026-10-28", 52000, "CE");   // expired: must be hidden
for (const k of [51500, 52000, 52500]) for (const t of ["CE", "PE"]) {
  CSV += row(1000 + k / 100 + (t === "PE" ? 1 : 0), `BANKNIFTY26NOV${k}${t}`, "BANKNIFTY", "2026-11-25", k, t);
  CSV += row(2000 + k / 100 + (t === "PE" ? 1 : 0), `BANKNIFTY26DEC${k}${t}`, "BANKNIFTY", "2026-12-30", k, t);
}
CSV += row(3001, "NIFTY26N1024500CE", "NIFTY", "2026-11-10", 24500, "CE", 75) + "9,9,NIFTY26NOVFUT,\"NIFTY\",0,2026-11-25,0,0.05,75,FUT,NFO-FUT,NFO\n";

function net({ held = 0, relaySecret = "rs", calls = [] } = {}) {
  return async (url, o = {}) => {
    calls.push(url);
    if (url.endsWith("/instruments/NFO")) return ok(CSV);
    if (url.includes("/quote/ltp")) { const i = decodeURIComponent(url.split("i=")[1]); return ok({ data: { [i]: { last_price: i.includes("NIFTY BANK") ? 52140 : 120.5 } } }); }
    if (url.includes("/quote?")) { const ids = [...url.matchAll(/i=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      return ok({ data: Object.fromEntries(ids.map((i, n) => [i, { instrument_token: 1500, last_price: 100 + n, ohlc: { close: 95 + n }, oi: 1000 * n, volume: 50 }])) }); }
    if (url.includes("/historical/")) return ok({ data: { candles: [["2026-11-04T09:15:00+0530", 1, 130, 110, 120, 0]] } });
    if (url.includes("/portfolio/positions")) return ok({ data: { net: [{ exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", quantity: held }] } });
    if (url.startsWith("https://relay.example/order")) {
      const r = await handleRelay({ method: "POST", path: "/order", body: o.body, headers: { "x-relay-signature": o.headers["x-relay-signature"] } },
        { secret: relaySecret, fetchImpl: async (u2, o2) => { calls.push(u2 + " " + o2.body); return ok({ status: "success", data: { order_id: "OPT123" } }); } });
      return { ok: r.status < 300, status: r.status, json: async () => r.json };
    }
    throw new Error("unexpected " + url);
  };
}

test("NFO list keeps only index CE/PE (no futures)", () => {
  const rows = parseNfo(CSV);
  assert.ok(rows.every((r) => r[4] === "CE" || r[4] === "PE"));
  assert.deepEqual(rows.find((r) => r[0] === "BANKNIFTY26NOV52000CE"), ["BANKNIFTY26NOV52000CE", "BANKNIFTY", "2026-11-25", 52000, "CE", 35, 1520, 0.05]);
});

test("query parsing", () => {
  assert.deepEqual(parseOptionQuery("bank nifty 52000 ce"), { underlying: "BANKNIFTY", strike: "52000", type: "CE", month: null, wants: true });
  assert.equal(parseOptionQuery("banknifty put dec").type, "PE"); assert.equal(parseOptionQuery("banknifty put dec").month, 12);
  assert.equal(parseOptionQuery("banknifty").wants, false, "plain name -> index search, not options");
  assert.equal(parseOptionQuery("nifty 24500").underlying, "NIFTY");
  assert.equal(parseOptionQuery("itc"), null);
});

test("search options: nearest expiry first, typed strike first, expired hidden", async () => {
  const r = await searchOptions("banknifty 52000 ce", KITE, mem(), net(), NOW);
  assert.deepEqual(r.map((x) => x.symbol), ["BANKNIFTY26NOV52000CE.NFO", "BANKNIFTY26DEC52000CE.NFO"]);
  assert.equal(r[0].name, "BANKNIFTY 25 NOV 26 52000 CE"); assert.equal(r[0].lot_size, 35); assert.equal(r[0].option, true);
  const pe = await searchOptions("banknifty pe", KITE, mem(), net(), NOW);
  assert.ok(pe.length && pe.every((x) => x.symbol.endsWith("PE.NFO")) && pe[0].symbol.includes("26NOV"));
});

test("search API routes option queries; plain index name still finds the index", async () => {
  const cache = mem();
  let r = await handlePrice(new Request("https://s/api/search?q=banknifty%2052500%20pe"), { secrets: { kite: KITE }, cache, fetchImpl: net(), now: NOW });
  assert.equal((await r.json())[0].symbol, "BANKNIFTY26NOV52500PE.NFO");
});

test("option price: Zerodha only, with contract details", async () => {
  let r = await handlePrice(new Request("https://s/api/price?sym=BANKNIFTY26NOV52000CE.NFO&range=1d"), { secrets: { kite: KITE }, cache: mem(), fetchImpl: net(), now: NOW });
  let b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.source, "Zerodha");
  assert.deepEqual(b.option, { tradingsymbol: "BANKNIFTY26NOV52000CE", underlying: "BANKNIFTY", expiry: "2026-11-25", strike: 52000, type: "CE", lot_size: 35, tick_size: 0.05, name: "BANKNIFTY 25 NOV 26 52000 CE" });
  r = await handlePrice(new Request("https://s/api/price?sym=BANKNIFTY26NOV52000CE.NFO&range=1d"), { secrets: {}, fetchImpl: net(), now: NOW });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /sirf Zerodha/);
});

test("option chain around the spot", async () => {
  const c = await optionChain({ underlying: "BANKNIFTY", expiry: "" }, KITE, mem(), net(), NOW);
  assert.equal(c.spot, 52140); assert.equal(c.atm, 52000); assert.equal(c.expiry, "2026-11-25");
  assert.deepEqual(c.expiries, ["2026-11-25", "2026-12-30"]); assert.equal(c.lot_size, 35);
  assert.deepEqual(c.rows.map((x) => x.strike), [51500, 52000, 52500]);
  assert.ok(c.rows.every((x) => x.ce.ltp != null && x.pe.ltp != null && x.ce.symbol.endsWith("CE.NFO")));
  const d = await optionChain({ underlying: "BANKNIFTY", expiry: "2026-12-30" }, KITE, mem(), net(), NOW);
  assert.equal(d.expiry, "2026-12-30");
});

const SECRETS = (relay = {}) => ({ kite: KITE, order_relay: { url: "https://relay.example", secret: "rs", max_qty: "10", max_value: "50000", ...relay } });
const BUY = { symbol: "BANKNIFTY26NOV52000CE.NFO", side: "BUY", lots: 1, order_type: "LIMIT", price: 120.53, product: "NRML" };

test("options orders: off by default, lots limit, value limit", async () => {
  let r = await placeOrder(BUY, SECRETS(), { fetchImpl: net(), cache: mem(), now: NOW });
  assert.match(r.error, /Options trading band/);
  r = await placeOrder({ ...BUY, lots: 2 }, SECRETS({ allow_fno: "yes" }), { fetchImpl: net(), cache: mem(), now: NOW });
  assert.match(r.error, /1 lot/);
  r = await placeOrder({ ...BUY, price: 2000 }, SECRETS({ allow_fno: "yes" }), { fetchImpl: net(), cache: mem(), now: NOW });
  assert.match(r.error, /70,000.*limit ₹50,000/);
  r = await placeOrder({ ...BUY, product: "CNC" }, SECRETS({ allow_fno: "yes" }), { fetchImpl: net(), cache: mem(), now: NOW });
  assert.match(r.error, /NRML or MIS/);
  r = await placeOrder({ ...BUY, symbol: "BANKNIFTY26OCT52000CE.NFO" }, SECRETS({ allow_fno: "yes" }), { fetchImpl: net(), cache: mem(), now: NOW });
  assert.match(r.error, /nahi mila/, "expired contract refused");
});

test("options BUY goes through: quantity = lots x lot size, price on 0.05 tick", async () => {
  const calls = [];
  const r = await placeOrder({ ...BUY, lots: 1 }, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ calls }), cache: mem(), now: Date.now() });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.order_id, "OPT123");
  assert.equal(r.order.quantity, 35); assert.equal(r.order.price, 120.55); assert.equal(r.order.exchange, "NFO");
  const sent = new URLSearchParams(calls.find((c) => c.startsWith("https://api.kite.trade/orders/regular")).split(" ")[1]);
  assert.equal(sent.get("exchange"), "NFO"); assert.equal(sent.get("quantity"), "35"); assert.equal(sent.get("product"), "NRML");
});

test("options SELL only what you hold (no writing)", async () => {
  const SELL = { ...BUY, side: "SELL", order_type: "MARKET", product: "NRML" };
  let r = await placeOrder(SELL, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 0 }), cache: mem(), now: Date.now() });
  assert.match(r.error, /writing/);
  r = await placeOrder(SELL, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 35 }), cache: mem(), now: Date.now() });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("relay rules for NFO", () => {
  const base = { exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", transaction_type: "BUY", order_type: "MARKET", quantity: 35 };
  assert.equal(validOrder({ ...base, product: "NRML" }), null);
  assert.equal(validOrder({ ...base, product: "MIS" }), null);
  assert.match(validOrder({ ...base, product: "CNC" }), /NRML or MIS/);
  assert.match(validOrder({ ...base, exchange: "NSE", product: "NRML" }), /CNC or MIS/);
});
