// Zerodha-side stop-loss, breakeven, trailing stop and time exit (paper broker + bracket engine), plus the trade result.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperBroker } from "../public/paperbroker.mjs";
import { Bracket, hardLimit } from "../public/scalpengine.mjs";
import { bracketResult } from "../public/tradestats.mjs";

function rig(plan = {}, { noSL = false } = {}) {
  let px = 100, t = 0; let b; const calls = [];
  const broker = new PaperBroker({ ltp: () => px, now: () => t, defer: (f) => f(), onUpdate: (u) => b?.onOrder(u) });
  const actions = { place: (o) => (calls.push(["place", o]), broker.place(o)), cancel: (id) => (calls.push(["cancel", id]), broker.cancel(id)),
    modify: (id, c) => (calls.push(["modify", id, c]), broker.modify(id, c)) };
  if (!noSL) { actions.placeSL = (o) => (calls.push(["placeSL", o]), broker.placeSL(o)); actions.modifySL = (id, c) => (calls.push(["modifySL", id, c]), broker.modifySL(id, c)); }
  b = new Bracket({ qty: 30, entry: 100, target: 110, slTrigger: 93, slLimit: 94, chaseSec: 30, hardSl: true, ...plan }, actions, { now: () => t });
  const tick = async (p) => { px = p; broker.tick(p); await b.onTick(p); await new Promise((r) => setImmediate(r)); };
  return { b, broker, calls, tick, adv: (s) => (t += s * 1000) };
}

test("Zerodha SL: after the fill a SELL SL (trigger 93, limit 3% below) waits on Zerodha; no target order is placed", async () => {
  const { b, calls, tick } = rig();
  await b.start(); await tick(100);
  assert.equal(b.state, "active");
  const sl = calls.find((c) => c[0] === "placeSL");
  assert.deepEqual(sl[1], { side: "SELL", trigger: 93, price: hardLimit(93), qty: 30 }); assert.equal(hardLimit(93), 90.2);
  assert.equal(calls.filter((c) => c[0] === "place").length, 1, "only the BUY: target is watched by the page");
  assert.equal(b.o.hard.status, "TRIGGER PENDING");
});

test("Zerodha SL: price falls -> the exchange order triggers and fills; result = stop-loss", async () => {
  const { b, tick } = rig();
  await b.start(); await tick(100); await tick(95); await tick(92.5);
  assert.equal(b.state, "done"); assert.equal(b.reason, "Stop-loss exit");
  const r = bracketResult(JSON.parse(JSON.stringify(b)));
  assert.equal(r.exitReason, "sl"); assert.equal(r.exit, 92.5); assert.equal(r.hardSl, true);
});

test("Zerodha SL: target reached -> SL cancelled first, then sold at the current price (one SELL at a time)", async () => {
  const { b, calls, tick } = rig();
  await b.start(); await tick(100); await tick(110.4);
  assert.ok(calls.some((c) => c[0] === "cancel" && c[1] === b.o.hard.id));
  await tick(110.3); await tick(110.3);
  const sells = calls.filter((c) => c[0] === "place" && c[1].side === "SELL");
  assert.equal(sells.length, 1); assert.equal(sells[0][1].price, 110.3);
  assert.equal(b.state, "done"); assert.equal(b.reason, "Target hit");
  assert.equal(bracketResult(JSON.parse(JSON.stringify(b))).exitReason, "target");
});

test("breakeven + trailing move the Zerodha SL up (never down), and a trailed stop exit is 'trail_sl'", async () => {
  const { b, calls, tick, adv } = rig({ beAt: 5, trailBy: 4, target: 130 });
  await b.start(); await tick(100);
  await tick(104); assert.equal(b.p.slTrigger, 93, "less than +5: nothing moves");
  adv(4); await tick(105.2);
  assert.equal(b.p.slTrigger, 101.2, "+5 reached: breakeven to 100, trail 105.2-4 = 101.2");
  adv(1); await tick(108); assert.equal(b.p.slTrigger, 101.2, "moves at most once every 3 s");
  adv(3); await tick(108.1); assert.equal(b.p.slTrigger, 104.1);
  adv(4); await tick(106); assert.equal(b.p.slTrigger, 104.1, "never moves down");
  const mods = calls.filter((c) => c[0] === "modifySL"); assert.equal(mods.length, 2); assert.equal(mods[1][2].price, hardLimit(104.1));
  await tick(104);                                         // hits the trailed stop on Zerodha
  assert.equal(b.state, "done"); assert.equal(b.reason, "Trailing SL exit");
  const r = bracketResult(JSON.parse(JSON.stringify(b))); assert.equal(r.exitReason, "trail_sl"); assert.ok(r.gross > 0);
});

test("page SL mode: breakeven moves the page trigger + limit together; time exit sells after maxHoldSec", async () => {
  const { b, tick, adv } = rig({ hardSl: false, beAt: 3, maxHoldSec: 120 });
  await b.start(); await tick(100);
  await tick(103.5); assert.equal(b.p.slTrigger, 100); assert.equal(b.p.slLimit, 101, "keeps your trigger -> limit gap (93 -> 94)");
  adv(121); await tick(102);
  assert.equal(b.state, "sl_armed", "time exit: target cancel sent first");
  await tick(102); await tick(102);
  assert.equal(b.state, "done"); assert.equal(b.reason, "Time exit");
  assert.equal(bracketResult(JSON.parse(JSON.stringify(b))).exitReason, "time_exit");
});

test("Zerodha SL refused (old relay) -> falls back to the page SL with a target order; triggered SL is chased", async () => {
  const f = rig({}, { noSL: true });
  await f.b.start(); await f.tick(100);
  assert.equal(f.b.p.hardSl, false); assert.equal(f.b.o.target.price, 110, "page mode: target order placed");
  const g = rig();
  g.b.a.placeSL = async () => { throw new Error("order type must be MARKET or LIMIT"); };
  await g.b.start(); await g.tick(100);
  assert.equal(g.b.hardFailed, true); assert.match(g.b.events.map((e) => e.msg).join("|"), /SL is page se chalega/);
  const h = rig();
  await h.b.start(); await h.tick(100);
  h.broker.orders.get(h.b.o.hard.id).price = 92.9;         // limit just under the trigger, price falls past it: triggered, not filled
  await h.tick(92); assert.equal(h.b.o.hard.status, "OPEN");
  h.adv(30); await h.tick(91);
  assert.equal(h.b.state, "done", "re-priced to the current price and filled"); assert.equal(bracketResult(JSON.parse(JSON.stringify(h.b))).exitReason, "sl_chase");
});

test("Exit now with a Zerodha SL: SL cancelled, then sold at the price; restore keeps the hard SL", async () => {
  const { b, calls, tick } = rig();
  await b.start(); await tick(100); await tick(101.07);
  await b.exitNow(); await tick(101.07); await tick(101.07);
  assert.ok(calls.some((c) => c[0] === "cancel")); assert.equal(b.state, "done"); assert.equal(b.reason, "Exit ho gaya");
  const r = rig(); await r.b.start(); await r.tick(100);
  const copy = Bracket.restore(JSON.parse(JSON.stringify(r.b)), r.b.a, { now: () => 0 });
  assert.equal(copy.p.hardSl, true); assert.equal(copy.o.hard.status, "TRIGGER PENDING"); assert.deepEqual(copy.openOrderIds(), [r.b.o.hard.id]);
});

test("entry fills when the price is already under the stop: no stop order, sold at once (counts as stop-loss)", async () => {
  const { b, calls, tick } = rig();
  await b.start(); await tick(100.2);                       // no fill yet (limit 100)
  b.ltp = 92;                                               // price fell before the fill update arrived
  await b.onOrder({ order_id: b.o.entry.id, status: "COMPLETE", filled_quantity: 30, average_price: 100 });
  assert.ok(!calls.some((c) => c[0] === "placeSL"), "no Zerodha SL above the market");
  await tick(92); await tick(92);
  assert.equal(b.state, "done"); assert.equal(b.reason, "Stop-loss exit");
  assert.equal(bracketResult(JSON.parse(JSON.stringify(b))).exitReason, "sl");
});
