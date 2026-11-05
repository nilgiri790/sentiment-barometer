// Offline tests: Sentiment page settings, Scan news, AI report. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSettings, DEFAULT_SETTINGS } from "../lib/settings.mjs";
import { scanNews, makeReport, reportPrompt, simpleReport } from "../lib/scan.mjs";
import { handleAdmin } from "../lib/admin.mjs";
import { runAll, dashboardData } from "../lib/pipeline.mjs";

const mem = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const d = () => new Date().toUTCString();
const RSS = (url) => `<rss>${[["ITC shares surge on strong profit", "Mint"], ["ITC faces tax probe, stock falls", "Reuters"], ["ITC AGM date announced", "ET"]]
  .map(([t, s], i) => `<item><title>${t} - ${s}</title><link>${url}#${i}</link><pubDate>${d()}</pubDate><source>${s}</source></item>`).join("")}</rss>`;

function net({ report = '{"overall":"mixed","summary":"ITC par khabrein mili-juli hain.","positives":["Munafa achha raha"],"negatives":["Tax jaanch"],"themes":["Results"],"watch":["Jaanch ka nateeja"]}', calls = [] } = {}) {
  return async (url, o = {}) => {
    calls.push({ url, body: o.body });
    if (url.includes("news.google.com")) return { ok: true, text: async () => RSS(url) };
    if (url.includes("api.anthropic.com")) {
      const prompt = JSON.parse(o.body).messages[0].content;
      if (/Return ONLY a JSON array/.test(prompt)) {                // headline scoring
        const n = (prompt.match(/^\d+\. /gm) || []).length;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: i + 1, score: [0.7, -0.6, 0][i % 3], label: "x", reason: "AI reason" }))) }] }) };
      }
      return { ok: true, json: async () => ({ content: [{ type: "text", text: "Here you go:\n" + report }] }) };
    }
    throw new Error("unexpected " + url);
  };
}

test("settings: defaults and cleaning", () => {
  assert.deepEqual(cleanSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(cleanSettings({ newsLang: "hi", newsWindow: "7d", maxArticles: "25", autoCollect: false, lookback: "7", reportLang: "english", reportLength: "detailed" }),
    { newsLang: "hi", newsWindow: "7d", maxArticles: 25, autoCollect: false, lookback: 7, reportLang: "english", reportLength: "detailed" });
  assert.equal(cleanSettings({ maxArticles: 5000, newsLang: "fr" }).maxArticles, 40);
});

test("settings change the Google News query of the hourly run", async () => {
  const store = mem(), urls = [];
  await store.setJSON("settings", { newsLang: "hi", newsWindow: "7d", maxArticles: 10 });
  await store.setJSON("watchlist", { ITC: { query: "ITC share", ticker: "ITC.NS" } });
  await runAll(store, { key: "", fetchImpl: async (u) => { urls.push(u); return { ok: true, text: async () => RSS(u) }; }, log: () => {} });
  assert.equal(urls.length, 1); assert.match(urls[0], /hl=hi&gl=IN&ceid=IN:hi/); assert.match(decodeURIComponent(urls[0]), /when:7d/);
  assert.equal((await dashboardData(store)).settings.newsLang, "hi");
});

test("scan news: fetch + Claude scoring + barometer, saved", async () => {
  const store = mem();
  const scan = await scanNews({ symbol: "ITC.NS", name: "ITC LTD" }, store, { apiKey: "k", model: "claude-test", fetchImpl: net() });
  assert.equal(scan.key, "ITC"); assert.equal(scan.headlines.length, 3); assert.equal(scan.engine, "claude-test");
  assert.equal(scan.barometer.positive, 1); assert.equal(scan.barometer.negative, 1);
  assert.ok(store.m.has("scan-ITC"));
  const noKey = await scanNews({ symbol: "ITC.NS", name: "ITC LTD" }, mem(), { apiKey: "", model: "x", fetchImpl: net() });
  assert.equal(noKey.engine, "keyword"); assert.ok(noKey.headlines.every((h) => h.engine === "keyword"));
  await assert.rejects(scanNews({ symbol: "BANKNIFTY26NOV52000CE.NFO" }, mem(), { fetchImpl: net() }), /Sirf NSE\/BSE/);
});

test("report: AI JSON parsed; language and length follow settings; fallbacks", async () => {
  const store = mem(), calls = [];
  await store.setJSON("settings", { reportLang: "english", reportLength: "detailed" });
  await scanNews({ symbol: "ITC.NS", name: "ITC LTD" }, store, { apiKey: "k", model: "m", fetchImpl: net() });
  const r = await makeReport("ITC", store, { apiKey: "k", model: "m", fetchImpl: net({ calls }) });
  assert.equal(r.reportEngine, "m"); assert.equal(r.report.overall, "mixed"); assert.deepEqual(r.report.negatives, ["Tax jaanch"]);
  const prompt = JSON.parse(calls.at(-1).body).messages[0].content;
  assert.match(prompt, /simple English/); assert.match(prompt, /6-8 sentences/); assert.match(prompt, /ITC shares surge/);
  assert.equal(JSON.parse(calls.at(-1).body).max_tokens, 1400);
  assert.ok(store.m.has("report-ITC"));
  const bad = await makeReport("ITC", store, { apiKey: "k", model: "m", fetchImpl: net({ report: "sorry, no json" }) });
  assert.equal(bad.reportEngine, "simple"); assert.match(bad.note, /padha nahi/); assert.match(bad.report.summary, /3 khabron/);
  const nokey = await makeReport("ITC", store, { apiKey: "", model: "m", fetchImpl: net() });
  assert.match(nokey.note, /Claude key nahi/);
  await assert.rejects(makeReport("TCS", store, {}), /Pehle news scan/);
});

test("simple report picks the strongest headlines", () => {
  const r = simpleReport({ name: "X", window: "3d", barometer: { score: 20, label: "Trust", count: 3, positive: 2, negative: 1, neutral: 0 },
    headlines: [{ title: "a", score: 0.3 }, { title: "b", score: 0.9 }, { title: "c", score: -0.5 }] });
  assert.deepEqual(r.positives, ["b", "a"]); assert.deepEqual(r.negatives, ["c"]); assert.equal(r.overall, "positive");
});

test("admin: settings / scan / report need login and work end to end", async () => {
  const adminStore = mem(), dataStore = mem(), env = { ADMIN_PASSWORD: "pw-abcdefg", KEYS_SECRET: "e".repeat(64) }, H = "https://s.example"; let jar = "";
  const call = async (path, body) => { const res = await handleAdmin(new Request(H + "/api/admin/" + path, { method: body ? "POST" : "GET", headers: { origin: H, cookie: jar, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), { adminStore, dataStore, env, fetchImpl: net() });
    const sc = res.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0]; return { status: res.status, body: await res.json() }; };
  assert.equal((await call("settings", { settings: { newsLang: "hi" } })).status, 401);
  assert.equal((await call("scan", { step: "news", symbol: "ITC.NS" })).status, 401);
  await call("login", { password: "pw-abcdefg" });
  assert.equal((await call("settings", { settings: { newsLang: "hi", maxArticles: 999 } })).body.settings.newsLang, "hi");
  await call("keys", { provider: "anthropic", values: { api_key: "sk-ant-x1234567", model: "claude-test" } });
  const s = await call("scan", { step: "news", symbol: "ITC.NS", name: "ITC LTD" });
  assert.equal(s.status, 200); assert.equal(s.body.scan.engine, "claude-test");
  const r = await call("scan", { step: "report", key: "ITC" });
  assert.equal(r.status, 200); assert.equal(r.body.report.report.summary, "ITC par khabrein mili-juli hain.");
  assert.equal((await call("report?key=ITC")).body.report.key, "ITC");
  assert.equal((await call("report?key=TCS")).body.report, null);
  assert.equal((await call("scan", { step: "news", symbol: "BAD" })).status, 400);
});
