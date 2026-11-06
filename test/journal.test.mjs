// Trade journal: clean rows (P&L after charges worked out on the server), AI / rule review, memory for the AI, auto guard.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanTrade, ruleReview, addTrade, getJournal, promptMemory, clearPaper, autoGuard, bumpAuto, saveAuto, getAuto, todayAI } from "../lib/journal.mjs";
import { buildTradePrompt } from "../lib/aitrade.mjs";
import { handleAdmin } from "../lib/admin.mjs";

const mem = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const NOW = Date.parse("2026-11-06T11:00:00+05:30");
const T = { id: "t1", at: "2026-11-06T10:40:00+05:30", closedAt: "2026-11-06T10:46:00+05:30", mode: "paper", source: "ai", index: "BANKNIFTY", symbol: "BANKNIFTY26NOV52100PE.NFO",
  name: "BANKNIFTY 25 NOV 26 52100 PE", type: "PE", qty: 35, lots: 1, entry: 100, exit: 94, exitReason: "sl", mfe: 0.5, mae: 7, durationSec: 360,
  plan: { target: 110, slTrigger: 93, slLimit: 94, chaseSec: 30 }, signal: { confidence: 62, reasons: ["PE long buildup"] }, net: 999999, charges: 0 };
const claude = (obj, calls = []) => async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn" }) }; };

test("clean row: P&L and charges are worked out on the server, page values ignored", () => {
  const { trade } = cleanTrade(T, NOW);
  assert.equal(trade.gross, -210); assert.ok(trade.charges > 40 && trade.charges < 60); assert.equal(trade.net, Math.round((trade.gross - trade.charges) * 100) / 100);
  assert.equal(trade.day, "2026-11-06"); assert.equal(trade.mode, "paper"); assert.equal(trade.source, "ai");
  assert.match(cleanTrade({ qty: 0, entry: 100 }).error, /theek nahi/);
  assert.doesNotMatch(cleanTrade({ ...T, name: "<b>x</b>" }).trade.name, /[<>]/);
});

test("rule review explains SL loss and gives a lesson; target win too", () => {
  const { trade } = cleanTrade(T, NOW);
  const r = ruleReview(trade);
  assert.match(r.reason, /SL trigger 93\.00/); assert.match(r.reason, /max \+0\.50 upar aur −7\.00/); assert.match(r.lesson, /turant baad daam ulta/); assert.equal(r.by, "rule");
  const w = ruleReview(cleanTrade({ ...T, exit: 110, exitReason: "target" }, NOW).trade);
  assert.match(w.reason, /Target 110\.00 par bhara/); assert.equal(w.tag, "good_trade");
});

test("addTrade: AI review (counts one AI call), dedupe by id, rule when no key, clear paper", async () => {
  const adminStore = mem(), calls = [];
  const o = { adminStore, apiKey: "sk", model: "claude-haiku-5-5", fetchImpl: claude({ reason: "Index VWAP ke upar chala gaya, PE ulta pada.", lesson: "Trend ke khilaaf PE mat lo.", tag: "against_trend" }, calls), now: NOW };
  let r = await addTrade({ trade: T }, o);
  assert.equal(r.trade.review.by, "ai"); assert.match(r.trade.review.lesson, /Trend ke khilaaf/); assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.equal(JSON.parse(adminStore.m.get("ai-usage")).used, 1);
  r = await addTrade({ trade: T }, o); assert.equal(calls.length, 1, "same id is not added or reviewed twice"); assert.equal((await getJournal(adminStore)).length, 1);
  r = await addTrade({ trade: { ...T, id: "t2", mode: "real" } }, { ...o, apiKey: "" });
  assert.equal(r.trade.review.by, "rule");
  assert.deepEqual((await clearPaper(adminStore)).map((t) => t.id), ["t2"]);
});

test("memory for the AI: stats + lessons from losses go into the trade prompt", async () => {
  const s = mem(), o = { adminStore: s, apiKey: "", now: NOW };
  await addTrade({ trade: T }, o);
  await addTrade({ trade: { ...T, id: "t3", exit: 112, exitReason: "target", type: "CE", signal: { confidence: 75 } } }, o);
  const m = promptMemory(await getJournal(s));
  assert.match(m, /last 2 trades: 1 wins \(50%\)/); assert.match(m, /LOSS BANKNIFTY 25 NOV 26 52100 PE \(sl/); assert.match(m, /PE: 1 trades, 0 wins/);
  const p = buildTradePrompt({ index: { name: "NIFTY BANK" }, chain: { rows: [] } }, [], {}, m);
  assert.match(p, /YOUR PAST TRADES/); assert.match(p, /do not repeat the same mistakes/);
  assert.equal(promptMemory([]), "");
});

test("auto guard for REAL AI orders: trade count, lots, daily loss", async () => {
  const s = mem();
  assert.deepEqual(await getAuto(s), { lots: 1, maxTrades: 5, maxLoss: 1000, minConf: 65 });
  await saveAuto(s, { maxTrades: 2, maxLoss: 200, lots: 2, minConf: 10 });
  assert.equal((await getAuto(s)).minConf, 65, "bad value -> default kept");
  assert.equal(await autoGuard(s, { lots: 1 }, NOW), null);
  assert.match(await autoGuard(s, { lots: 3 }, NOW), /max 2 lot/);
  await bumpAuto(s, NOW); await bumpAuto(s, NOW);
  assert.match(await autoGuard(s, { lots: 1 }, NOW), /trade limit \(2\)/);
  assert.equal(await autoGuard(s, { lots: 1 }, NOW + 864e5), null, "new day");
  const s2 = mem(); await saveAuto(s2, { maxTrades: 5, maxLoss: 200 });
  await addTrade({ trade: { ...T, id: "r1", mode: "real" } }, { adminStore: s2, apiKey: "", now: NOW });
  const t = todayAI(await getJournal(s2), "real", NOW); assert.equal(t.trades, 1); assert.ok(t.net < -200);
  assert.match(await autoGuard(s2, { lots: 1 }, NOW), /max nuksan ₹200/);
  assert.equal(await autoGuard(s2, { lots: 1 }, NOW + 864e5), null, "next day starts fresh");
});

test("admin: journal + ai-auto endpoints need login; auto BUY refused over the limit", async () => {
  const adminStore = mem(), dataStore = mem(), env = { ADMIN_PASSWORD: "pw123456", KEYS_SECRET: "f".repeat(64) };
  const call = async (path, method = "GET", body, cookie = "") => handleAdmin(new Request("https://x.test/api/admin/" + path, { method, headers: { "content-type": "application/json", cookie, origin: "https://x.test" }, body: body ? JSON.stringify(body) : undefined }), { adminStore, dataStore, env, fetchImpl: async () => { throw new Error("no net"); } });
  assert.equal((await call("journal")).status, 401);
  const login = await call("login", "POST", { password: "pw123456" }); const ck = login.headers.get("set-cookie").split(";")[0];
  let r = await call("journal", "POST", { op: "add", trade: { ...T, at: new Date().toISOString() } }, ck); assert.equal(r.status, 200);
  r = await (await call("journal", "GET", null, ck)).json(); assert.equal(r.trades.length, 1);
  r = await (await call("ai-auto", "POST", { auto: { maxTrades: 1 } }, ck)).json(); assert.equal(r.auto.maxTrades, 1);
  r = await (await call("ai-usage", "GET", null, ck)).json(); assert.equal(r.auto.maxTrades, 1); assert.equal(r.today.paper.trades, 1); assert.equal(r.today.real.trades, 0);
  await bumpAuto(adminStore);
  r = await call("order", "POST", { confirm: true, auto: true, side: "BUY", symbol: "BANKNIFTY26NOV52000CE.NFO", lots: 1 }, ck);
  assert.equal(r.status, 429); assert.match((await r.json()).error, /trade limit \(1\)/);
});

test("risk rules: kill switch by day loss, losing streak, trade count; server refuses real scalp BUYs", async () => {
  const { cleanRisk, saveRisk, riskToday, riskGuard, getRisk } = await import("../lib/risk.mjs");
  assert.equal(cleanRisk({ sqoffAt: "16:00", spreadPct: 99 }).sqoffAt, "15:15"); assert.equal(cleanRisk({ spreadPct: 99 }).spreadPct, 2);
  const s = mem(); await saveRisk(s, { maxConsecLoss: 2, maxLossDay: 5000 });
  const now = Date.now(), at = new Date(now - 600e3).toISOString();
  for (const id of ["a", "b"]) await addTrade({ trade: { ...T, id, mode: "real", at, closedAt: at, riskAmt: 250, plannedEntry: 99.5 } }, { adminStore: s, apiKey: "", now });
  const j = await getJournal(s);
  assert.equal(j[0].r, Math.round((j[0].net / 250) * 100) / 100, "R-multiple"); assert.equal(j[0].slip, 0.5, "paid 0.50 more than planned");
  const t = riskToday(j, "real", await getRisk(s), now);
  assert.equal(t.consec, 2); assert.match(t.locked, /Lagataar 2/);
  assert.match(await riskGuard(s, now), /Kill switch/);
  assert.equal(riskToday(j, "paper", await getRisk(s), now).locked, null, "paper and real are counted apart");
  await saveRisk(s, { maxConsecLoss: 5, maxLossDay: 300 });
  assert.match(riskToday(j, "real", await getRisk(s), now).locked, /max nuksan ₹300/);
});

test("AI report card: signals saved once, stats by confidence / type, memory line for the prompt; plan levels cleaned", async () => {
  const { addSignal, getSignals, signalStats, signalMemory } = await import("../lib/journal.mjs");
  const { cleanPlan, parseSignal } = await import("../lib/aitrade.mjs");
  const s = mem(), base = { index: "BANKNIFTY", symbol: "X.NFO", name: "X", entry: 100, target: 110, stopLoss: 94, at: new Date().toISOString() };
  await addSignal(s, { ...base, id: "s1", type: "CE", confidence: 80, outcome: "target" });
  await addSignal(s, { ...base, id: "s1", type: "CE", confidence: 80, outcome: "target" });
  await addSignal(s, { ...base, id: "s2", type: "PE", confidence: 60, outcome: "sl" });
  await addSignal(s, { ...base, id: "s3", type: "CE", confidence: 75, outcome: "none" });
  const l = await getSignals(s); assert.equal(l.length, 3, "deduped");
  const st = signalStats(l); assert.equal(st.hi.n, 2); assert.equal(st.hi.target, 1); assert.equal(st.lo.sl, 1); assert.equal(st.all.hitRate, 33);
  assert.match(signalMemory(l), /YOUR LAST 3 SIGNALS/); assert.match(signalMemory(l), /Confidence 70\+: 2 signals: target first 1/);
  assert.match((await addSignal(s, { id: "x" })).error, /theek nahi/);
  const P = { index: { spot: 52140 }, chain: { rows: [] } };
  assert.deepEqual(cleanPlan({ above: 52250.4, below: 51990, note: "VWAP" }, P), { above: 52250, below: 51990, note: "VWAP" });
  assert.equal(cleanPlan({ above: 51000, below: 52000 }, P), null, "above must be over below");
  assert.equal(cleanPlan({ above: 60000, below: 51000 }, P), null, "too far from the spot");
  assert.deepEqual(parseSignal(JSON.stringify({ signal: "WAIT", plan: { above: 52300, below: 52000 } }), P).plan, { above: 52300, below: 52000, note: "" });
});

test("weekly AI review: one Haiku call over the last 7 days, saved; needs trades and a key", async () => {
  const { weekReview } = await import("../lib/journal.mjs");
  const s = mem(), calls = [];
  assert.match((await weekReview(s, { apiKey: "" })).error, /Claude key/);
  assert.match((await weekReview(s, { apiKey: "sk" })).error, /koi poora trade nahi/);
  await addTrade({ trade: { ...T, at: new Date().toISOString() } }, { adminStore: s, apiKey: "", now: Date.now() });
  const r = await weekReview(s, { apiKey: "sk", fetchImpl: claude({ summary: "Revenge trades ne nuksan kiya.", strengths: ["SL hamesha lagaya"], mistakes: ["2 baje ke baad trade"], rules: ["Loss ke baad 10 min ruko"] }, calls) });
  assert.equal(r.status, 200); assert.equal(r.review.trades, 1); assert.deepEqual(r.review.rules, ["Loss ke baad 10 min ruko"]);
  assert.match(calls[0].messages[0].content, /strict, experienced options trading coach/); assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.equal((await s.get("week-review")).summary, "Revenge trades ne nuksan kiya.");
});
