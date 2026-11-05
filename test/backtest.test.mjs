// Offline tests for the backtest engine. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, prevExtreme, backtest, validateStrategy, TEMPLATES, describeRule } from "../public/btengine.mjs";

const mk = (closes) => closes.map((c, i) => ({ time: i * 86400, open: c, high: c, low: c, close: c, volume: 100 }));

test("indicators", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ema([1, 2, 3, 4, 5], 3); assert.equal(e[2], 2); assert.equal(e[3], 3); assert.equal(e[4], 4);
  const r = rsi([1, 2, 3, 4, 5, 6], 3); assert.equal(r[3], 100, "only gains -> 100");
  const r2 = rsi([10, 9, 10, 9, 10, 9, 10], 2); assert.ok(r2[2] > 0 && r2[2] < 100);
  assert.deepEqual(prevExtreme([1, 5, 2, 3], 2, true), [null, null, 5, 5]);
});

test("signal on close, fill at next open, exit rule", () => {
  // price rises above SMA(2) at index 3 -> buy at bar 4 open; drops below at index 6 -> sell at bar 7 open
  const bars = mk([10, 10, 10, 12, 13, 14, 9, 8, 8]);
  bars.forEach((b, i) => { b.open = b.close + 0.5; });          // opens differ so the fill price is visible
  const s = { name: "t", entry: { all: [{ left: { ind: "close" }, op: ">", right: { ind: "sma", n: 2 } }] }, exit: { any: [{ left: { ind: "close" }, op: "<", right: { ind: "sma", n: 2 } }] } };
  const r = backtest(bars, s, { capital: 1000, costPct: 0 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryTime, 4 * 86400); assert.equal(r.trades[0].entryPrice, 13.5);
  assert.equal(r.trades[0].exitTime, 7 * 86400); assert.equal(r.trades[0].exitPrice, 8.5); assert.equal(r.trades[0].reason, "exit rule");
  assert.equal(r.trades[0].qty, Math.floor(1000 / 13.5));
  assert.ok(r.stats.returnPct < 0); assert.ok(r.stats.maxDrawdownPct > 0);
});

test("stop-loss and target inside the candle (stop first), costs, open position", () => {
  const bars = mk([100, 100, 101, 102, 103, 104]);
  bars[3].low = 90;                                             // stop hit on bar 3
  const s = { entry: { all: [{ left: { ind: "close" }, op: ">", right: { value: 99 } }] }, exit: { any: [] }, stopLossPct: 5 };
  const r = backtest(bars, s, { capital: 10000, costPct: 0.1 });
  assert.equal(r.trades[0].reason, "stop-loss"); assert.equal(r.trades[0].exitPrice, 95);
  assert.ok(r.trades[0].pnl < -5 * r.trades[0].qty, "costs make it a bit worse than -5%");
  const t = backtest(mk([100, 100, 100, 120, 120]).map((b, i) => (i === 3 ? { ...b, high: 130 } : b)),
    { entry: { all: [{ left: { ind: "close" }, op: ">", right: { value: 99 } }] }, exit: { any: [] }, takeProfitPct: 10 }, { costPct: 0 });
  assert.equal(t.trades[0].reason, "target"); assert.equal(t.trades[0].exitPrice, 120, "gap above target fills at open");
  assert.ok(t.open, "re-entered and still open at the end");
});

test("crossovers and templates run", () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + 20 * Math.sin(i / 15) + i * 0.05);
  const bars = closes.map((c, i) => ({ time: i * 86400, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 + i }));
  for (const [k, t] of Object.entries(TEMPLATES)) {
    const r = backtest(bars, t.build(t.params));
    assert.ok(!r.error, k + ": " + r.error); assert.ok(r.trades.length >= 1, k + " made trades");
    assert.equal(r.equity.length, bars.length);
  }
  assert.match(describeRule(TEMPLATES.sma_cross.build({ fast: 20, slow: 50 }).entry.all[0]), /SMA\(20\) ne SMA\(50\) ko upar cross kiya/);
});

test("validation refuses bad / unsafe strategies", () => {
  assert.match(validateStrategy({ entry: { all: [] } }).error, /entry/);
  assert.match(validateStrategy({ entry: { all: [{ left: { ind: "eval" }, op: ">", right: { value: 1 } }] } }).error, /entry/);
  assert.match(validateStrategy({ entry: { all: [{ left: { ind: "close" }, op: "==", right: { value: 1 } }] } }).error, /entry/);
  assert.match(validateStrategy({ entry: { all: [{ left: { ind: "close" }, op: ">", right: { value: 1 } }] }, exit: { any: [] } }).error, /bahar/);
  assert.match(validateStrategy({ entry: { all: [{ left: { ind: "sma", n: 9999 }, op: ">", right: { value: 1 } }] }, stopLossPct: 2 }).error, /entry/);
  const ok = validateStrategy({ name: "x", entry: { all: [{ left: { ind: "rsi" }, op: "<", right: { value: "30" } }] }, exit: { any: [] }, takeProfitPct: "5" });
  assert.deepEqual(ok.strategy.entry.all[0], { left: { ind: "rsi", n: 14 }, op: "<", right: { value: 30 } }); assert.equal(ok.strategy.takeProfitPct, 5);
});

import { aiAnalyze, aiStrategy, analyzePrompt } from "../lib/aianalyze.mjs";
const store = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const claudeSays = (text, seen = []) => async (url, o) => { seen.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) }; };

test("AI analyze: data + question in the prompt, language from settings", async () => {
  const st = store(); await st.setJSON("settings", { reportLang: "english" });
  const seen = [], candles = Array.from({ length: 450 }, (_, i) => [1762300000 + i * 86400, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000]);
  const r = await aiAnalyze({ symbol: "ITC.NS", name: "ITC", interval: "day", stats: { changePct: 12.3 }, candles, prompt: "Trend kya hai?" }, st,
    { apiKey: "k", model: "m", fetchImpl: claudeSays("## Trend\n- Up", seen) });
  assert.equal(r.answer, "## Trend\n- Up");
  const p = seen[0].messages[0].content;
  assert.match(p, /Trend kya hai\?/); assert.match(p, /simple English/); assert.match(p, /changePct/);
  assert.equal((p.match(/^\d{4}-\d\d-\d\d,/gm) || []).length, 400, "last 400 candles only");
  await assert.rejects(aiAnalyze({ prompt: "x" }, st, { apiKey: "", model: "m", fetchImpl: claudeSays("") }), /Claude key/);
  await assert.rejects(aiAnalyze({ prompt: " " }, st, { apiKey: "k", model: "m", fetchImpl: claudeSays("") }), /sawaal/);
});

test("AI strategy: JSON checked by the engine's validator; junk refused", async () => {
  const good = '{"name":"RSI dip","entry":{"all":[{"left":{"ind":"rsi","n":14},"op":"<","right":{"value":30}}]},"exit":{"any":[{"left":{"ind":"rsi","n":14},"op":">","right":{"value":60}}]},"stopLossPct":3}';
  const r = await aiStrategy({ prompt: "rsi 30 pe lo", interval: "day" }, { apiKey: "k", model: "m", fetchImpl: claudeSays("Sure: " + good) });
  assert.equal(r.strategy.stopLossPct, 3); assert.deepEqual(r.rules.entry, ["RSI(14) < 30"]);
  await assert.rejects(aiStrategy({ prompt: "x" }, { apiKey: "k", model: "m", fetchImpl: claudeSays('{"entry":{"all":[{"left":{"ind":"process.exit"},"op":">","right":{"value":1}}]}}') }), /samajh nahi/);
  await assert.rejects(aiStrategy({ prompt: "x" }, { apiKey: "k", model: "m", fetchImpl: claudeSays("no json here") }), /samajh nahi/);
});
