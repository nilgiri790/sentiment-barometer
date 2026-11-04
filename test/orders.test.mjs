// Offline tests for Buy/Sell: relay (Cloud Run) + website checks. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRelay, sign } from "../relay/relay.mjs";
import { placeOrder, buildOrder, limitsOf } from "../lib/orders.mjs";
import { handleAdmin } from "../lib/admin.mjs";

const SECRET = "relay-secret-123";
const okRes = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
const kiteFake = (calls, resp = { status: "success", data: { order_id: "250101000123" } }, status = 200) => async (url, o = {}) => {
  calls.push({ url, o });
  if (url.includes("ipify")) return okRes({ ip: "34.100.1.2" });
  if (url.includes("/orders/regular")) return okRes(resp, status);
  throw new Error("unexpected " + url);
};
const relayReq = (msg, secret = SECRET) => { const body = JSON.stringify(msg); return { method: "POST", path: "/order", body, headers: { "x-relay-signature": sign(secret, body) } }; };
const ORDER = { exchange: "NSE", tradingsymbol: "ITC", transaction_type: "BUY", order_type: "LIMIT", product: "CNC", quantity: 2, price: 280.5 };
const KITE = { api_key: "kk", access_token: "tok" };

test("relay: health shows outgoing IP", async () => {
  const r = await handleRelay({ method: "GET", path: "/health" }, { secret: SECRET, fetchImpl: kiteFake([]) });
  assert.deepEqual(r.json, { ok: true, ip: "34.100.1.2", configured: true });
});

test("relay: refuses wrong signature, old requests, bad orders; never calls Zerodha then", async () => {
  const calls = [], now = Date.now(), f = kiteFake(calls);
  assert.equal((await handleRelay(relayReq({ ts: now, order: ORDER, kite: KITE }, "wrong"), { secret: SECRET, fetchImpl: f, now })).status, 401);
  assert.equal((await handleRelay(relayReq({ ts: now - 120000, order: ORDER, kite: KITE }), { secret: SECRET, fetchImpl: f, now })).status, 401);
  assert.equal((await handleRelay(relayReq({ ts: now, order: { ...ORDER, quantity: 0 }, kite: KITE }), { secret: SECRET, fetchImpl: f, now })).status, 400);
  assert.equal((await handleRelay(relayReq({ ts: now, order: { ...ORDER, exchange: "NFO" }, kite: KITE }), { secret: SECRET, fetchImpl: f, now })).status, 400);
  assert.equal((await handleRelay(relayReq({ ts: now, order: ORDER, kite: KITE }), { secret: "", fetchImpl: f, now })).status, 503);
  assert.equal(calls.length, 0);
});

test("relay: sends a correct Kite order (limit price, market protection on market orders)", async () => {
  const calls = [], now = Date.now();
  let r = await handleRelay(relayReq({ ts: now, order: ORDER, kite: KITE }), { secret: SECRET, fetchImpl: kiteFake(calls), now });
  assert.deepEqual(r.json, { ok: true, order_id: "250101000123" });
  const f1 = new URLSearchParams(calls[0].o.body);
  assert.equal(calls[0].url, "https://api.kite.trade/orders/regular");
  assert.equal(calls[0].o.headers.Authorization, "token kk:tok");
  assert.equal(f1.get("tradingsymbol"), "ITC"); assert.equal(f1.get("price"), "280.5"); assert.equal(f1.get("validity"), "DAY");
  assert.equal(f1.get("market_protection"), null);
  r = await handleRelay(relayReq({ ts: now, order: { ...ORDER, order_type: "MARKET", price: undefined }, kite: KITE }), { secret: SECRET, fetchImpl: kiteFake(calls), now });
  const f2 = new URLSearchParams(calls[1].o.body);
  assert.equal(f2.get("market_protection"), "-1"); assert.equal(f2.get("price"), null);
});

test("relay: passes Zerodha's error message back (e.g. IP not registered)", async () => {
  const r = await handleRelay(relayReq({ ts: Date.now(), order: ORDER, kite: KITE }),
    { secret: SECRET, fetchImpl: kiteFake([], { status: "error", message: "IP not whitelisted", error_type: "PermissionException" }, 403) });
  assert.equal(r.status, 403); assert.equal(r.json.error, "IP not whitelisted");
});

test("website: builds order from page input; refuses non-Indian and bad input", () => {
  assert.deepEqual(buildOrder({ symbol: "ITC.NS", side: "buy", qty: 3, order_type: "limit", price: "280.456", product: "cnc" }).order,
    { exchange: "NSE", tradingsymbol: "ITC", transaction_type: "BUY", order_type: "LIMIT", product: "CNC", quantity: 3, price: 280.46 });
  assert.match(buildOrder({ symbol: "AAPL", side: "BUY", qty: 1, order_type: "MARKET", product: "CNC" }).error, /NSE\/BSE/);
  assert.match(buildOrder({ symbol: "ITC.NS", side: "BUY", qty: 1.5, order_type: "MARKET", product: "CNC" }).error, /quantity/);
  assert.deepEqual(limitsOf({ max_qty: "50", max_value: "1,00,000" }), { max_qty: 50, max_value: 100000 });
  assert.deepEqual(limitsOf({}), { max_qty: 10, max_value: 25000 });
});

const SECRETS = () => ({ kite: { api_key: "kk", api_secret: "s", access_token: "tok", token_at: new Date().toISOString() },
  order_relay: { url: "https://relay.example/", secret: SECRET, max_qty: "10", max_value: "5000" } });

test("website: limits, missing setup, market order uses live price for the value check", async () => {
  const calls = [];
  const f = async (url, o) => { calls.push(url);
    if (url.includes("/quote/ltp")) return okRes({ data: { "NSE:ITC": { last_price: 600 } } });
    if (url.startsWith("https://relay.example/order")) {
      const r = await handleRelay({ method: "POST", path: "/order", body: o.body, headers: { "x-relay-signature": o.headers["x-relay-signature"] } }, { secret: SECRET, fetchImpl: kiteFake([]) });
      return okRes(r.json, r.status); }
    throw new Error(url); };
  let r = await placeOrder({ symbol: "ITC.NS", side: "BUY", qty: 11, order_type: "LIMIT", price: 1, product: "CNC" }, SECRETS(), { fetchImpl: f });
  assert.match(r.error, /Quantity limit 10/);
  r = await placeOrder({ symbol: "ITC.NS", side: "BUY", qty: 9, order_type: "MARKET", product: "CNC" }, SECRETS(), { fetchImpl: f });
  assert.match(r.error, /5,400.*limit ₹5,000/);
  assert.ok(!calls.some((u) => u.includes("relay")), "nothing sent to relay when over limit");
  r = await placeOrder({ symbol: "ITC.NS", side: "SELL", qty: 8, order_type: "MARKET", product: "MIS" }, SECRETS(), { fetchImpl: f });
  assert.equal(r.ok, true); assert.equal(r.order_id, "250101000123"); assert.equal(r.value, 4800);
  r = await placeOrder({ symbol: "ITC.NS", side: "BUY", qty: 1, order_type: "LIMIT", price: 10, product: "CNC" }, { ...SECRETS(), order_relay: {} }, { fetchImpl: f });
  assert.match(r.error, /Order relay/);
  r = await placeOrder({ symbol: "ITC.NS", side: "BUY", qty: 1, order_type: "LIMIT", price: 10, product: "CNC" }, { ...SECRETS(), kite: { api_key: "kk" } }, { fetchImpl: f });
  assert.match(r.error, /Login with Zerodha/);
});

test("admin: order needs login + confirm, blocks double-click, keeps a log", async () => {
  const m = new Map(), store = { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) };
  const env = { ADMIN_PASSWORD: "correct horse", KEYS_SECRET: "b".repeat(64) }, H = "https://s.example";
  const f = async (url, o) => {
    if (url.startsWith("https://relay.example/order")) {
      const r = await handleRelay({ method: "POST", path: "/order", body: o.body, headers: { "x-relay-signature": o.headers["x-relay-signature"] } }, { secret: SECRET, fetchImpl: kiteFake([]) });
      return okRes(r.json, r.status); }
    throw new Error(url); };
  let jar = "";
  const call = async (path, body) => {
    const res = await handleAdmin(new Request(H + "/api/admin/" + path, { method: body ? "POST" : "GET", headers: { origin: H, cookie: jar, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), { adminStore: store, dataStore: store, env, fetchImpl: f });
    const sc = res.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  const ord = { symbol: "ITC.NS", side: "BUY", qty: 2, order_type: "LIMIT", price: 280, product: "CNC", confirm: true };
  assert.equal((await call("order", ord)).status, 401, "not logged in");
  await call("login", { password: "correct horse" });
  for (const [prov, values] of Object.entries(SECRETS())) {
    if (prov === "kite") { await call("keys", { provider: "kite", values: { api_key: "kk", api_secret: "s" } }); continue; }
    await call("keys", { provider: prov, values });
  }
  let st = (await call("status")).body;
  assert.deepEqual(st.trading, { relay: true, kite: false, limits: { max_qty: 10, max_value: 5000 } });
  // pretend Zerodha login happened today
  const { loadSecrets, saveSecrets } = await import("../lib/secrets.mjs");
  const all = await loadSecrets(store, env); all.kite = { ...all.kite, access_token: "tok", token_at: new Date().toISOString() }; await saveSecrets(store, all, env);
  assert.equal((await call("order", { ...ord, confirm: false })).status, 400);
  const first = await call("order", ord);
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.order_id, "250101000123");
  assert.equal((await call("order", ord)).status, 429, "double click blocked");
  const log = (await call("orders")).body.orders;
  assert.equal(log.length, 1); assert.equal(log[0].ok, true); assert.equal(log[0].order.tradingsymbol, "ITC");
  assert.ok(!m.get("secrets").includes(SECRET), "relay secret stored encrypted");
});
