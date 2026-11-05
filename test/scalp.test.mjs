// Scalping bracket engine: entry -> target, trigger -> cancel target -> SL limit, chase after N seconds.
import test from "node:test";
import assert from "node:assert/strict";
import { Bracket, checkPlan, tickFloor, isOpen } from "../public/scalpengine.mjs";

function rig(plan = {}, opts = {}) {
  let t = 1_000_000, n = 0;
  const calls = [];
  const actions = {
    place: async (o) => { calls.push(["place", o]); if (opts.placeFail?.(o)) throw new Error("Zerodha: RMS reject"); return "O" + ++n; },
    cancel: async (id) => { calls.push(["cancel", id]); if (opts.cancelFail?.(id)) throw new Error("cannot cancel"); },
    modify: async (id, ch) => { calls.push(["modify", id, ch]); },
  };
  const b = new Bracket({ qty: 4, entry: 100, target: 110, slTrigger: 93, slLimit: 94, chaseSec: 30, ...plan }, actions, { now: () => t });
  return { b, calls, adv: (s) => (t += s * 1000), last: () => calls[calls.length - 1] };
}

test("checkPlan: user's example is fine, bad ones are refused", () => {
  assert.equal(checkPlan({ qty: 4, entry: 100, target: 110, slTrigger: 93, slLimit: 94, chaseSec: 30 }), null);
  assert.match(checkPlan({ qty: 4, entry: 100, target: 99, slTrigger: 93, slLimit: 94, chaseSec: 30 }), /Target/);
  assert.match(checkPlan({ qty: 4, entry: 100, target: 110, slTrigger: 101, slLimit: 94, chaseSec: 30 }), /trigger/);
  assert.match(checkPlan({ qty: 4, entry: 100, target: 110, slTrigger: 93, slLimit: 100, chaseSec: 30 }), /SL limit/);
  assert.match(checkPlan({ qty: 2.5, entry: 100, target: 110, chaseSec: 30 }), /Quantity/);
  assert.match(checkPlan({ qty: 4, entry: 100, target: "", slTrigger: "", chaseSec: 30 }), /kam se kam/);
  assert.match(checkPlan({ qty: 4, entry: 100, target: 110, slTrigger: 93, slLimit: 94, chaseSec: 1 }), /Chase/);
  assert.equal(tickFloor(97.37), 97.35); assert.equal(tickFloor(97.35), 97.35); assert.ok(isOpen("open") && !isOpen("COMPLETE"));
});

test("entry fills -> target SELL LIMIT for the filled qty -> target hit = done", async () => {
  const { b, calls } = rig();
  await b.start();
  assert.deepEqual(calls[0], ["place", { side: "BUY", price: 100, qty: 4 }]); assert.equal(b.state, "entry_open");
  await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4, average_price: 100 });
  assert.deepEqual(calls[1], ["place", { side: "SELL", price: 110, qty: 4 }]); assert.equal(b.state, "active");
  await b.onTick(105);
  await b.onOrder({ order_id: "O2", status: "COMPLETE", filled_quantity: 4, average_price: 110 });
  assert.equal(b.state, "done"); assert.equal(b.reason, "Target hit"); assert.equal(calls.length, 2);
});

test("price touches trigger 93 -> target cancelled first, THEN SL limit 94 (never two sells open)", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(95); assert.equal(b.state, "active", "95 is above trigger: nothing happens");
  await b.onTick(93);
  assert.equal(b.state, "sl_armed"); assert.deepEqual(calls[2], ["cancel", "O2"]); assert.equal(calls.length, 3, "SL not placed before cancel is confirmed");
  await b.onTick(92.5); assert.equal(calls.length, 3, "no second cancel within 3 s");
  await b.onOrder({ order_id: "O2", status: "CANCELLED" });
  assert.deepEqual(calls[3], ["place", { side: "SELL", price: 94, qty: 4 }]); assert.equal(b.state, "sl_open");
  await b.onTick(96); assert.equal(b.state, "sl_open", "trigger fires once: price coming back does not undo the SL");
  await b.onOrder({ order_id: "O3", status: "COMPLETE", filled_quantity: 4, average_price: 94 });
  assert.equal(b.state, "done"); assert.equal(b.reason, "Stop-loss exit");
});

test("SL not filled in 30 s -> SL order price moved to the current price, again every 30 s", async () => {
  const { b, calls, adv } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(93); await b.onOrder({ order_id: "O2", status: "CANCELLED" });
  adv(29); await b.onTick(91.2); assert.equal(calls.length, 4, "not yet at 29 s");
  adv(1); await b.onTick(91.23);
  assert.deepEqual(calls[4], ["modify", "O3", { price: 91.2 }]); assert.equal(b.o.sl.price, 91.2);
  adv(10); await b.onTick(90); assert.equal(calls.length, 5);
  adv(20); await b.onTick(89.9); assert.deepEqual(calls[5], ["modify", "O3", { price: 89.9 }]);
  await b.onOrder({ order_id: "O3", status: "COMPLETE", filled_quantity: 4, average_price: 89.9 });
  assert.equal(b.state, "done"); assert.equal(b.o.sl.chases, 2);
});

test("cancel confirmation arriving while the cancel call is still busy: next tick places the SL", async () => {
  let release; const hold = new Promise((r) => (release = r));
  const { b, calls } = rig();
  b.a.cancel = async (id) => { calls.push(["cancel", id]); await hold; };
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  const p = b.onTick(93);
  await b.onOrder({ order_id: "O2", status: "CANCELLED" });     // WebSocket was faster than the HTTP reply
  release(); await p;
  assert.equal(b.state, "sl_armed"); assert.equal(b.o.sl, null);
  await b.onTick(92.8);
  assert.deepEqual(calls[3], ["place", { side: "SELL", price: 94, qty: 4 }]); assert.equal(b.state, "sl_open");
});

test("target filled before the cancel went through -> done, no SL", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(93);
  await b.onOrder({ order_id: "O2", status: "COMPLETE", filled_quantity: 4, average_price: 110 });
  assert.equal(b.state, "done"); assert.equal(calls.filter((c) => c[0] === "place").length, 2);
});

test("target partly filled then cancelled -> SL only for what is left", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onOrder({ order_id: "O2", status: "OPEN", filled_quantity: 3 });
  await b.onTick(93); await b.onOrder({ order_id: "O2", status: "CANCELLED", filled_quantity: 3 });
  assert.deepEqual(calls[3], ["place", { side: "SELL", price: 94, qty: 1 }]);
});

test("refused target cancel is retried after 3 s", async () => {
  let fails = 1;
  const { b, calls, adv } = rig({}, { cancelFail: () => fails-- > 0 });
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(93); assert.equal(b.state, "sl_armed");
  adv(1); await b.onTick(92); assert.equal(calls.filter((c) => c[0] === "cancel").length, 1);
  adv(3); await b.onTick(92); assert.equal(calls.filter((c) => c[0] === "cancel").length, 2);
});

test("partial entry then cancelled -> protects the filled part", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "OPEN", filled_quantity: 2 });
  await b.onTick(92.9);                                           // falling while entry is half filled
  assert.deepEqual(calls[1], ["cancel", "O1"]);
  await b.onOrder({ order_id: "O1", status: "CANCELLED", filled_quantity: 2 });
  assert.deepEqual(calls[2], ["place", { side: "SELL", price: 110, qty: 2 }]);
  // last price is still below trigger -> protect() checks it at once: target cancel starts
  assert.equal(b.state, "sl_armed"); assert.deepEqual(calls[3], ["cancel", "O2"]);
});

test("entry rejected / cancelled with nothing filled -> done, nothing else sent", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "REJECTED", status_message: "Insufficient funds" });
  assert.equal(b.state, "done"); assert.match(b.reason, /Insufficient funds/); assert.equal(calls.length, 1);
  const r = rig(); await r.b.start(); await r.b.cancelEntry(); assert.deepEqual(r.calls[1], ["cancel", "O1"]);
  await r.b.onOrder({ order_id: "O1", status: "CANCELLED" }); assert.equal(r.b.state, "done");
});

test("SL rejected or cancelled from outside -> error state (user must check Kite)", async () => {
  const { b } = rig({ target: "" });
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(93); assert.equal(b.state, "sl_open", "no target: SL placed straight away");
  await b.onOrder({ order_id: "O2", status: "REJECTED", status_message: "Margin" });
  assert.equal(b.state, "error"); assert.match(b.reason, /Kite/);
});

test("same update twice (WebSocket + polling) is handled once", async () => {
  const { b, calls } = rig();
  await b.start();
  await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onOrder({ order_id: "XYZ", status: "COMPLETE" });       // someone else's order: ignored
  assert.equal(calls.length, 2);
});

test("Exit now: target is cancelled and the position sold at the current price, then chased", async () => {
  const { b, calls, adv } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(103.33); await b.exitNow();
  assert.deepEqual(calls[2], ["cancel", "O2"]);
  await b.onOrder({ order_id: "O2", status: "CANCELLED" });
  assert.deepEqual(calls[3], ["place", { side: "SELL", price: 103.3, qty: 4 }]);
  adv(30); await b.onTick(102); assert.deepEqual(calls[4], ["modify", "O3", { price: 102 }]);
  await b.onOrder({ order_id: "O3", status: "COMPLETE", filled_quantity: 4 }); assert.equal(b.reason, "Exit ho gaya");
  const r = rig(); await r.b.start(); assert.equal(await r.b.exitNow(), false); assert.equal(r.b.state, "entry_open", "no position: no error");
});

test("Exit now while the SL is open: SL order moved to the current price", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  await b.onTick(93); await b.onOrder({ order_id: "O2", status: "CANCELLED" });
  await b.onTick(92.07); await b.exitNow(); assert.deepEqual(calls[4], ["modify", "O3", { price: 92.05 }]);
});

test("stop(): no more actions; toJSON/restore keeps the plan and orders", async () => {
  const { b, calls } = rig();
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  const copy = Bracket.restore(JSON.parse(JSON.stringify(b)), b.a, { now: () => 0 });
  assert.equal(copy.state, "active"); assert.equal(copy.o.target.id, "O2"); assert.equal(copy.p.slLimit, 94);
  b.stop(); await b.onTick(80); assert.equal(calls.length, 2); assert.equal(b.state, "stopped");
});

test("target placement refused by Zerodha -> stays active, SL still works", async () => {
  const { b, calls } = rig({}, { placeFail: (o) => o.side === "SELL" && o.price === 110 });
  await b.start(); await b.onOrder({ order_id: "O1", status: "COMPLETE", filled_quantity: 4 });
  assert.equal(b.state, "active"); assert.ok(b.o.lostTarget);
  await b.onTick(93); assert.deepEqual(calls[calls.length - 1], ["place", { side: "SELL", price: 94, qty: 4 }]);
});
