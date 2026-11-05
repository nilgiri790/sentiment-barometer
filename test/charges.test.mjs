// Zerodha option charges estimate (BUY + SELL).
import test from "node:test";
import assert from "node:assert/strict";
import { optionCharges } from "../public/charges.mjs";

test("user's example: 30 qty, buy 267.25, sell at target 277.25", () => {
  const c = optionCharges({ buy: 267.25 * 30, sell: 277.25 * 30 });
  assert.equal(c.brokerage, 40, "₹20 buy + ₹20 sell");
  assert.equal(c.stt, 12, "0.15% of 8317.50 sell premium, rounded");
  assert.equal(c.txn, 5.72); assert.equal(c.stamp, 0.24); assert.equal(c.sebi, 0.02);
  assert.equal(c.gst, 8.23, "18% of brokerage + exchange + SEBI");
  assert.equal(c.total, 66.21);
});

test("only a buy (still open): one brokerage, no STT", () => {
  const c = optionCharges({ buy: 10000 });
  assert.equal(c.brokerage, 20); assert.equal(c.stt, 0); assert.ok(c.total > 20 && c.total < 30);
});
