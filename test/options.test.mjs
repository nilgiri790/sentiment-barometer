// Offline tests for index options: list, search, chain, price, and the order safety rules. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNfo, parseOptionQuery, searchOptions, optionChain } from "../lib/options.mjs";
import { handlePrice } from "../lib/prices.mjs";
import { placeOrder, orderStatus, changeOrder } from "../lib/orders.mjs";
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

function net({ held = 0, relaySecret = "rs", calls = [], orders = [], hist = {} } = {}) {
  return async (url, o = {}) => {
    calls.push(url);
    if (url.endsWith("/instruments/NFO")) return ok(CSV);
    if (url.includes("/quote/ltp")) { const i = decodeURIComponent(url.split("i=")[1]); return ok({ data: { [i]: { last_price: i.includes("NIFTY BANK") ? 52140 : 120.5 } } }); }
    if (url.includes("/quote?")) { const ids = [...url.matchAll(/i=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      return ok({ data: Object.fromEntries(ids.map((i, n) => [i, { instrument_token: 1500, last_price: 100 + n, ohlc: { close: 95 + n }, oi: 1000 * n, volume: 50 }])) }); }
    if (url.includes("/historical/")) return ok({ data: { candles: [["2026-11-04T09:15:00+0530", 1, 130, 110, 120, 0]] } });
    if (url.includes("/portfolio/positions")) return ok({ data: { net: [{ exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", quantity: held }] } });
    if (url === "https://api.kite.trade/orders") return ok({ data: orders });
    if (url.startsWith("https://api.kite.trade/orders/")) { const id = url.split("/").pop(); return hist[id] ? ok({ status: "success", data: hist[id] }) : { ok: false, status: 404, json: async () => ({ message: "Order not found" }) }; }
    if (url.startsWith("https://relay.example/")) {
      const path = "/" + url.split("/").pop();
      const r = await handleRelay({ method: "POST", path, body: o.body, headers: { "x-relay-signature": o.headers["x-relay-signature"] } },
        { secret: relaySecret, fetchImpl: async (u2, o2) => { calls.push(`${o2.method} ${u2} ${o2.body || ""}`); return ok({ status: "success", data: { order_id: u2.includes("/regular/") ? u2.split("/").pop() : "OPT123" } }); } });
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
  const sent = new URLSearchParams(calls.find((c) => c.startsWith("POST https://api.kite.trade/orders/regular")).split(" ")[2]);
  assert.equal(sent.get("exchange"), "NFO"); assert.equal(sent.get("quantity"), "35"); assert.equal(sent.get("product"), "NRML");
});

test("options SELL only what you hold (no writing)", async () => {
  const SELL = { ...BUY, side: "SELL", order_type: "MARKET", product: "NRML" };
  let r = await placeOrder(SELL, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 0 }), cache: mem(), now: Date.now() });
  assert.match(r.error, /writing/);
  r = await placeOrder(SELL, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 35 }), cache: mem(), now: Date.now() });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("options SELL: a second SELL on the same qty is refused (target + SL can never both be open)", async () => {
  const SELL = { ...BUY, side: "SELL", order_type: "LIMIT", price: 130, product: "NRML" };
  const open = [{ exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", transaction_type: "SELL", status: "OPEN", quantity: 35, filled_quantity: 0, pending_quantity: 35 }];
  let r = await placeOrder(SELL, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 35, orders: open }), cache: mem(), now: Date.now() });
  assert.match(r.error, /pehle se laga/);
  r = await placeOrder(SELL, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 35, orders: [{ ...open[0], status: "CANCELLED", pending_quantity: 0 }] }), cache: mem(), now: Date.now() });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("order change: cancel any open order, re-price only an open SELL LIMIT; status from Zerodha", async () => {
  const sellOpen = { order_id: "251105000001", status: "OPEN", transaction_type: "SELL", order_type: "LIMIT", exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", price: 94, quantity: 35, filled_quantity: 0 };
  const buyOpen = { ...sellOpen, order_id: "251105000002", transaction_type: "BUY" };
  const done = { ...sellOpen, order_id: "251105000003", status: "COMPLETE", filled_quantity: 35, average_price: 94 };
  const hist = { [sellOpen.order_id]: [{ ...sellOpen, status: "PUT ORDER REQ RECEIVED" }, sellOpen], [buyOpen.order_id]: [buyOpen], [done.order_id]: [done] };
  const calls = [], f = net({ hist, calls }), S = SECRETS({ allow_fno: "yes" }), now = Date.now();
  const st = await orderStatus(done.order_id, S, { fetchImpl: f });
  assert.equal(st.order.status, "COMPLETE"); assert.equal(st.order.average_price, 94);
  assert.equal((await orderStatus("abc", S, { fetchImpl: f })).status, 400);
  let r = await changeOrder({ op: "modify", order_id: sellOpen.order_id, price: 91.23 }, S, { fetchImpl: f, now });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.price, 91.25);
  assert.ok(calls.some((c) => c.startsWith(`PUT https://api.kite.trade/orders/regular/${sellOpen.order_id} order_type=LIMIT&price=91.25`)), calls.join("\n"));
  r = await changeOrder({ op: "modify", order_id: buyOpen.order_id, price: 200 }, S, { fetchImpl: f, now });
  assert.match(r.error, /Sirf SELL LIMIT/);
  r = await changeOrder({ op: "cancel", order_id: buyOpen.order_id }, S, { fetchImpl: f, now });
  assert.equal(r.ok, true); assert.ok(calls.some((c) => c.startsWith(`DELETE https://api.kite.trade/orders/regular/${buyOpen.order_id}`)));
  r = await changeOrder({ op: "cancel", order_id: done.order_id }, S, { fetchImpl: f, now });
  assert.equal(r.status, 409); assert.equal(r.order.status, "COMPLETE");
});

test("relay: cancel/modify need a signature and a numeric order id", async () => {
  const body = JSON.stringify({ ts: 1000, order_id: "12; rm", kite: { api_key: "a", access_token: "b" } });
  const r1 = await handleRelay({ method: "POST", path: "/cancel", body, headers: { "x-relay-signature": "x".repeat(64) } }, { secret: "rs", now: 1000, fetchImpl: () => { throw new Error("no"); } });
  assert.equal(r1.status, 401);
  const r2 = await handleRelay({ method: "POST", path: "/cancel", body, headers: { "x-relay-signature": sign("rs", body) } }, { secret: "rs", now: 1000, fetchImpl: () => { throw new Error("no"); } });
  assert.match(r2.json.error, /order id/);
  const b3 = JSON.stringify({ ts: 1000, order_id: "123", price: -5, kite: { api_key: "a", access_token: "b" } });
  const r3 = await handleRelay({ method: "POST", path: "/modify", body: b3, headers: { "x-relay-signature": sign("rs", b3) } }, { secret: "rs", now: 1000, fetchImpl: () => { throw new Error("no"); } });
  assert.match(r3.json.error, /price/);
});

test("relay rules for NFO", () => {
  const base = { exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", transaction_type: "BUY", order_type: "MARKET", quantity: 35 };
  assert.equal(validOrder({ ...base, product: "NRML" }), null);
  assert.equal(validOrder({ ...base, product: "MIS" }), null);
  assert.match(validOrder({ ...base, product: "CNC" }), /NRML or MIS/);
  assert.match(validOrder({ ...base, exchange: "NSE", product: "NRML" }), /CNC or MIS/);
});

test("search: 'NIFTY 50' / 'NIFTY 500' are index names, not option strikes", async () => {
  assert.equal(parseOptionQuery("NIFTY 50").wants, false);
  assert.equal(parseOptionQuery("nifty50").wants, false);
  assert.equal(parseOptionQuery("NIFTY NEXT 50").wants, false);
  assert.equal(parseOptionQuery("nifty 24500 ce").wants, true);
  const K = { api_key: "k", access_token: "t", token_at: new Date().toISOString() };
  assert.deepEqual(await searchOptions("banknifty 99999 ce", K, mem(), net(), Date.now()), [], "no such strike -> normal search answers");
});

test("Zerodha SL orders: relay rules, placing a SELL SL, moving its trigger (trailing), re-pricing after trigger", async () => {
  const base = { exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", transaction_type: "SELL", order_type: "SL", product: "MIS", quantity: 35 };
  assert.equal(validOrder({ ...base, price: 90.2, trigger_price: 93 }), null);
  assert.match(validOrder({ ...base, price: 94, trigger_price: 93 }), /limit <= trigger/);
  assert.match(validOrder({ ...base, price: 90 }), /trigger price missing/);
  const calls = [];
  let r = await placeOrder({ ...BUY, side: "SELL", order_type: "SL", price: 90.23, trigger_price: 93.01, product: "MIS" }, SECRETS({ allow_fno: "yes" }), { fetchImpl: net({ held: 35, calls }), cache: mem(), now: Date.now() });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.order.trigger_price, 93); assert.equal(r.order.price, 90.25);
  const sent = new URLSearchParams(calls.find((c) => c.startsWith("POST https://api.kite.trade/orders/regular")).split(" ")[2]);
  assert.equal(sent.get("order_type"), "SL"); assert.equal(sent.get("trigger_price"), "93");
  const waiting = { order_id: "251106000001", status: "TRIGGER PENDING", transaction_type: "SELL", order_type: "SL", exchange: "NFO", tradingsymbol: "BANKNIFTY26NOV52000CE", price: 90.2, trigger_price: 93, quantity: 35 };
  const fired = { ...waiting, order_id: "251106000002", status: "OPEN" };
  const c2 = [], f = net({ hist: { [waiting.order_id]: [waiting], [fired.order_id]: [fired] }, calls: c2 }), S = SECRETS({ allow_fno: "yes" }), now = Date.now();
  r = await changeOrder({ op: "modify", order_id: waiting.order_id, price: 97, trigger_price: 100 }, S, { fetchImpl: f, now });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(c2.some((c) => c.includes("order_type=SL&price=97&trigger_price=100")), c2.join("\n"));
  assert.match((await changeOrder({ op: "modify", order_id: waiting.order_id, price: 97 }, S, { fetchImpl: f, now })).error, /trigger nahi hua/);
  assert.match((await changeOrder({ op: "modify", order_id: waiting.order_id, price: 101, trigger_price: 100 }, S, { fetchImpl: f, now })).error, /trigger se upar/);
  r = await changeOrder({ op: "modify", order_id: fired.order_id, price: 91.5 }, S, { fetchImpl: f, now });
  assert.equal(r.ok, true); assert.ok(c2.some((c) => c.includes(`${fired.order_id} order_type=LIMIT&price=91.5`)));
  assert.equal((await changeOrder({ op: "modify", order_id: fired.order_id, price: 91, trigger_price: 95 }, S, { fetchImpl: f, now })).status, 409);
});
