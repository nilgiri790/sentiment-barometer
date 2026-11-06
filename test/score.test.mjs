// Our rule score (public/scalpscore.mjs) + its place in the AI report card and auto-trade settings.
import test from "node:test";
import assert from "node:assert/strict";
import { confluence, scoreFor } from "../public/scalpscore.mjs";
import { signalStats, cleanAuto, addSignal } from "../lib/journal.mjs";

const row = (k, ceChg, peChg) => [k, `CE${k}`, 100, 1000, ceChg, `PE${k}`, 100, 1000, peChg];
const bull = {
  index: { ind1m: { ema9: 101, ema21: 100, rsi14: 62 }, ind5m: { ema9: 101, ema21: 100 } },
  chain: { atm: 52000, pcr: 1.2, rows: [row(51900, 100, 900), row(52000, 200, 800), row(52100, 100, 700)] },
  market: { future: { last: 52300, vwap: 52250 }, heavyweights: [["HDFCBANK", 0.5], ["ICICIBANK", 0.3], ["SBIN", -0.2]] },
};

test("score: all 7 factors up -> CE 7/7, PE 0/7, WAIT has no score", () => {
  const c = confluence(bull);
  assert.equal(c.n, 7); assert.equal(c.bull, 7); assert.equal(c.bear, 0);
  assert.deepEqual(scoreFor(c, "BUY_CE"), { agree: 7, n: 7, side: 1 });
  assert.equal(scoreFor(c, "BUY_PE").agree, 0);
  assert.equal(scoreFor(c, "WAIT").agree, null);
});

test("score: mixed / neutral factors and missing data", () => {
  const c = confluence({ index: { ind1m: { ema9: 99, ema21: 100, rsi14: 50 } }, chain: { pcr: 0.9, atm: 1, rows: [row(1, 500, 520)] } });
  assert.equal(c.n, 4, "1m trend, RSI, PCR, OI (no 5m, no future, no heavyweights)");
  assert.equal(c.bear, 1, "only the 1m trend is down"); assert.equal(c.bull, 0, "RSI 50, PCR 0.9 and equal OI are neutral");
  assert.equal(confluence({}).n, 0); assert.equal(scoreFor(confluence({}), "BUY_CE"), null);
});

test("report card groups signals by our score; settings keep minScore 0..7", async () => {
  const list = [
    { confidence: 80, type: "CE", score: 6, scoreN: 7, outcome: "target" },
    { confidence: 75, type: "CE", score: 3, scoreN: 7, outcome: "sl" },
    { confidence: 60, type: "PE", score: 4, scoreN: 7, outcome: "target" },
    { confidence: 60, type: "PE", outcome: "none" },
  ];
  const s = signalStats(list);
  assert.deepEqual([s.scHi.n, s.scHi.hitRate, s.scMid.n, s.scLo.n, s.both.n], [1, 100, 1, 1, 1]);
  assert.equal(cleanAuto({ minScore: 5 }).minScore, 5); assert.equal(cleanAuto({ minScore: 9 }).minScore, 0); assert.equal(cleanAuto({}).minScore, 0);
  const mem = new Map(), store = { get: async (k) => mem.get(k) ?? null, setJSON: async (k, v) => mem.set(k, v) };
  const r = await addSignal(store, { id: "a1", entry: 100, target: 110, stopLoss: 95, outcome: "target", score: 5, scoreN: 7 });
  assert.equal(r.signals[0].score, 5); assert.equal(r.signals[0].scoreN, 7);
  assert.equal((await addSignal(store, { id: "a2", entry: 100 })).signals[0].score, null);
});
