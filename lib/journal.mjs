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
    signal: t.signal ? { confidence: num(t.signal.confidence, 0, 100), summary: str(t.signal.summary, 300), reasons: strs(t.signal.reasons) } : null,
    ctx: t.ctx ? { spot: num(t.ctx.spot), pcr: num(t.ctx.pcr, 0, 100), atmIv: num(t.ctx.atmIv, 0, 500), maxPain: num(t.ctx.maxPain), support: num(t.ctx.support), resistance: num(t.ctx.resistance) } : null,
  };
  if (exit != null) {
    const ch = optionCharges({ buy: entry * qty, sell: exit * qty });
    row.gross = r2((exit - entry) * qty); row.charges = ch.total; row.net = r2(row.gross - ch.total);
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
export const AUTO_DEFAULTS = { lots: 1, maxTrades: 5, maxLoss: 1000, minConf: 65 };
export async function getAuto(store) {
  const s = (await store.get("ai-auto", { type: "json" })) || {};
  return cleanAuto({ ...AUTO_DEFAULTS, ...s });
}
export function cleanAuto(s = {}) {
  const i = (v, lo, hi, d) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : d; };
  return { lots: i(s.lots, 1, 50, AUTO_DEFAULTS.lots), maxTrades: i(s.maxTrades, 1, 50, AUTO_DEFAULTS.maxTrades),
    maxLoss: i(s.maxLoss, 100, 1000000, AUTO_DEFAULTS.maxLoss), minConf: i(s.minConf, 30, 95, AUTO_DEFAULTS.minConf) };
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
