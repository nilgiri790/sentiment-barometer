// Offline tests for the live chart: Kite binary ticks, candle building, /api/candles, admin ticker. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicks, applyTick, barsFromTicks, bucketOf, IST, orderUpdate } from "../public/kiteticks.mjs";
import { handlePrice } from "../lib/prices.mjs";
import { handleAdmin } from "../lib/admin.mjs";

// Build a Kite-style binary message: [count][len][packet]...
export function kitePacket(list) {
  const parts = list.map(({ len, ints }) => { const b = new ArrayBuffer(len), v = new DataView(b); ints.forEach((x, i) => v.setInt32(i * 4, x)); return b; });
  const total = 2 + parts.reduce((a, b) => a + 2 + b.byteLength, 0), out = new ArrayBuffer(total), v = new DataView(out), u = new Uint8Array(out);
  v.setInt16(0, parts.length); let off = 2;
  for (const p of parts) { v.setInt16(off, p.byteLength); u.set(new Uint8Array(p), off + 2); off += 2 + p.byteLength; }
  return out;
}

test("parse Kite ticks: quote, index, ltp, heartbeat", () => {
  const msg = kitePacket([
    { len: 44, ints: [408065, 41835, 10, 41800, 123456, 0, 0, 41000, 42000, 40500, 41120] },   // quote (share/option)
    { len: 28, ints: [260105, 5214000, 5230000, 5190000, 5200000, 5180000, 0] },              // index
    { len: 8, ints: [111, 9905] },                                                            // ltp mode
  ]);
  const t = parseTicks(msg);
  assert.deepEqual(t[0], { token: 408065, ltp: 418.35, volume: 123456, open: 410, high: 420, low: 405, close: 411.2, buyQty: 0, sellQty: 0 });
  assert.deepEqual(t[1], { token: 260105, ltp: 52140, index: true, high: 52300, low: 51900, open: 52000, close: 51800 });
  assert.deepEqual(t[2], { token: 111, ltp: 99.05 });
  assert.deepEqual(parseTicks(new ArrayBuffer(1)), [], "heartbeat");
});

test("ticks -> candles (IST buckets, OHLC, volume, late ticks ignored)", () => {
  const t0 = Date.parse("2026-11-05T04:00:00.200Z");          // 09:30:00 IST
  assert.equal(bucketOf(t0, 60), Math.floor(t0 / 1000 / 60) * 60 + IST);
  const ticks = [{ ms: t0, price: 100, dv: 5 }, { ms: t0 + 400, price: 102, dv: 3 }, { ms: t0 + 800, price: 99, dv: 1 },
                 { ms: t0 + 1200, price: 101, dv: 2 }, { ms: t0 + 10500, price: 103, dv: 4 }];
  const s1 = barsFromTicks(ticks, 1);
  assert.equal(s1.length, 3);
  assert.deepEqual({ ...s1[0], time: 0 }, { time: 0, open: 100, high: 102, low: 100, close: 102, volume: 8 });   // .200 and .600
  assert.deepEqual({ ...s1[1], time: 0 }, { time: 0, open: 99, high: 101, low: 99, close: 101, volume: 3 });     // 1.000 and 1.400
  const s10 = barsFromTicks(ticks, 10);
  assert.equal(s10.length, 2); assert.equal(s10[0].close, 101); assert.equal(s10[1].open, 103);
  const bars = barsFromTicks(ticks, 60);
  assert.equal(bars.length, 1); assert.equal(bars[0].high, 103); assert.equal(bars[0].volume, 15);
  assert.equal(applyTick(bars, t0 - 120000, 50, 1, 60), null, "tick older than the last candle is ignored");
  const day = barsFromTicks([{ ms: Date.parse("2026-11-05T09:50:00Z"), price: 1, dv: 0 }], 86400);
  assert.equal(new Date((day[0].time) * 1000).toISOString().slice(0, 10), "2026-11-05", "day candle = India date");
});

const KITE = { api_key: "kk", api_secret: "ss", access_token: "tok", token_at: new Date().toISOString() };
const ok = (b) => ({ ok: true, status: 200, json: async () => b });
test("/api/candles: Zerodha history with OHLCV and the token for live ticks", async () => {
  let asked = "";
  const f = async (url) => { if (url.includes("/quote")) return ok({ data: { "NSE:ITC": { instrument_token: 424961, last_price: 418.35, ohlc: { close: 411.2 } } } });
    asked = url; return ok({ data: { candles: [["2026-11-05T09:15:00+0530", 410, 412, 409, 411, 1000], ["2026-11-05T09:20:00+0530", 411, 415, 410, 414, 1500]] } }); };
  const r = await handlePrice(new Request("https://s/api/candles?sym=ITC.NS&interval=5minute"), { secrets: { kite: KITE }, fetchImpl: f });
  const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.instrument_token, 424961); assert.equal(d.prevClose, 411.2); assert.equal(d.source, "Zerodha");
  assert.deepEqual(d.candles[0], [Date.parse("2026-11-05T03:45:00Z") / 1000, 410, 412, 409, 411, 1000]);
  assert.match(asked, /\/instruments\/historical\/424961\/5minute\?from=/);
  assert.equal((await handlePrice(new Request("https://s/api/candles?sym=ITC.NS&interval=2minute"), { secrets: { kite: KITE }, fetchImpl: f })).status, 400);
  const o = await handlePrice(new Request("https://s/api/candles?sym=BANKNIFTY26NOV52000CE.NFO&interval=minute"), { secrets: {}, fetchImpl: f });
  assert.equal(o.status, 400); assert.match((await o.json()).error, /sirf Zerodha/);
});

test("admin ticker: login + today's Zerodha login needed", async () => {
  const m = new Map(), store = { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) };
  const env = { ADMIN_PASSWORD: "pw-123456", KEYS_SECRET: "d".repeat(64) }, H = "https://s.example"; let jar = "";
  const call = async (path, body) => { const res = await handleAdmin(new Request(H + "/api/admin/" + path, { method: body ? "POST" : "GET", headers: { origin: H, cookie: jar, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), { adminStore: store, dataStore: store, env });
    const sc = res.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0]; return { status: res.status, body: await res.json() }; };
  assert.equal((await call("ticker")).status, 401);
  await call("login", { password: "pw-123456" });
  assert.equal((await call("ticker")).status, 400, "no Zerodha login yet");
  const { loadSecrets, saveSecrets } = await import("../lib/secrets.mjs");
  const all = await loadSecrets(store, env); all.kite = { ...KITE }; await saveSecrets(store, all, env);
  assert.deepEqual((await call("ticker")).body, { api_key: "kk", access_token: "tok" });
});

test("full mode packet (184 bytes): best bid/ask + 5-level depth; order updates from text messages", () => {
  const buf = new ArrayBuffer(2 + 2 + 184), v = new DataView(buf);
  v.setInt16(0, 1); v.setInt16(2, 184); const p = 4;
  v.setInt32(p, 12345); v.setInt32(p + 4, 10125); v.setInt32(p + 16, 900); v.setInt32(p + 48, 77000);
  for (let i = 0; i < 5; i++) {
    v.setInt32(p + 64 + i * 12, 30 * (i + 1)); v.setInt32(p + 68 + i * 12, 10120 - i * 5); v.setInt16(p + 72 + i * 12, i + 1);
    v.setInt32(p + 124 + i * 12, 15 * (i + 1)); v.setInt32(p + 128 + i * 12, 10130 + i * 5); v.setInt16(p + 132 + i * 12, 2);
  }
  const [t] = parseTicks(buf);
  assert.equal(t.ltp, 101.25); assert.equal(t.bid, 101.2); assert.equal(t.ask, 101.3); assert.equal(t.oi, 77000);
  assert.equal(t.depth.buy.length, 5); assert.deepEqual(t.depth.buy[4], { qty: 150, price: 101, orders: 5 }); assert.equal(t.depth.sell[2].price, 101.4);
  assert.deepEqual(orderUpdate('{"type":"order","data":{"order_id":"1","status":"COMPLETE"}}'), { order_id: "1", status: "COMPLETE" });
  assert.equal(orderUpdate('{"type":"error","data":"x"}'), null); assert.equal(orderUpdate("not json"), null);
});
