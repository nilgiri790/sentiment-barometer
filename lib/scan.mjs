// "Scan news" on the Sentiment page, in two short steps (Netlify gives a request about 10 seconds):
//   1. scanNews: fresh Google News headlines for one share/index, scored (Claude, else keyword) -> Blobs "scan-<KEY>"
//   2. makeReport: one Claude call turns those scored headlines into a short report -> Blobs "report-<KEY>"
import { fetchStockNews } from "./news.mjs";
import { scoreRows, keywordScore } from "./sentiment.mjs";
import { barometer, labelFor } from "../public/barometer.mjs";
import { WEIGHTS } from "./pipeline.mjs";
import { entryFrom } from "./watchlist.mjs";
import { getSettings, newsOpts } from "./settings.mjs";

const SCAN_MAX = 30;

export async function scanNews(target, store, { apiKey = "", model, fetchImpl = fetch, now = Date.now() } = {}) {
  const { key, entry, error } = entryFrom(target);
  if (error) throw new Error(error);
  const settings = await getSettings(store);
  const items = await fetchStockNews(entry.query, fetchImpl, 4000, { ...newsOpts(settings), max: SCAN_MAX });
  const rows = items.map((i) => ({ ...i })).sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  await scoreRows(key, rows, { key: apiKey, model, deadline: now + 6500, fetchImpl, log: () => {} });
  for (const r of rows) if (r.score == null) Object.assign(r, keywordScore(r.title), { engine: "keyword" });
  const b = barometer(rows, WEIGHTS, new Date(now));
  const scan = {
    key, name: entry.name || key, symbol: entry.ticker, index: !!entry.index, at: new Date(now).toISOString(), window: settings.newsWindow,
    engine: rows.some((r) => r.engine && r.engine !== "keyword") ? model : "keyword",
    barometer: { ...b, label: labelFor(b.score) },
    headlines: rows.map(({ title, source, url, published, score, reason, engine }) => ({ title, source, url, published, score, reason, engine })),
  };
  await store.setJSON(`scan-${key}`, scan);
  return scan;
}

const LANG = { hinglish: "Hinglish (Hindi written in English letters, simple everyday words)", english: "simple English", hindi: "Hindi (Devanagari script), simple words" };

export function reportPrompt(scan, settings) {
  const short = settings.reportLength !== "detailed";
  const lines = scan.headlines.slice(0, 25).map((h, i) =>
    `${i + 1}. [${h.score > 0 ? "+" : ""}${Number(h.score).toFixed(2)}] ${h.title} (${h.source || "unknown"}, ${h.published ? h.published.slice(0, 10) : "?"})`).join("\n");
  return `You are a careful equity news analyst for Indian stock markets.
Below are recent news headlines about "${scan.name}" (${scan.symbol}) from the last ${scan.window}, each with a sentiment score
from -1 (lack of trust) to +1 (trust). The weighted news barometer is ${scan.barometer.score} (${scan.barometer.label}) on a -100..+100 scale.

Write a report for a retail investor in ${LANG[settings.reportLang] || LANG.hinglish}.
Use ONLY what the headlines say. Do not invent numbers, prices or events. Do not give buy/sell advice.
Return ONLY a JSON object, no other text:
{"overall": "positive" | "negative" | "mixed" | "neutral",
 "summary": "${short ? "3-4 sentences" : "6-8 sentences"}",
 "positives": [${short ? "up to 3" : "up to 6"} short points],
 "negatives": [${short ? "up to 3" : "up to 6"} short points],
 "themes": [up to 5 two-to-four word topics],
 "watch": [up to ${short ? 3 : 5} things to keep an eye on]}
Each point under 20 words.

Headlines:
${lines}`;
}

function parseReport(text) {
  const m = String(text).match(/\{[\s\S]*\}/); if (!m) return null;
  let o; try { o = JSON.parse(m[0]); } catch { return null; }
  const arr = (a, n) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 240)).slice(0, n) : []);
  if (typeof o.summary !== "string" || !o.summary.trim()) return null;
  return { overall: ["positive", "negative", "mixed", "neutral"].includes(o.overall) ? o.overall : "mixed", summary: o.summary.trim().slice(0, 2000),
           positives: arr(o.positives, 6), negatives: arr(o.negatives, 6), themes: arr(o.themes, 5), watch: arr(o.watch, 5) };
}

// Report without AI (no Claude key, or the AI answer could not be read): counts + strongest headlines.
export function simpleReport(scan) {
  const b = scan.barometer, hs = scan.headlines;
  const top = (sign) => hs.filter((h) => (sign > 0 ? h.score > 0.15 : h.score < -0.15)).sort((a, z) => sign * (z.score - a.score)).slice(0, 3).map((h) => h.title);
  return {
    overall: b.score >= 15 ? "positive" : b.score <= -15 ? "negative" : b.positive && b.negative ? "mixed" : "neutral",
    summary: `${scan.name} ki pichhle ${scan.window} ki ${b.count} khabron mein ${b.positive} positive, ${b.negative} negative aur ${b.neutral} neutral mili. News barometer ${b.score > 0 ? "+" : ""}${b.score} (${b.label}) hai.`,
    positives: top(1), negatives: top(-1), themes: [], watch: [],
  };
}

export async function makeReport(key, store, { apiKey = "", model, fetchImpl = fetch, now = Date.now() } = {}) {
  const scan = await store.get(`scan-${key}`, { type: "json" });
  if (!scan) throw new Error("Pehle news scan kariye.");
  if (!scan.headlines.length) throw new Error("Is stock ki koi taaza khabar nahi mili, isliye report nahi bani.");
  const settings = await getSettings(store);
  let report = null, reportEngine = "simple", note = null;
  if (apiKey) {
    try {
      const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(8500),
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: settings.reportLength === "detailed" ? 1400 : 700, messages: [{ role: "user", content: reportPrompt(scan, settings) }] }),
      });
      if (!r.ok) throw new Error(`Claude API answered ${r.status}`);
      const d = await r.json();
      report = parseReport((d.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""));
      if (report) reportEngine = model; else note = "AI ka jawab padha nahi ja saka, isliye simple report.";
    } catch (e) { note = `AI report nahi bani (${e.name === "TimeoutError" ? "time out" : e.message}), isliye simple report.`; }
  } else note = "Claude key nahi hai, isliye simple report. API Keys mein Claude key jodne par AI report banegi.";
  report ||= simpleReport(scan);
  const full = { ...scan, headlines: scan.headlines.slice(0, 15), report, reportEngine, note, reportAt: new Date(now).toISOString(), settings: { reportLang: settings.reportLang, reportLength: settings.reportLength } };
  await store.setJSON(`report-${key}`, full);
  return full;
}
