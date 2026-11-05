// Scalping AI trade assistant: prompt, signal checks, daily limit, Haiku model, news from saved data.
import test from "node:test";
import assert from "node:assert/strict";
import { aiTrade, parseSignal, buildTradePrompt, getUsage, setLimit, newsFor, TRADE_MODEL } from "../lib/aitrade.mjs";

const mem = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const NOW = Date.parse("2026-11-05T11:00:00+05:30");
const P = {
  contract: { symbol: "BANKNIFTY26NOV52000CE.NFO", underlying: "BANKNIFTY", type: "CE", strike: 52000, expiry: "2026-11-25", ltp: 412.5, greeks: { iv: 14.2, delta: 0.56 } },
  underlying: { name: "NIFTY BANK", spot: 52140 },
  chain: { columns: ["strike", "CE symbol", "CE ltp", "CE OI", "CE OI chg", "PE symbol", "PE ltp", "PE OI", "PE OI chg"], pcr: 0.92,
    rows: [[52000, "BANKNIFTY26NOV52000CE.NFO", 412.5, 90000, 5000, "BANKNIFTY26NOV52000PE.NFO", 280, 70000, -2000],
           [52100, "BANKNIFTY26NOV52100CE.NFO", 360, 80000, 1000, "BANKNIFTY26NOV52100PE.NFO", 330, 50000, 0]] },
};
const claude = (obj, calls = []) => async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }], stop_reason: "end_turn" }) }; };
const GOOD = { signal: "BUY_PE", symbol: "BANKNIFTY26NOV52100PE.NFO", confidence: 64, entry: 331.12, target: 360, stopLoss: 315, validMinutes: 10, summary: "PE mein momentum", reasons: ["CE OI +5000 at 52000 resistance"], risks: ["theta"] };

test("signal checks: good BUY kept (prices on 0.05 tick); bad ones become WAIT with a note", () => {
  const s = parseSignal("Here you go:\n" + JSON.stringify(GOOD), P);
  assert.equal(s.signal, "BUY_PE"); assert.equal(s.entry, 331.1); assert.equal(s.symbol, "BANKNIFTY26NOV52100PE.NFO");
  assert.match(parseSignal(JSON.stringify({ ...GOOD, symbol: "BANKNIFTY26NOV99999PE.NFO" }), P).note, /data mein nahi/);
  assert.match(parseSignal(JSON.stringify({ ...GOOD, symbol: "BANKNIFTY26NOV52100CE.NFO" }), P).note, /match nahi/);
  assert.match(parseSignal(JSON.stringify({ ...GOOD, stopLoss: 340 }), P).note, /entry\/target\/SL/);
  assert.match(parseSignal(JSON.stringify({ ...GOOD, entry: 200, target: 260, stopLoss: 180 }), P).note, /bahut door/);
  assert.equal(parseSignal(JSON.stringify({ signal: "SELL_CE" }), P).signal, "WAIT");
  assert.throws(() => parseSignal("no json here", P), /samajh nahi/);
});

test("prompt: buy-only rule, data, news, language from settings", () => {
  const t = buildTradePrompt({ ...P, question: "Abhi CE lena theek hai?" }, [{ hoursAgo: 1.5, title: "RBI keeps rates unchanged", source: "Mint", score: 0.3 }], { reportLang: "english" });
  assert.match(t, /ONLY BUYS options/); assert.match(t, /never suggest selling/); assert.match(t, /52140/);
  assert.match(t, /RBI keeps rates/); assert.match(t, /simple English/); assert.match(t, /Abhi CE lena/);
});

test("aiTrade: Haiku call, counts usage, stops at the daily limit, limit can be changed", async () => {
  const adminStore = mem(), dataStore = mem(), calls = [];
  await dataStore.setJSON("articles-NIFTY BANK", [{ title: "Banks rally on credit growth", source: "ET", published: new Date(NOW - 2 * 36e5).toISOString(), score: 0.5 },
    { title: "Old news", source: "ET", published: new Date(NOW - 5 * 864e5).toISOString() }]);
  await setLimit(adminStore, 2, NOW);
  const o = { adminStore, dataStore, apiKey: "sk-test", fetchImpl: claude(GOOD, calls), now: NOW };
  let r = await aiTrade({ payload: P }, o);
  assert.equal(r.status, 200); assert.equal(r.result.signal, "BUY_PE"); assert.equal(r.usage.used, 1); assert.equal(r.result.newsCount, 1);
  assert.equal(calls[0].model, TRADE_MODEL); assert.equal(TRADE_MODEL, "claude-haiku-5-5");
  assert.match(calls[0].messages[0].content, /Banks rally/); assert.doesNotMatch(calls[0].messages[0].content, /Old news/);
  r = await aiTrade({ payload: P }, o); assert.equal(r.usage.used, 2);
  r = await aiTrade({ payload: P }, o); assert.equal(r.status, 429); assert.match(r.error, /limit/); assert.equal(calls.length, 2, "no AI call over the limit");
  await assert.rejects(() => setLimit(adminStore, 0, NOW), /1 se/);
  assert.equal((await setLimit(adminStore, 5, NOW)).used, 2);
  assert.equal((await getUsage(adminStore, NOW + 864e5)).used, 0, "new day starts at 0");
  assert.equal((await aiTrade({ payload: {} }, o)).status, 400);
  assert.match((await aiTrade({ payload: P }, { ...o, apiKey: "" })).error, /Claude key/);
});

test("news: only the option's index, last 48 h, newest first, no duplicates", async () => {
  const s = mem();
  await s.setJSON("scan-NIFTY BANK", { headlines: [{ title: "A", published: new Date(NOW - 36e5).toISOString() }, { title: "B", published: new Date(NOW - 3 * 36e5).toISOString() }] });
  await s.setJSON("articles-NIFTY BANK", [{ title: "B", published: new Date(NOW - 3 * 36e5).toISOString() }]);
  const n = await newsFor(s, "BANKNIFTY", NOW);
  assert.deepEqual(n.map((x) => x.title), ["A", "B"]); assert.equal(n[0].hoursAgo, 1);
  assert.deepEqual(await newsFor(s, "NIFTY", NOW), []);
});
