// Backtest page AI: (1) answer a question about a stock's past candles, (2) turn plain words into a strategy (data, not code).
import { validateStrategy, INDICATORS, OPS, describeRule } from "../public/btengine.mjs";
import { getSettings } from "./settings.mjs";

const LANG = { hinglish: "Hinglish (Hindi in English letters, simple words)", english: "simple English", hindi: "Hindi (Devanagari), simple words" };
const clip = (s, n) => String(s ?? "").slice(0, n);

async function claude(text, { apiKey, model, fetchImpl, maxTokens, timeoutMs = 8500 }) {
  if (!apiKey) throw new Error("Iske liye Claude key chahiye. API Keys mein Claude (Anthropic) key save kariye.");
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: text }] }),
  }).catch((e) => { throw new Error(e.name === "TimeoutError" ? "AI ne samay par jawab nahi diya, sawaal chhota karke dobara try kariye." : e.message); });
  if (!r.ok) throw new Error(`Claude API answered ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}

// candles from the page: [[epochSec, o, h, l, c, v], ...] (newest last). Keep the last 400.
function candleText(candles, interval) {
  const day = interval === "day", rows = (Array.isArray(candles) ? candles : []).slice(-400);
  return rows.filter((x) => Array.isArray(x) && x.length >= 5 && x.every((v) => Number.isFinite(+v)))
    .map(([t, o, h, l, c, v]) => { const d = new Date((+t + 19800) * 1000).toISOString(); return `${day ? d.slice(0, 10) : d.slice(0, 16).replace("T", " ")},${+o},${+h},${+l},${+c},${Math.round(+v || 0)}`; }).join("\n");
}

export function analyzePrompt(b, settings) {
  const detailed = settings.reportLength === "detailed";
  const bt = b.backtest && typeof b.backtest === "object"
    ? `\nThe user also backtested a strategy on this data:\n${clip(JSON.stringify(b.backtest), 3000)}\n` : "";
  return `You are a careful market-data analyst for Indian markets.
Data: ${clip(b.name, 80)} (${clip(b.symbol, 40)}), timeframe ${clip(b.interval, 20)}, times in India time (IST).
Summary: ${clip(JSON.stringify(b.stats || {}), 2500)}
Candles, oldest to newest, as date,open,high,low,close,volume:
${candleText(b.candles, b.interval)}
${bt}
User's question: """${clip(b.prompt, 1500)}"""

Answer in ${LANG[settings.reportLang] || LANG.hinglish}.
Use ONLY this data. Work from the actual numbers and quote concrete numbers and dates. If the data cannot answer something, say so.
Do not give buy/sell advice; remind briefly that past data does not guarantee the future.
Format: short "## " headings and "- " bullet points, under ${detailed ? 450 : 250} words.`;
}

export function strategyPrompt(b) {
  return `Convert the user's trading idea into a strategy JSON for a backtest engine. Long-only. Signals are checked on candle close.
Allowed operand: {"value": number} or {"ind": one of ${JSON.stringify(INDICATORS)}, "n": period (2..400, needed for sma/ema/rsi/bb_*/highest/lowest/sma_volume), "k": std-dev multiplier for bb_* (default 2)}.
"highest"/"lowest" = highest high / lowest low of the PREVIOUS n candles. Operators: ${JSON.stringify(OPS)}.
Return ONLY JSON like:
{"name": "short name", "entry": {"all": [rules, all must be true]}, "exit": {"any": [rules, any one exits]},
 "stopLossPct": number or null, "takeProfitPct": number or null, "maxHoldBars": number or null}
where rule = {"left": operand, "op": operator, "right": operand}. Use 1-6 rules each. If the idea has no exit, add a sensible stopLossPct.
Example: "buy when RSI(14) goes below 30, sell when it goes above 60 or 3% loss" ->
{"name":"RSI dip","entry":{"all":[{"left":{"ind":"rsi","n":14},"op":"<","right":{"value":30}}]},"exit":{"any":[{"left":{"ind":"rsi","n":14},"op":">","right":{"value":60}}]},"stopLossPct":3,"takeProfitPct":null,"maxHoldBars":null}
Timeframe of the data: ${clip(b.interval, 20)}.
User's idea: """${clip(b.prompt, 1200)}"""`;
}

export async function aiAnalyze(body, store, o) {
  if (!String(body.prompt || "").trim()) throw new Error("Pehle apna sawaal likhiye.");
  const settings = await getSettings(store);
  const answer = await claude(analyzePrompt(body, settings), { ...o, maxTokens: settings.reportLength === "detailed" ? 1400 : 900 });
  return { answer: clip(answer, 8000), engine: o.model };
}

export async function aiStrategy(body, o) {
  if (!String(body.prompt || "").trim()) throw new Error("Pehle strategy apne shabdon mein likhiye.");
  const text = await claude(strategyPrompt(body), { ...o, maxTokens: 700 });
  const m = text.match(/\{[\s\S]*\}/);
  let raw = null; try { raw = m ? JSON.parse(m[0]) : null; } catch { raw = null; }
  const { strategy, error } = validateStrategy(raw);
  if (error) throw new Error(`AI ki strategy samajh nahi aayi (${error}). Thoda alag shabdon mein likh kar try kariye.`);
  return { strategy, rules: { entry: strategy.entry.all.map(describeRule), exit: strategy.exit.any.map(describeRule) }, engine: o.model };
}
