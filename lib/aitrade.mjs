// Scalping page "AI trade assistant" (BANK NIFTY / NIFTY): ONE Claude (Haiku) call per scan. The browser sends the live picture
// (index price action + indicators, the whole loaded option chain with OI changes / volume / IV / delta, the open contract);
// we add recent news and ask the AI to pick ONE strike (CE or PE) to buy, or WAIT.
// The AI never places orders: it returns BUY_CE / BUY_PE / WAIT with symbol, entry, target, stop-loss and reasons.
// A daily call limit (set on the page) is kept in Blobs store "admin" key "ai-usage".
import { claudeMessage } from "./claude.mjs";
import { getSettings } from "./settings.mjs";
import { istDate } from "./prices.mjs";
import { UNDERLYINGS } from "./options.mjs";
import { getJournal, promptMemory, getSignals, signalMemory } from "./journal.mjs";

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
export function buildTradePrompt(p, news, settings = {}, memory = "") {
  const lang = LANG[settings.reportLang] || LANG.hinglish;
  return `You are an intraday options trading assistant for Indian index options (NSE F&O: ${p.index?.name || "index"}). Analyse the live data below,
then choose the ONE best option strike to BUY right now from the WHOLE option chain (a call CE or a put PE of any listed strike), or say WAIT.
The trader ONLY BUYS options and places orders himself; never suggest selling/writing options.
How to decide (use your judgement, any indicator is allowed):
- Direction from the index price action: trend on 1m and 5m candles, VWAP, EMA 9/21, RSI, ATR, recent highs/lows, momentum, time of day.
- Option chain: PCR and its change, max pain, support (highest PE OI) / resistance (highest CE OI), where OI is being added or cut
  (OI change since the last scan: long buildup / short buildup / short covering / long unwinding), volume, IV.
- Strike choice: liquid strikes near the money (good OI and volume, tight spread), delta roughly 0.35-0.65 for scalping, a premium that can move,
  avoid very deep OTM lottery strikes and very high IV; consider theta and the days to expiry.
- Say WAIT when the picture is mixed, momentum is weak, it is too close to market close, or no strike offers a good reward for the risk.
- Also use "market" when given: India VIX, the index future (VWAP, premium, OI), heavyweight shares, day type, previous-day levels,
  opening range and the expected move. Trade with the day type; be careful near big levels and when VIX is high.
- ALWAYS give a "plan" on the INDEX price (even with WAIT): "above" = a level where calls become good if the index holds above it,
  "below" = a level where puts become good if it breaks below, and the no-trade zone between. Use real levels from the data.
Rules for the answer:
- "symbol" MUST be copied exactly from the chain rows (or the open contract) and its type must match the signal (BUY_CE -> a CE symbol).
- entry must be near that contract's current premium (within 3%), stopLoss below entry, target above entry, ideally reward >= 1.5 x risk.
- Base everything on the numbers given. Do not invent news or data. Keep each reason short and concrete (mention the number).
- Times are India time. Prices are option premiums in rupees.
Write "summary", "reasons", "risks" in ${lang}.
Return ONLY this JSON, nothing else:
{"signal":"BUY_CE|BUY_PE|WAIT","symbol":"<symbol or empty>","confidence":0-100,"entry":number,"target":number,"stopLoss":number,"validMinutes":number,"summary":"1-2 sentences","reasons":["..."],"risks":["..."],"indicatorsUsed":["..."],"plan":{"above":number,"below":number,"note":"1 short sentence"}}

DATA (JSON):
${JSON.stringify(p)}

RECENT NEWS for the index (newest first, score -1..+1 if known):
${news.length ? news.map((n) => `- ${n.hoursAgo}h ago: ${n.title} (${n.source}${n.score != null ? `, score ${n.score}` : ""})`).join("\n") : "(no saved news)"}
${memory ? `\n${memory}` : ""}
${p.question ? `\nTRADER'S QUESTION: ${p.question}` : ""}`;
}

// symbols the AI may pick, with their current premium
export function choices(p) {
  const m = new Map();
  const oc = p.openContract || p.contract;
  if (oc?.symbol) m.set(oc.symbol, { ltp: +oc.ltp, type: oc.type || (/CE(\.NFO)?$/.test(oc.symbol) ? "CE" : "PE") });
  for (const r of p.chain?.rows || []) for (const [s, t] of [[r[1], "CE"], [r[5], "PE"]]) if (s && !m.has(s)) m.set(s, { ltp: +r[t === "CE" ? 2 : 6], type: t });
  return m;
}
const n2 = (v) => Math.round(Number(v) * 20) / 20;
// the AI's index levels: above > below, both within 5% of the spot, else dropped
export function cleanPlan(pl, p) {
  const spot = +p.index?.spot, a = Math.round(+pl?.above || 0), b = Math.round(+pl?.below || 0);
  if (!(spot > 0 && a > b && b > 0 && Math.abs(a - spot) / spot < 0.05 && Math.abs(b - spot) / spot < 0.05)) return null;
  return { above: a, below: b, note: String(pl.note || "").slice(0, 200) };
}
export function parseSignal(text, p) {
  const m = String(text).match(/\{[\s\S]*\}/); let s;
  try { s = JSON.parse(m ? m[0] : text); } catch { throw new Error("AI ka jawab samajh nahi aaya. Dobara Scan kariye."); }
  const list = (a) => (Array.isArray(a) ? a.map((x) => String(x).slice(0, 220)).filter(Boolean).slice(0, 6) : []);
  const out = { signal: ["BUY_CE", "BUY_PE", "WAIT"].includes(s.signal) ? s.signal : "WAIT", symbol: "", confidence: Math.max(0, Math.min(100, Math.round(+s.confidence || 0))),
    entry: null, target: null, stopLoss: null, validMinutes: Math.max(1, Math.min(120, Math.round(+s.validMinutes || 10))),
    summary: String(s.summary || "").slice(0, 400), reasons: list(s.reasons), risks: list(s.risks), indicatorsUsed: list(s.indicatorsUsed), note: null, plan: cleanPlan(s.plan, p) };
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
  if (!p || typeof p !== "object" || !Array.isArray(p.chain?.rows) || !p.chain.rows.length) return { status: 400, error: "Option chain abhi nahi aayi. Thoda ruk kar Scan kariye." };
  const und = p.index?.underlying || p.contract?.underlying;
  if (!["BANKNIFTY", "NIFTY"].includes(und)) return { status: 400, error: "AI scan sirf BANK NIFTY aur NIFTY ke liye hai." };
  if (JSON.stringify(p).length > 60000) return { status: 400, error: "Data bahut bada hai." };
  if (!apiKey) return { status: 400, error: "AI ke liye Claude key chahiye. API Keys mein Claude (Anthropic) key save kariye." };
  const u = await getUsage(adminStore, now);
  if (u.used >= u.limit) return { status: 429, error: `Aaj ki AI limit (${u.limit} scan) poori ho gayi. Limit badhani ho to neeche "Roz ki limit" badaliye.`, usage: u };
  const usage = { ...u, used: u.used + 1 };
  await adminStore.setJSON(USAGE, { day: usage.day, used: usage.used, limit: usage.limit });   // counted even if the AI fails (the call still costs)
  const [news, settings, journal, signals] = await Promise.all([newsFor(dataStore, und, now), getSettings(dataStore).catch(() => ({})), getJournal(adminStore).catch(() => []), getSignals(adminStore).catch(() => [])]);
  const memory = [promptMemory(journal), signalMemory(signals)].filter(Boolean).join("\n");
  const prompt = buildTradePrompt({ ...p, question: String(body.question || "").slice(0, 400) || undefined }, news, settings, memory);
  const r = await claudeMessage({ apiKey, model: TRADE_MODEL, prompt, maxTokens: 900, timeoutMs: 8500, fetchImpl });
  return { status: 200, result: { ...parseSignal(r.text, p), at: new Date(now).toISOString(), model: r.model, newsCount: news.length, learnedFrom: journal.filter((t) => t.net != null).slice(0, 30).length }, usage };
}
