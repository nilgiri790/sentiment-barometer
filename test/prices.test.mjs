// Offline tests for prices (Zerodha + Yahoo fallback). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePrice, toKite, parseInstruments, kiteReady } from "../lib/prices.mjs";

const NOW = Date.parse("2026-11-04T08:00:00Z");            // 1:30 PM IST, Wednesday
const KITE = { api_key: "kk", api_secret: "ss", access_token: "tok", token_at: "2026-11-04T02:00:00Z" };
const memStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body });

function fakeNet({ kiteStatus = 200, unknown = false } = {}) {
  const calls = [];
  const f = async (url, o = {}) => {
    calls.push(url);
    if (url.startsWith("https://api.kite.trade")) {
      assert.equal(o.headers.Authorization, "token kk:tok"); assert.equal(o.headers["X-Kite-Version"], "3");
      if (kiteStatus !== 200) return { ok: false, status: kiteStatus };
      if (url.includes("/quote")) return ok({ data: unknown ? {} : { "NSE:TCS": { instrument_token: 2953217, last_price: 3201.5, ohlc: { close: 3150 } } } });
      if (url.includes("/historical/2953217/5minute")) return ok({ data: { candles: [
        ["2026-11-03T15:25:00+0530", 1, 3160, 3140, 3150, 9], // yesterday: dropped for 1d
        ["2026-11-04T09:15:00+0530", 1, 3190, 3170, 3180, 9], ["2026-11-04T09:20:00+0530", 1, 3205, 3179, 3199, 9]] } });
      if (url.includes("/historical/2953217/day")) return ok({ data: { candles: [
        ["2026-11-03T00:00:00+0530", 1, 3170, 3120, 3150, 9], ["2026-11-04T00:00:00+0530", 1, 3210, 3160, 3201.5, 9]] } });
      if (url.endsWith("/instruments/NSE")) return ok(
        'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n' +
        '1,1,TCS,"TATA CONSULTANCY SERV LT",0,,0,0.05,1,EQ,NSE,NSE\n2,2,TATASTEEL,"TATA STEEL LIMITED",0,,0,0.05,1,EQ,NSE,NSE\n' +
        '3,3,TATAGOLD,"TATA MUTUAL FUND, GOLD ETF",0,,0,0.01,1,EQ,NSE,NSE\n4,4,NIFTY26NOVFUT,,0,,0,0.05,75,FUT,NFO-FUT,NFO\n');
    }
    if (url.includes("yahoo")) {
      if (url.includes("/search")) return ok({ quotes: [{ symbol: "AAPL", shortname: "Apple" }, { symbol: "TCS.NS", shortname: "TCS", exchDisp: "NSE" }] });
      return ok({ chart: { result: [{ meta: { currency: "INR" }, timestamp: [1, 2], indicators: { quote: [{ close: [10, 11], high: [12, 12], low: [9, 9] }] } }] } });
    }
    throw new Error("unexpected " + url);
  };
  return { f, calls };
}
const get = async (path, opts) => { const r = await handlePrice(new Request("https://s" + path), opts); return { status: r.status, body: await r.json() }; };

test("symbol mapping and token check", () => {
  assert.equal(toKite("TCS.NS"), "NSE:TCS"); assert.equal(toKite("reliance.bo"), "BSE:RELIANCE"); assert.equal(toKite("AAPL"), null);
  assert.equal(kiteReady({ ...KITE, token_at: new Date().toISOString() }), true);
  assert.equal(kiteReady({ ...KITE, token_at: "2020-01-01T00:00:00Z" }), false);
  assert.equal(kiteReady({ api_key: "kk", token_at: new Date().toISOString() }), false);
});

test("Zerodha 1 day: today's candles only, live last price, previous close from quote", async () => {
  const n = fakeNet();
  const { body } = await get("/api/price?sym=TCS.NS&range=1d", { secrets: { kite: { ...KITE, token_at: new Date().toISOString() } }, fetchImpl: n.f, now: NOW });
  assert.equal(body.source, "Zerodha");
  assert.equal(body.last, 3201.5); assert.equal(body.prevClose, 3150);
  assert.equal(body.points.length, 3, "2 candles today + live tip");
  assert.equal(body.high, 3205); assert.equal(body.low, 3170);
  assert.ok(n.calls.every((u) => !u.includes("yahoo")));
  assert.ok(n.calls.some((u) => u.includes("from=2026-10-29%2013%3A30%3A00")), "dates are sent in IST: " + n.calls[1]);
});

test("Zerodha 1 month: daily points land on the right India date", async () => {
  const n = fakeNet();
  const { body } = await get("/api/price?sym=TCS.NS&range=1mo", { secrets: { kite: { ...KITE, token_at: new Date().toISOString() } }, fetchImpl: n.f, now: NOW });
  assert.deepEqual(body.points.map(([t]) => new Date(t).toISOString().slice(0, 10)), ["2026-11-03", "2026-11-04"]);
});

test("falls back to Yahoo: not logged in today / login expired / unknown symbol / non-Indian", async () => {
  const fresh = { ...KITE, token_at: new Date().toISOString() };
  let r = await get("/api/price?sym=TCS.NS&range=1d", { secrets: { kite: { ...KITE, token_at: "2020-01-01T00:00:00Z" } }, fetchImpl: fakeNet().f });
  assert.equal(r.body.source, "Yahoo"); assert.match(r.body.notice, /Login with Zerodha/);
  r = await get("/api/price?sym=TCS.NS&range=1d", { secrets: { kite: fresh }, fetchImpl: fakeNet({ kiteStatus: 403 }).f });
  assert.equal(r.body.source, "Yahoo"); assert.match(r.body.notice, /expire/);
  r = await get("/api/price?sym=TCS.NS&range=1d", { secrets: { kite: fresh }, fetchImpl: fakeNet({ unknown: true }).f });
  assert.equal(r.body.source, "Yahoo"); assert.match(r.body.notice, /nahi mila/);
  const n = fakeNet();
  r = await get("/api/price?sym=AAPL&range=1d", { secrets: { kite: fresh }, fetchImpl: n.f });
  assert.equal(r.body.source, "Yahoo"); assert.equal(r.body.notice, undefined);
  assert.ok(n.calls.every((u) => !u.includes("kite")));
  r = await get("/api/price?sym=TCS.NS&range=1d", { secrets: {}, fetchImpl: fakeNet().f });
  assert.equal(r.body.source, "Yahoo"); assert.equal(r.body.notice, undefined, "no Zerodha keys: no nagging");
});

test("search uses Zerodha's NSE list (cached per day), handles typos-ish and quoted names", async () => {
  const fresh = { ...KITE, token_at: new Date().toISOString() }, cache = memStore(), n = fakeNet();
  let r = await get("/api/search?q=tata", { secrets: { kite: fresh }, cache, fetchImpl: n.f, now: NOW });
  assert.equal(r.body.length, 3);
  assert.ok(r.body.some((x) => x.symbol === "TATASTEEL.NS")); assert.ok(!r.body.some((x) => x.symbol.includes("FUT")));
  r = await get("/api/search?q=tcs", { secrets: { kite: fresh }, cache, fetchImpl: n.f, now: NOW });
  assert.equal(r.body[0].symbol, "TCS.NS");
  assert.equal(n.calls.filter((u) => u.endsWith("/instruments/NSE")).length, 1, "list downloaded once per day");
  r = await get("/api/search?q=apple", { secrets: { kite: fresh }, cache, fetchImpl: n.f, now: NOW });
  assert.equal(r.body[0].symbol, "TCS.NS", "nothing on NSE -> Yahoo results, Indian first");
});

test("instrument CSV parser keeps commas inside quotes", () => {
  const rows = parseInstruments('instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n9,9,X,"A, B",0,,0,0.05,1,EQ,NSE,NSE\n');
  assert.deepEqual(rows, [["X", "A, B", "EQ"]]);
});

test("search: Bank Nifty and other indices, typed the way people type them", async () => {
  const fresh = { ...KITE, token_at: new Date().toISOString() }, cache = memStore();
  const csv = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n' +
    '1,1,BANKNIFTY1,"KOTAK NIFTY BANK ETF",0,,0,0.01,1,EQ,NSE,NSE\n260105,1,NIFTY BANK,NIFTY BANK,0,,0,0,0,EQ,INDICES,NSE\n' +
    '256265,1,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE\n3,3,BANKBARODA,"BANK OF BARODA",0,,0,0.05,1,EQ,NSE,NSE\n4,4,HDFCBANK,"HDFC BANK LTD",0,,0,0.05,1,EQ,NSE,NSE\n';
  const f = async (url) => { if (url.endsWith("/instruments/NSE")) return ok(csv);
    if (url.includes("/quote")) return ok({ data: { "NSE:NIFTY BANK": { instrument_token: 260105, last_price: 52000.5, ohlc: { close: 51800 } } } });
    if (url.includes("/historical/260105/")) return ok({ data: { candles: [["2026-11-04T09:15:00+0530", 1, 52100, 51900, 52000, 0]] } });
    throw new Error(url); };
  let r = await get("/api/search?q=banknifty", { secrets: { kite: fresh }, cache, fetchImpl: f, now: NOW });
  assert.equal(r.body[0].symbol, "NIFTY BANK.NS"); assert.equal(r.body[0].index, true); assert.equal(r.body[0].exchange, "NSE INDEX");
  assert.ok(r.body.some((x) => x.symbol === "BANKNIFTY1.NS"), "the ETF is still offered");
  r = await get("/api/search?q=bank", { secrets: { kite: fresh }, cache, fetchImpl: f, now: NOW });
  assert.ok(["NIFTY BANK.NS", "BANKBARODA.NS", "HDFCBANK.NS"].every((s) => r.body.some((x) => x.symbol === s)), JSON.stringify(r.body));
  r = await get("/api/search?q=nifty", { secrets: { kite: fresh }, cache, fetchImpl: f, now: NOW });
  assert.equal(r.body[0].symbol, "NIFTY 50.NS");
  // price of an index: works, and is marked as index (no Buy/Sell)
  r = await get("/api/price?sym=" + encodeURIComponent("NIFTY BANK.NS") + "&range=1d", { secrets: { kite: fresh }, cache, fetchImpl: f, now: NOW });
  assert.equal(r.status, 200); assert.equal(r.body.source, "Zerodha"); assert.equal(r.body.index, true); assert.equal(r.body.last, 52000.5);
  r = await get("/api/price?sym=TCS.NS&range=1d", { secrets: { kite: fresh }, cache, fetchImpl: fakeNet().f, now: NOW });
  assert.equal(r.body.index, undefined, "a share is not an index");
});

test("index price without Zerodha uses the Yahoo index symbol", async () => {
  let asked = "";
  const f = async (url) => { asked = url; return ok({ chart: { result: [{ meta: {}, timestamp: [1, 2], indicators: { quote: [{ close: [51000, 51100], high: [51200, 51200], low: [50900, 50900] }] } }] } }); };
  const r = await get("/api/price?sym=" + encodeURIComponent("NIFTY BANK.NS") + "&range=1d", { secrets: {}, fetchImpl: f, now: NOW });
  assert.equal(r.body.symbol, "NIFTY BANK.NS"); assert.equal(r.body.index, true); assert.match(asked, /%5ENSEBANK/);
});

test("orders refuse an index symbol", async () => {
  const { buildOrder } = await import("../lib/orders.mjs");
  assert.match(buildOrder({ symbol: "NIFTY BANK.NS", side: "BUY", qty: 1, order_type: "MARKET", product: "CNC" }).error, /bad symbol/);
});
