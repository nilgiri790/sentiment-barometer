// Scalping page "AI trade assistant": ONE Claude (Haiku) call per "Scan trade" click. The browser sends the live picture
// (contract, Greeks, indicators, option chain with OI changes); we add recent news and ask for a signal.
// The AI never places orders: it returns BUY_CE / BUY_PE / WAIT with entry, target, stop-loss and reasons.
// A daily call limit (set on the page) is kept in Blobs store "admin" key "ai-usage".
import { claudeMessage } from "./claude.mjs";
import { getSettings } from "./settings.mjs";
import { istDate } from "./prices.mjs";
import { UNDERLYINGS } from "./options.mjs";

export const TRADE_MODEL = "claude-haiku-5-5";
export const DEFAULT_LIMIT = 100, MAX_LIMIT = 2000;
const USAGE = "ai-usage";

export async function getUsage(store, now = Date.now()) {
  const u = (await store.get(USAGE, { type: "json" })) || {};
  const limit = Number.isInteger(u.limit) && u.limit >= 1 ? u.limit : DEFAULT_LIMIT;
  return { day: istDate(now), used: u.day === istDate(now) ? u.used || 0 : 0, limit };
}
export async function setLimit(store, limit, now = Date.now()) {
  const n = Math.round(Number(limit));
  if (!(n >= 1 && n <= MAX_LIMIT)) throw new Error(`Limit 1 se ${MAX_LIMIT} ke beech rakhiye.`);
  const u = await getUsage(store, now);
  await store.setJSON(USAGE, { day: u.day, used: u.used, limit: n });
  return { ...u, limit: n };
}

// recent headlines for the option's index: hourly collection (if the index is in the Sentiment list) + its last "Scan news"
export async function newsFor(store, underlying, now = Date.now()) {
  const key = UNDERLYINGS[underlying]; if (!key) return [];
  const [arts, scan] = await Promise.all([store.get(`articles-${key}`, { type: "json" }).catch(() => null), store.get(`scan-${key}`, { type: "json" }).catch(() => null)]);
  const seen = new Set(), out = [];
  for (const h of [...(arts || []), ...(scan?.headlines || [])]) {
    const t = Date.parse(h.published); if (!h.title || !(now - t < 48 * 36e5) || seen.has(h.title)) continue;
    seen.add(h.title); out.push({ t, title: String(h.title).slice(0, 160), source: h.source || "", score: h.score ?? null });
  }
  return out.sort((a, b) => b.t - a.t).slice(0, 12).map(({ t, ...h }) => ({ hoursAgo: Math.round((now - t) / 36e5 * 10) / 10, ...h }));
}

const LANG = { hinglish: "Hinglish (Hindi words in English letters, simple)", english: "simple English", hindi: "simple Hindi (Devanagari)" };
export function buildTradePrompt(p, news, settings = {}) {
  const lang = LANG[settings.reportLang] || LANG.hinglish;
  return `You are an intraday options trading assistant for Indian index options (NSE F&O). Analyse the live data below and give ONE trade signal.
The trader ONLY BUYS options (CE or PE) and places orders himself; never suggest selling/writing options.
You may use any of the given indicators, the option chain (OI, OI change, PCR, max pain, IV), the Greeks, price action, market depth and news.
Rules:
- Say WAIT when the picture is mixed, momentum is weak, the spread is wide, theta/IV make buying unattractive, or it is too close to market close.
- For BUY_CE / BUY_PE pick "symbol" ONLY from the symbols in the data (the open contract or a chain row), with type matching the signal.
- entry must be near that contract's current premium (within 3%), stopLoss below entry, target above entry, ideally reward >= 1.5 x risk.
- Base everything on the numbers given. Do not invent news or data. Keep each reason short and concrete (mention the number).
- Times are India time. Prices are option premiums in rupees.
Write "summary", "reasons", "risks" in ${lang}.
Return ONLY this JSON, nothing else:
{"signal":"BUY_CE|BUY_PE|WAIT","symbol":"<symbol or empty>","confidence":0-100,"entry":number,"target":number,"stopLoss":number,"validMinutes":number,"summary":"1-2 sentences","reasons":["..."],"risks":["..."],"indicatorsUsed":["..."]}

DATA (JSON):
${JSON.stringify(p)}

RECENT NEWS for the index (newest first, score -1..+1 if known):
${news.length ? news.map((n) => `- ${n.hoursAgo}h ago: ${n.title} (${n.source}${n.score != null ? `, score ${n.score}` : ""})`).join("\n") : "(no saved news)"}
${p.question ? `\nTRADER'S QUESTION: ${p.question}` : ""}`;
}

// symbols the AI may pick, with their current premium
export function choices(p) {
  const m = new Map();
  if (p.contract?.symbol) m.set(p.contract.symbol, { ltp: +p.contract.ltp, type: p.contract.type });
  for (const r of p.chain?.rows || []) for (const [s, t] of [[r[1], "CE"], [r[5], "PE"]]) if (s && !m.has(s)) m.set(s, { ltp: +r[t === "CE" ? 2 : 6], type: t });
  return m;
}
const n2 = (v) => Math.round(Number(v) * 20) / 20;
export function parseSignal(text, p) {
  const m = String(text).match(/\{[\s\S]*\}/); let s;
  try { s = JSON.parse(m ? m[0] : text); } catch { throw new Error("AI ka jawab samajh nahi aaya. Dobara Scan kariye."); }
  const list = (a) => (Array.isArray(a) ? a.map((x) => String(x).slice(0, 220)).filter(Boolean).slice(0, 6) : []);
  const out = { signal: ["BUY_CE", "BUY_PE", "WAIT"].includes(s.signal) ? s.signal : "WAIT", symbol: "", confidence: Math.max(0, Math.min(100, Math.round(+s.confidence || 0))),
    entry: null, target: null, stopLoss: null, validMinutes: Math.max(1, Math.min(120, Math.round(+s.validMinutes || 10))),
    summary: String(s.summary || "").slice(0, 400), reasons: list(s.reasons), risks: list(s.risks), indicatorsUsed: list(s.indicatorsUsed), note: null };
  if (out.signal === "WAIT") return out;
  const c = choices(p).get(String(s.symbol || "")), want = out.signal === "BUY_CE" ? "CE" : "PE";
  const entry = n2(s.entry), target = n2(s.target), sl = n2(s.stopLoss);
  let bad = null;
  if (!c) bad = "AI ne aisa contract chuna jo data mein nahi tha";
  else if (c.type !== want) bad = "AI ka contract signal se match nahi karta";
  else if (!(entry > 0 && target > entry && sl > 0 && sl < entry)) bad = "AI ke entry/target/SL theek nahi the";
  else if (c.ltp > 0 && Math.abs(entry - c.ltp) / c.ltp > 0.15) bad = `AI ka entry ${entry} abhi ke daam ${c.ltp} se bahut door tha`;
  if (bad) return { ...out, signal: "WAIT", note: bad + ", isliye WAIT maana." };
  return { ...out, symbol: String(s.symbol), entry, target, stopLoss: sl };
}

export async function aiTrade(body, { adminStore, dataStore, apiKey, fetchImpl = fetch, now = Date.now() }) {
  const p = body.payload;
  if (!p || typeof p !== "object" || !p.contract?.symbol) return { status: 400, error: "Pehle option kholiye." };
  if (JSON.stringify(p).length > 60000) return { status: 400, error: "Data bahut bada hai." };
  if (!apiKey) return { status: 400, error: "AI ke liye Claude key chahiye. API Keys mein Claude (Anthropic) key save kariye." };
  const u = await getUsage(adminStore, now);
  if (u.used >= u.limit) return { status: 429, error: `Aaj ki AI limit (${u.limit} scan) poori ho gayi. Limit badhani ho to neeche "Roz ki limit" badaliye.`, usage: u };
  const usage = { ...u, used: u.used + 1 };
  await adminStore.setJSON(USAGE, { day: usage.day, used: usage.used, limit: usage.limit });   // counted even if the AI fails (the call still costs)
  const [news, settings] = await Promise.all([newsFor(dataStore, p.contract.underlying, now), getSettings(dataStore).catch(() => ({}))]);
  const prompt = buildTradePrompt({ ...p, question: String(body.question || "").slice(0, 400) || undefined }, news, settings);
  const r = await claudeMessage({ apiKey, model: TRADE_MODEL, prompt, maxTokens: 900, timeoutMs: 8500, fetchImpl });
  return { status: 200, result: { ...parseSignal(r.text, p), at: new Date(now).toISOString(), model: r.model, newsCount: news.length }, usage };
}
