// Paper broker + bracket engine together, and the trade result / stats maths.
import test from "node:test";
import assert from "node:assert/strict";
import { PaperBroker } from "../public/paperbroker.mjs";
import { Bracket } from "../public/scalpengine.mjs";
import { bracketResult, computeStats } from "../public/tradestats.mjs";

function rig(plan = {}) {
  let px = 100, t = 0; const ups = [];
  let b;
  const broker = new PaperBroker({ ltp: () => px, now: () => t, defer: (f) => f(), onUpdate: (u) => { ups.push(u); b?.onOrder(u); } });
  b = new Bracket({ qty: 30, entry: 100, target: 110, slTrigger: 93, slLimit: 94, chaseSec: 30, ...plan },
    { place: (o) => broker.place(o), cancel: (id) => broker.cancel(id), modify: (id, c) => broker.modify(id, c) }, { now: () => t });
  const tick = async (p) => { px = p; broker.tick(p); await b.onTick(p); await new Promise((r) => setImmediate(r)); };
  return { b, broker, tick, adv: (s) => (t += s * 1000), ups };
}

test("paper: entry fills on a tick, target fills at 110 -> done, result +300 gross", async () => {
  const { b, tick } = rig();
  await b.start(); assert.equal(b.state, "entry_open");
  await tick(100.3); assert.equal(b.state, "entry_open", "price above the buy limit: no fill");
  await tick(99.95); assert.equal(b.state, "active"); assert.equal(b.avg, 99.95, "buy fills at the better price");
  await tick(105); await tick(110.2);
  assert.equal(b.state, "done"); assert.equal(b.reason, "Target hit");
  const r = bracketResult(JSON.parse(JSON.stringify(b)));
  assert.equal(r.exitReason, "target"); assert.equal(r.exit, 110.2); assert.equal(r.gross, 307.5);
});

test("paper: trigger -> target cancelled -> SL 94 rests -> chase to the price -> fills", async () => {
  const { b, tick, adv } = rig();
  await b.start(); await tick(100);
  await tick(93); assert.equal(b.state, "sl_armed", "target cancel sent");
  await tick(92.9); assert.equal(b.state, "sl_open", "cancel confirmed -> SL placed on the next tick");
  assert.equal(b.o.sl.price, 94);
  await tick(92.6); assert.equal(b.state, "sl_open", "sell limit 94 does not fill at 92.60");
  adv(30); await tick(92.5);
  assert.equal(b.state, "done"); assert.equal(b.reason, "Stop-loss exit");
  const r = bracketResult(JSON.parse(JSON.stringify(b)));
  assert.equal(r.exitReason, "sl_chase"); assert.equal(r.exit, 92.5); assert.equal(r.gross, -225);
});

test("paper: broker refuses changes to finished orders; adopt() restores open orders after reload", async () => {
  const br = new PaperBroker({ ltp: () => 100, defer: (f) => f() });
  const id = await br.place({ side: "BUY", price: 99, qty: 30 });
  br.tick(98); await assert.rejects(() => br.cancel(id), /khula nahi/);
  const br2 = new PaperBroker({ ltp: () => 100, defer: (f) => f() });
  br2.adopt([{ id: "P7", side: "SELL", price: 110, qty: 30 }]);
  assert.equal(await br2.place({ side: "BUY", price: 1, qty: 1 }), "P8", "ids continue after adopted ones");
});

test("result for a partly filled target + SL rest, exit now, and stats", () => {
  const e = { filled: 60, avg: 100, p: { entry: 100 }, state: "done",
    o: { target: { status: "CANCELLED", filled: 30, avg: 110 }, sl: { status: "COMPLETE", filled: 30, avg: 95, chases: 0 } } };
  const r = bracketResult(e);
  assert.equal(r.qty, 60); assert.equal(r.exit, 102.5); assert.equal(r.gross, 150); assert.equal(r.exitReason, "sl");
  assert.equal(bracketResult({ ...e, o: { sl: { status: "COMPLETE", filled: 60, avg: 101, exit: true } } }).exitReason, "exit_now");
  assert.equal(bracketResult({ filled: 0 }), null);
  const s = computeStats([{ net: 200, type: "CE", signal: { confidence: 75 } }, { net: -100, type: "PE", signal: { confidence: 60 } }, { net: -50, type: "CE" }, { net: null }]);
  assert.equal(s.n, 3); assert.equal(s.wins, 1); assert.equal(s.winRate, 33); assert.equal(s.net, 50);
  assert.deepEqual(s.byType.CE, { n: 2, wins: 1, net: 150 }); assert.deepEqual(s.byConf["70+"], { n: 1, wins: 1, net: 200 });
  assert.equal(s.best, 200); assert.equal(s.worst, -100);
});
