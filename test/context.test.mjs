// Market context: futures from the NFO list, VIX / future / heavyweights from one quote call, previous-day CPR + pivots.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFuts } from "../lib/options.mjs";
import { marketContext, levelsFrom } from "../lib/context.mjs";

const HEAD = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n";
const CSV = HEAD + "9001,1,BANKNIFTY26DECFUT,\"BANKNIFTY\",0,2026-12-30,0,0.05,35,FUT,NFO-FUT,NFO\n9000,1,BANKNIFTY26NOVFUT,\"BANKNIFTY\",0,2026-11-25,0,0.05,35,FUT,NFO-FUT,NFO\n"
  + "9002,1,RELIANCE26NOVFUT,\"RELIANCE\",0,2026-11-25,0,0.05,500,FUT,NFO-FUT,NFO\n9003,1,BANKNIFTY26NOV52000CE,\"BANKNIFTY\",0,2026-11-25,52000,0.05,35,CE,NFO-OPT,NFO\n";
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => b });
const mem = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const K = { api_key: "k", access_token: "t", token_at: new Date().toISOString() };

test("futures parsing: only index futures, nearest first", () => {
  const f = parseFuts(CSV);
  assert.deepEqual(f.map((r) => r[0]), ["BANKNIFTY26NOVFUT", "BANKNIFTY26DECFUT"]); assert.equal(f[0][3], 35); assert.equal(f[0][4], 9000);
});

test("CPR + pivots from the previous day", () => {
  const l = levelsFrom({ h: 52500, l: 51900, c: 52300 });
  assert.equal(l.cpr.p, 52233.33); assert.equal(l.cpr.bc, 52200); assert.equal(l.cpr.tc, 52266.67);
  assert.equal(l.pivots.r1, 52566.67); assert.equal(l.pivots.s1, 51966.67);
});

test("market context: one quote call (index, VIX, nearest future, heavyweights) + previous finished day", async () => {
  const calls = [], now = Date.parse("2026-11-06T11:00:00+05:30");
  const f = async (url) => {
    calls.push(url);
    if (url.endsWith("/instruments/NFO")) return ok(CSV);
    if (url.includes("/quote?")) { const ids = [...url.matchAll(/i=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      return ok({ data: Object.fromEntries(ids.map((i, n) => [i, { instrument_token: 100 + n, last_price: i.includes("VIX") ? 13.2 : 1000 + n, ohlc: { close: 990, open: 995 }, oi: i.startsWith("NFO") ? 2500000 : undefined, average_price: 1001 }])) }); }
    if (url.includes("/historical/")) return ok({ data: { candles: [["2026-11-04T00:00:00+0530", 1, 52400, 51800, 52100, 0], ["2026-11-05T00:00:00+0530", 1, 52500, 51900, 52300, 0], ["2026-11-06T00:00:00+0530", 1, 52600, 52200, 52450, 0]] } });
    throw new Error("unexpected " + url);
  };
  const c = await marketContext("BANKNIFTY", K, mem(), f, now);
  const q = calls.find((u) => u.includes("/quote?"));
  assert.match(q, /NSE%3ANIFTY%20BANK/); assert.match(q, /NSE%3AINDIA%20VIX/); assert.match(q, /NFO%3ABANKNIFTY26NOVFUT/); assert.match(q, /NSE%3AHDFCBANK/);
  assert.equal(c.vix.last, 13.2); assert.equal(c.fut.symbol, "BANKNIFTY26NOVFUT.NFO"); assert.equal(c.fut.oi, 2500000); assert.equal(c.fut.avg, 1001);
  assert.deepEqual(c.index.prevDay, { date: "2026-11-05", h: 52500, l: 51900, c: 52300 }, "today's candle is skipped");
  assert.equal(c.index.cpr.p, 52233.33); assert.equal(c.heavy.length, 6); assert.equal(c.heavy[0].sym, "HDFCBANK");
  await assert.rejects(() => marketContext("FINNIFTY", K, mem(), f, now), /sirf BANKNIFTY/);
});
