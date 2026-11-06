// Trade journal for the Scalping page (Blobs store "admin" key "journal", last 300 trades): every finished bracket, paper or
// real, AI or manual, with its P&L after charges, why it made / lost money (AI review, or a simple rule when AI is not
// available) and one lesson. The lessons and stats go back into the AI's trade prompt so it can learn from past trades.
// Also: AI auto-trade settings ("ai-auto") and the server-side guard for real AI orders ("auto-count").
import { claudeMessage } from "./claude.mjs";
import { istDate } from "./prices.mjs";
import { optionCharges } from "../public/charges.mjs";
import { computeStats, EXIT_TXT } from "../public/tradestats.mjs";
import { getUsage } from "./aitrade.mjs";

export const MAX_TRADES = 300;
const KEY = "journal";
const num = (v, lo = -1e9, hi = 1e9) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const str = (v, n = 120) => (v == null ? "" : String(v).replace(/[<>]/g, "").slice(0, n));
const strs = (a, n = 6, len = 200) => (Array.isArray(a) ? a.slice(0, n).map((x) => str(x, len)).filter(Boolean) : []);
const r2 = (x) => Math.round(x * 100) / 100;

export async function getJournal(store) { const l = await store.get(KEY, { type: "json" }); return Array.isArray(l) ? l : []; }

// what the page sends -> a clean row; charges and net are worked out here (never trusted from the page)
export function cleanTrade(t = {}, now = Date.now()) {
  const qty = Math.round(num(t.qty, 0, 100000) || 0), entry = num(t.entry, 0, 1e6), exit = t.exit == null ? null : num(t.exit, 0, 1e6);
  if (!qty || !entry) return { error: "trade theek nahi" };
  const at = Number.isFinite(Date.parse(t.at)) ? new Date(t.at).toISOString() : new Date(now).toISOString();
  const row = {
    id: str(t.id, 40) || `${Date.now()}`, at, closedAt: Number.isFinite(Date.parse(t.closedAt)) ? new Date(t.closedAt).toISOString() : new Date(now).toISOString(),
    day: istDate(Date.parse(at)), mode: t.mode === "real" ? "real" : "paper", source: t.source === "ai" ? "ai" : "manual",
    index: ["BANKNIFTY", "NIFTY"].includes(t.index) ? t.index : "", symbol: str(t.symbol, 40), name: str(t.name, 60), type: t.type === "PE" ? "PE" : "CE",
    qty, lots: Math.round(num(t.lots, 0, 1000) || 0), entry, exit, exitReason: EXIT_TXT[t.exitReason] ? t.exitReason : "error",
    durationSec: Math.round(num(t.durationSec, 0, 86400) || 0), mfe: num(t.mfe, 0, 1e6), mae: num(t.mae, 0, 1e6), chases: Math.round(num(t.chases, 0, 1000) || 0),
    plan: { target: num(t.plan?.target, 0, 1e6), slTrigger: num(t.plan?.slTrigger, 0, 1e6), slLimit: num(t.plan?.slLimit, 0, 1e6), chaseSec: num(t.plan?.chaseSec, 0, 600) },
    setup: ["breakout", "vwap", "oi", "reversal", "range", "ai", "other"].includes(t.setup) ? t.setup : null,
    mood: ["planned", "fomo", "revenge", "bored"].includes(t.mood) ? t.mood : null,
    plannedEntry: num(t.plannedEntry, 0, 1e6), riskAmt: num(t.riskAmt, 0, 1e9), hardSl: !!t.hardSl, expiryDay: !!t.expiryDay,
    signal: t.signal ? { confidence: num(t.signal.confidence, 0, 100), summary: str(t.signal.summary, 300), reasons: strs(t.signal.reasons) } : null,
    ctx: t.ctx ? { spot: num(t.ctx.spot), pcr: num(t.ctx.pcr, 0, 100), atmIv: num(t.ctx.atmIv, 0, 500), maxPain: num(t.ctx.maxPain), support: num(t.ctx.support), resistance: num(t.ctx.resistance) } : null,
  };
  if (exit != null) {
    const ch = optionCharges({ buy: entry * qty, sell: exit * qty });
    row.gross = r2((exit - entry) * qty); row.charges = ch.total; row.net = r2(row.gross - ch.total);
    row.r = row.riskAmt ? r2(row.net / row.riskAmt) : null;                  // R-multiple: result in units of the money risked
    row.slip = row.plannedEntry ? r2(entry - row.plannedEntry) : null;        // paid more (+) / less (-) than planned
  } else { row.gross = row.charges = row.net = null; }
  return { trade: row };
}

// plain-language reason + lesson without AI
export function ruleReview(t) {
  const d = t.exit != null ? r2(t.exit - t.entry) : null, f2 = (v) => (v == null ? "–" : (+v).toFixed(2));
  let reason;
  if (t.exitReason === "target") reason = `Target ${f2(t.plan?.target)} par bhara: daam entry ${f2(t.entry)} se ${f2(d)} upar gaya.`;
  else if (t.exitReason === "sl") reason = `Daam SL trigger ${f2(t.plan?.slTrigger)} tak gira, ${f2(t.exit)} par bechna pada.`;
  else if (t.exitReason === "sl_chase") reason = `SL ${f2(t.plan?.slLimit)} par nahi bika, ${t.chases} baar daam badal kar ${f2(t.exit)} par bika.`;
  else if (t.exitReason === "trail_sl") reason = `Trailing SL ne munafa bachaya: stop upar khisak kar ${f2(t.exit)} par bika.`;
  else if (t.exitReason === "time_exit") reason = `Tay samay mein target / SL nahi hua, isliye ${f2(t.exit)} par bahar nikle.`;
  else if (t.exitReason === "exit_now") reason = `Exit now se ${f2(t.exit)} par becha (${d >= 0 ? "+" : ""}${f2(d)}).`;
  else reason = "Trade beech mein band hua (Managing band / gadbad). Kite mein position check kariye.";
  if (t.mfe != null && t.mae != null) reason += ` Entry ke baad daam max +${f2(t.mfe)} upar aur −${f2(t.mae)} neeche gaya.`;
  if (t.charges && Math.abs(t.gross) < t.charges * 1.5) reason += ` Charges ₹${f2(t.charges)} ne munafa ka bada hissa kha liya.`;
  const tgtDist = t.plan?.target ? t.plan.target - t.entry : null;
  let lesson = "";
  if (t.net > 0) lesson = "Setup kaam kiya: aise hi saaf trend + OI support wale trade dobara dekhiye.";
  else if (tgtDist && t.mfe != null && t.mfe >= tgtDist * 0.6) lesson = "Daam target ke kareeb pahunch kar palta: target thoda paas rakhiye ya munafa mein SL upar khiskaiye.";
  else if (t.mfe != null && t.mfe < 1) lesson = "Entry ke turant baad daam ulta chala: entry se pehle trend aur VWAP ki pushti kariye.";
  else if (t.exitReason === "sl_chase") lesson = "SL par fill nahi mila: tez girte market mein SL limit trigger ke paas rakhiye.";
  else lesson = "Direction galat nikli: mixed signal mein WAIT behtar hai.";
  return { reason, lesson, tag: t.net > 0 ? "good_trade" : "loss", by: "rule" };
}

export function reviewPrompt(t, lang = "Hinglish (Hindi words in English letters, simple)") {
  return `You are reviewing ONE finished intraday index option trade (the trader only buys options). Explain in 1-2 short sentences
why it made or lost money, using the numbers (entry, exit, plan, how far the price moved for / against = mfe / mae, time held,
charges, the market context and the reasons given at entry). Then give ONE short, concrete lesson for the next trade.
Write in ${lang}. Return ONLY JSON: {"reason":"...","lesson":"...","tag":"good_trade|bad_entry|late_entry|sl_too_tight|target_too_far|against_trend|theta|charges|other"}

TRADE (JSON):
${JSON.stringify({ ...t, review: undefined })}`;
}
export function parseReview(text) {
  const m = String(text).match(/\{[\s\S]*\}/); let j;
  try { j = JSON.parse(m ? m[0] : text); } catch { return null; }
  if (!j?.reason) return null;
  return { reason: str(j.reason, 400), lesson: str(j.lesson, 250), tag: str(j.tag, 30) || "other", by: "ai" };
}

// add one trade (deduped by id) and review it: AI when a key + daily AI calls are left, else the simple rule
export async function addTrade(body, { adminStore, apiKey, model, lang, fetchImpl = fetch, now = Date.now() }) {
  const { trade, error } = cleanTrade(body.trade, now);
  if (error) return { status: 400, error };
  const list = await getJournal(adminStore);
  const old = list.find((x) => x.id === trade.id);
  if (old) return { status: 200, trade: old, trades: list };
  trade.review = ruleReview(trade);
  if (apiKey && trade.net != null) {
    const u = await getUsage(adminStore, now);
    if (u.used < u.limit) {
      await adminStore.setJSON("ai-usage", { day: u.day, used: u.used + 1, limit: u.limit });
      try { const r = await claudeMessage({ apiKey, model, prompt: reviewPrompt(trade, lang), maxTokens: 400, timeoutMs: 7000, fetchImpl }); trade.review = parseReview(r.text) || trade.review; } catch {}
    }
  }
  list.unshift(trade);
  await adminStore.setJSON(KEY, list.slice(0, MAX_TRADES));
  return { status: 200, trade, trades: list.slice(0, MAX_TRADES) };
}
export async function clearPaper(adminStore) {
  const list = (await getJournal(adminStore)).filter((t) => t.mode !== "paper");
  await adminStore.setJSON(KEY, list); return list;
}

// short memory for the AI's next trade decision
export function promptMemory(trades) {
  const recent = trades.filter((t) => t.net != null).slice(0, 30);
  if (!recent.length) return "";
  const s = computeStats(recent), g = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v.n} trades, ${v.wins} wins, net ₹${v.net}`).join("; ");
  const lessons = recent.filter((t) => t.net <= 0 && t.review?.lesson).slice(0, 6).map((t) => `- LOSS ${t.name} (${t.exitReason}, net ₹${t.net}): ${t.review.lesson}`);
  const good = recent.filter((t) => t.net > 0 && t.review?.lesson).slice(0, 2).map((t) => `- WIN ${t.name} (net ₹${t.net}): ${t.review.lesson}`);
  return `YOUR PAST TRADES on this page (learn from them; do not repeat the same mistakes):
- last ${s.n} trades: ${s.wins} wins (${s.winRate}%), net ₹${s.net} after charges, avg win ₹${s.avgWin ?? 0}, avg loss ₹${s.avgLoss ?? 0}
- by type: ${g(s.byType) || "-"}; by your confidence: ${g(s.byConf) || "-"}
${[...lessons, ...good].join("\n")}`;
}

// ---- AI auto-trade settings + server guard for REAL AI orders ----
export const AUTO_DEFAULTS = { lots: 1, maxTrades: 5, maxLoss: 1000, minConf: 65, minScore: 0 };
export async function getAuto(store) {
  const s = (await store.get("ai-auto", { type: "json" })) || {};
  return cleanAuto({ ...AUTO_DEFAULTS, ...s });
}
export function cleanAuto(s = {}) {
  const i = (v, lo, hi, d) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : d; };
  return { lots: i(s.lots, 1, 50, AUTO_DEFAULTS.lots), maxTrades: i(s.maxTrades, 1, 50, AUTO_DEFAULTS.maxTrades),
    maxLoss: i(s.maxLoss, 100, 1000000, AUTO_DEFAULTS.maxLoss), minConf: i(s.minConf, 30, 95, AUTO_DEFAULTS.minConf), minScore: i(s.minScore, 0, 7, AUTO_DEFAULTS.minScore) };
}
export async function saveAuto(store, s) { const c = cleanAuto({ ...(await getAuto(store)), ...s }); await store.setJSON("ai-auto", c); return c; }

// today's AI numbers for one mode (paper / real)
export function todayAI(trades, mode, now = Date.now()) {
  const day = istDate(now), list = trades.filter((t) => t.source === "ai" && t.mode === mode && t.day === day);
  return { trades: list.length, net: r2(list.reduce((a, t) => a + (t.net || 0), 0)) };
}
// returns an error text when a REAL AI order must be refused
export async function autoGuard(store, body, now = Date.now()) {
  const s = await getAuto(store), day = istDate(now);
  const c = (await store.get("auto-count", { type: "json" })) || {};
  const n = c.day === day ? c.n || 0 : 0;
  if (n >= s.maxTrades) return `AI ki aaj ki trade limit (${s.maxTrades}) poori ho gayi.`;
  if (Number(body.lots) > s.lots) return `AI ek trade mein max ${s.lots} lot le sakta hai.`;
  const t = todayAI(await getJournal(store), "real", now);
  if (t.net <= -s.maxLoss) return `AI ka aaj ka max nuksan ₹${s.maxLoss} pahunch gaya, isliye AI ka naya order roka.`;
  return null;
}
export async function bumpAuto(store, now = Date.now()) {
  const day = istDate(now), c = (await store.get("auto-count", { type: "json" })) || {};
  await store.setJSON("auto-count", { day, n: (c.day === day ? c.n || 0 : 0) + 1 });
}

// ---- AI report card: every AI signal (traded or not) and what happened next on the live price ----
const SIG = "signals";
export async function getSignals(store) { const l = await store.get(SIG, { type: "json" }); return Array.isArray(l) ? l : []; }
export async function addSignal(store, x = {}) {
  const sig = { id: str(x.id, 40), at: Number.isFinite(Date.parse(x.at)) ? new Date(x.at).toISOString() : new Date().toISOString(), index: ["BANKNIFTY", "NIFTY"].includes(x.index) ? x.index : "",
    symbol: str(x.symbol, 40), name: str(x.name, 60), type: x.type === "PE" ? "PE" : "CE", confidence: num(x.confidence, 0, 100), entry: num(x.entry, 0, 1e6), target: num(x.target, 0, 1e6),
    stopLoss: num(x.stopLoss, 0, 1e6), outcome: ["target", "sl", "none"].includes(x.outcome) ? x.outcome : "none", minutes: num(x.minutes, 0, 600), mfe: num(x.mfe, -1e6, 1e6), mae: num(x.mae, -1e6, 1e6), taken: !!x.taken,
    score: x.score == null || x.score === "" ? null : num(x.score, 0, 10), scoreN: x.scoreN == null || x.scoreN === "" ? null : num(x.scoreN, 0, 10) };
  if (!sig.id || !sig.entry) return { error: "signal theek nahi" };
  const list = await getSignals(store);
  if (!list.some((s) => s.id === sig.id)) { list.unshift(sig); await store.setJSON(SIG, list.slice(0, 500)); }
  return { signals: list.slice(0, 500) };
}
export function signalStats(list) {
  const done = list.filter((s) => s.outcome !== undefined), b = (f) => { const g = done.filter(f), t = g.filter((s) => s.outcome === "target").length, l = g.filter((s) => s.outcome === "sl").length;
    return { n: g.length, target: t, sl: l, none: g.length - t - l, hitRate: g.length ? Math.round((t / g.length) * 100) : null }; };
  const sc = (s) => (s.score != null && s.scoreN ? s.score / s.scoreN : null);                 // our rule score: share of factors that agree
  return { all: b(() => true), hi: b((s) => s.confidence >= 70), lo: b((s) => s.confidence < 70), ce: b((s) => s.type === "CE"), pe: b((s) => s.type === "PE"),
    scHi: b((s) => sc(s) != null && sc(s) >= 0.7), scMid: b((s) => sc(s) != null && sc(s) >= 0.5 && sc(s) < 0.7), scLo: b((s) => sc(s) != null && sc(s) < 0.5),
    both: b((s) => s.confidence >= 70 && sc(s) != null && sc(s) >= 0.7) };
}
export function signalMemory(list) {
  const recent = list.slice(0, 60); if (recent.length < 3) return "";
  const s = signalStats(recent), f = (x) => `${x.n} signals: target first ${x.target}, SL first ${x.sl}, neither ${x.none}`;
  return `YOUR LAST ${s.all.n} SIGNALS (checked on the live price): ${f(s.all)}. Confidence 70+: ${f(s.hi)}. Below 70: ${f(s.lo)}. CE: ${f(s.ce)}. PE: ${f(s.pe)}. Calibrate your confidence to this.`;
}

// ---- weekly AI review: one Haiku call over the last 7 days of trades ----
export async function weekReview(store, { apiKey, lang, fetchImpl = fetch, now = Date.now() }) {
  if (!apiKey) return { status: 400, error: "AI review ke liye Claude key chahiye (API Keys)." };
  const from = istDate(now - 6 * 864e5), list = (await getJournal(store)).filter((t) => t.day >= from && t.net != null);
  if (!list.length) return { status: 400, error: "Pichhle 7 din mein koi poora trade nahi." };
  const u = await getUsage(store, now);
  if (u.used >= u.limit) return { status: 429, error: `Aaj ki AI limit (${u.limit}) poori ho gayi.` };
  await store.setJSON("ai-usage", { day: u.day, used: u.used + 1, limit: u.limit });
  const rows = list.slice(0, 80).map((t) => ({ at: t.at, name: t.name, source: t.source, mode: t.mode, setup: t.setup, mood: t.mood, entry: t.entry, exit: t.exit,
    exitReason: t.exitReason, net: t.net, r: t.r, mfe: t.mfe, mae: t.mae, minutes: Math.round((t.durationSec || 0) / 60), expiryDay: t.expiryDay, lesson: t.review?.lesson }));
  const prompt = `You are a strict, experienced options trading coach. Review this trader's last 7 days of intraday index option trades
(the trader only buys options). Find patterns: which setups / times / moods make or lose money, discipline mistakes (revenge, FOMO,
holding losers, cutting winners early, overtrading), and what to keep doing. Be specific with numbers. Write in ${lang || "Hinglish (simple)"}.
Return ONLY JSON: {"summary":"2-3 sentences","strengths":["..."],"mistakes":["..."],"rules":["3-5 short rules for next week"]}

STATS: ${JSON.stringify(computeStats(list))}
TRADES (newest first): ${JSON.stringify(rows)}`;
  let r;
  try { r = await claudeMessage({ apiKey, model: "claude-haiku-5-5", prompt, maxTokens: 900, timeoutMs: 8500, fetchImpl }); }
  catch (e) { return { status: 400, error: e.message }; }
  const m = String(r.text).match(/\{[\s\S]*\}/); let j = null; try { j = JSON.parse(m ? m[0] : r.text); } catch {}
  if (!j?.summary) return { status: 400, error: "AI ka review samajh nahi aaya. Dobara try kariye." };
  const review = { at: new Date(now).toISOString(), trades: list.length, summary: str(j.summary, 600), strengths: strs(j.strengths, 6, 220), mistakes: strs(j.mistakes, 6, 220), rules: strs(j.rules, 6, 160) };
  await store.setJSON("week-review", review);
  return { status: 200, review };
}
