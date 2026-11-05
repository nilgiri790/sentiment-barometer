// Option analytics: Black-Scholes, IV, Greeks, chain summary (PCR, max pain, OI build-up), indicators.
import test from "node:test";
import assert from "node:assert/strict";
import { bsPrice, impliedVol, greeks, contractGreeks, yearsToExpiry, chainSummary, maxPain, buildup, indicatorSummary, resample } from "../public/optanalytics.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("Black-Scholes matches the textbook value and put-call parity", () => {
  // S=100 K=100 T=1 r=5% sigma=20% -> call 10.4506, put 5.5735
  near(bsPrice(100, 100, 1, 0.2, "CE", 0.05), 10.4506, 1e-3, "call");
  near(bsPrice(100, 100, 1, 0.2, "PE", 0.05), 5.5735, 1e-3, "put");
  assert.equal(bsPrice(100, 90, 0, 0.2, "CE"), 10, "expired = intrinsic");
});

test("implied vol round-trips; impossible prices give null", () => {
  const S = 52140, K = 52000, T = 10 / 365;
  for (const sig of [0.1, 0.15, 0.3]) for (const t of ["CE", "PE"]) near(impliedVol(bsPrice(S, K, T, sig, t), S, K, T, t), sig, 1e-4, `${t} ${sig}`);
  assert.equal(impliedVol(100, S, 50000, T, "CE"), null, "below intrinsic");
  assert.equal(impliedVol(0, S, K, T, "CE"), null);
});

test("greeks have the right signs and sizes", () => {
  const ce = greeks(52140, 52000, 7 / 365, 0.14, "CE"), pe = greeks(52140, 52000, 7 / 365, 0.14, "PE");
  assert.ok(ce.delta > 0.5 && ce.delta < 0.7 && pe.delta < 0 && pe.delta > -0.5);
  near(ce.delta - pe.delta, 1, 1e-9, "delta parity");
  assert.ok(ce.gamma > 0 && ce.theta < 0 && ce.vega > 0);
  const g = contractGreeks({ ltp: 900, spot: 52140, strike: 52000, expiry: "2026-11-25", type: "CE" }, Date.parse("2026-11-05T10:00:00+05:30"));
  assert.ok(g.iv > 5 && g.iv < 60 && g.delta > 0.5 && g.daysToExpiry > 20 && g.daysToExpiry < 21, JSON.stringify(g));
  near(yearsToExpiry("2026-11-05", Date.parse("2026-11-05T09:30:00+05:30")) * 365 * 24, 6, 1e-6, "6 hours to 15:30");
});

test("chain summary: PCR, support/resistance by OI, max pain, OI change + build-up", () => {
  const c = (s, ltp, oi) => ({ symbol: s, ltp, oi });
  const rows = [51800, 51900, 52000, 52100, 52200].map((k, i) => ({ strike: k,
    ce: c(`C${k}`, 400 - i * 80, [20, 30, 50, 90, 120][i] * 1000), pe: c(`P${k}`, 60 + i * 80, [110, 95, 60, 30, 15][i] * 1000) }));
  const base = new Map([["C52200", { ltp: 100, oi: 100000 }], ["P51800", { ltp: 70, oi: 130000 }]]);
  const s = chainSummary(rows, 52040, "2026-11-25", base, Date.parse("2026-11-05T10:00:00+05:30"));
  assert.equal(s.resistance, 52200); assert.equal(s.support, 51800); assert.equal(s.atm, 52000);
  assert.equal(s.pcr, +(310 / 310).toFixed(2));
  assert.equal(s.topChanges[0].symbol, "P51800"); assert.equal(s.topChanges[0].dOi, -20000); assert.equal(s.topChanges[0].buildup, "long unwinding");
  assert.equal(s.topChanges[1].buildup, "short buildup", "C52200: price 100 -> 80, OI up");
  assert.equal(maxPain(rows), s.maxPain);
  assert.equal(buildup(2, 500), "long buildup"); assert.equal(buildup(1, -5), "short covering"); assert.equal(buildup(1, 0), null);
});

test("indicator summary on 1-minute bars + resample to 5 minutes", () => {
  const t0 = Math.floor(Date.parse("2026-11-05T09:15:00Z") / 1000);
  const bars = Array.from({ length: 60 }, (_, i) => { const c = 100 + i * 0.5; return { time: t0 + i * 60, open: c - 0.2, high: c + 0.3, low: c - 0.4, close: c, volume: 1000 }; });
  const s = indicatorSummary(bars);
  assert.equal(s.trend, "up"); assert.ok(s.rsi14 > 70); assert.ok(s.ema9 > s.ema21); assert.equal(s.chg5, 2.5); assert.equal(s.dayHigh, 129.8);
  const r5 = resample(bars, 300);
  assert.equal(r5.length, 12); assert.equal(r5[0].open, 99.8); assert.equal(r5[0].close, 102); assert.equal(r5[0].volume, 5000);
});
