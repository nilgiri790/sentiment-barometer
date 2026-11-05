// Score headlines: +1 = trust (bullish for the stock), -1 = lack of trust (bearish).
// Uses Claude when ANTHROPIC_API_KEY is set, else a simple keyword scorer.
import { CLAUDE_MODEL, BATCH_SIZE, MAX_BATCHES_PER_STOCK } from "./config.mjs";
import { claudeMessage } from "./claude.mjs";

const PROMPT = (stock, lines) => `You are a financial news sentiment analyst for Indian stock markets.
For each numbered headline below about the stock "${stock}", judge whether it is positive (trust, likely
to push the share price up), negative (lack of trust, likely to push it down) or neutral FOR THIS STOCK.
Headlines may be in English, Hindi or Hinglish. Read the whole sentence: "no fear of loss" is positive.

Return ONLY a JSON array, one object per headline, like:
[{"i": 1, "score": 0.6, "label": "positive", "reason": "short reason, max 12 words"}]
score is a number from -1.0 (very negative) to 1.0 (very positive); 0 means neutral or not relevant.

Headlines:
${lines}`;

export function parseClaudeJson(text, n) {
  const m = text.match(/\[[\s\S]*\]/);
  let arr = [];
  try { arr = m ? JSON.parse(m[0]) : []; } catch { arr = []; }
  const out = {};
  for (const o of arr) {
    const i = parseInt(o?.i, 10), s = parseFloat(o?.score);
    if (!Number.isFinite(i) || !Number.isFinite(s)) continue;
    out[i] = { score: Math.max(-1, Math.min(1, s)), label: String(o.label ?? "").slice(0, 20), reason: String(o.reason ?? "").slice(0, 200) };
  }
  return Array.from({ length: n }, (_, k) => out[k + 1] ?? null); // null where Claude skipped one
}

async function claudeBatch(stock, rows, key, fetchImpl, model, timeoutMs) {
  const lines = rows.map((r, n) => `${n + 1}. ${r.title} (${r.source || "unknown"})`).join("\n");
  const { text } = await claudeMessage({ apiKey: key, model, prompt: PROMPT(stock, lines), maxTokens: 2000, timeoutMs, fetchImpl });
  return parseClaudeJson(text, rows.length);
}

// ---- fallback ----
const POS = ["surge", "jump", "rally", "gain", "record high", "profit", "beat", "upgrade", "buy", "strong",
  "growth", "wins", "order", "dividend", "bullish", "rise", "soar", "outperform", "expansion",
  "तेजी", "उछाल", "मुनाफा", "बढ़त", "फायदा"];
const NEG = ["fall", "drop", "slump", "plunge", "loss", "miss", "downgrade", "sell", "weak", "probe", "fraud",
  "penalty", "fine", "lawsuit", "decline", "crash", "bearish", "cut", "layoff", "raid", "default",
  "गिरावट", "नुकसान", "घाटा", "गिरा", "जांच"];

export function keywordScore(title) {
  const t = title.toLowerCase();
  const p = POS.filter((w) => t.includes(w)).length, n = NEG.filter((w) => t.includes(w)).length;
  if (p === n) return { score: 0, label: "neutral", reason: "keyword fallback: no clear signal" };
  const s = Math.max(-1, Math.min(1, (p - n) / (p + n)));
  return { score: s * 0.6, label: s > 0 ? "positive" : "negative", reason: "keyword fallback" };
}

// Scores rows in place (adds score/label/reason/engine). With Claude, at most MAX_BATCHES_PER_STOCK
// batches per run; the rest wait for the next run. `deadline` (ms timestamp) stops early and leaves the
// rest unscored for the next run. Returns number scored.
export async function scoreRows(stock, rows, { key = process.env.ANTHROPIC_API_KEY, model = CLAUDE_MODEL, deadline = null,
                                               fetchImpl = fetch, log = console.log } = {}) {
  let done = 0;
  if (!key) {
    for (const r of rows) { Object.assign(r, keywordScore(r.title), { engine: "keyword" }); done++; }
    return done;
  }
  for (let b = 0; b < MAX_BATCHES_PER_STOCK && b * BATCH_SIZE < rows.length; b++) {
    const chunk = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const left = deadline ? deadline - Date.now() : 20000;
    if (left < 1500) break;                               // out of time: next run scores these
    let scored = chunk.map(() => null), engine = model;
    try { scored = await claudeBatch(stock, chunk, key, fetchImpl, model, Math.min(20000, left)); }
    catch (e) {
      if (deadline && Date.now() >= deadline - 200) break;   // timed out because of the deadline: try next run
      log(`Claude failed for ${stock} (${e.message}); using keyword fallback for this batch`);
    }
    chunk.forEach((r, i) => {
      Object.assign(r, scored[i] ?? keywordScore(r.title), { engine: scored[i] ? engine : "keyword" });
      done++;
    });
  }
  return done;
}
