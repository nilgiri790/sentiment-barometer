// Offline tests: no internet needed. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRss } from "../lib/news.mjs";
import { parseClaudeJson, keywordScore, scoreRows } from "../lib/sentiment.mjs";
import { runAll, dashboardData, WEIGHTS } from "../lib/pipeline.mjs";
import { barometer, labelFor } from "../public/barometer.mjs";

export const memStore = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)), m };
};
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title>${i.t} - ${i.s}</title>
  <link>${i.u}</link><pubDate>${i.d}</pubDate><source url="x">${i.s}</source></item>`).join("")}</channel></rss>`;

test("parseRss strips source, decodes entities, converts date to UTC", () => {
  const out = parseRss(rss([{ t: "TCS &amp; Infosys shares surge", s: "Mint", u: "https://a/1", d: "Tue, 03 Nov 2026 10:00:00 +0530" }]));
  assert.deepEqual(out, [{ title: "TCS & Infosys shares surge", source: "Mint", url: "https://a/1", published: "2026-11-03T04:30:00" }]);
  assert.equal(parseRss("<rss><item><title><![CDATA[Hello]]></title><link>u</link></item></rss>")[0].title, "Hello");
});

test("keyword fallback matches Python version", () => {
  assert.deepEqual(keywordScore("Stock jumps on profit"), { score: 0.6, label: "positive", reason: "keyword fallback" });
  assert.equal(keywordScore("Shares fall after probe").score, -0.6);
  assert.equal(keywordScore("AGM date announced").score, 0);
});

test("parseClaudeJson handles extra text, clamps, skips bad items", () => {
  const r = parseClaudeJson('Sure:\n[{"i":1,"score":1.7,"label":"positive","reason":"x"},{"i":"bad"},{"i":3,"score":-0.2}]', 3);
  assert.equal(r[0].score, 1); assert.equal(r[1], null); assert.equal(r[2].score, -0.2);
});

test("barometer: recency and source weight", () => {
  const now = new Date("2026-11-04T00:00:00Z");
  const b = barometer([{ published: "2026-11-04T00:00:00", score: 1, source: "Mint" },
                       { published: "2026-11-03T00:00:00", score: -1, source: "Mint" }], WEIGHTS, now);
  assert.equal(b.score, 33.3); // weights 1 and 0.5 -> (1-0.5)/1.5
  assert.equal(labelFor(b.score), "Trust");
});

test("full run: fetch, dedupe across runs, score, dashboard data", async () => {
  const store = memStore();
  const d = new Date().toUTCString();
  const fetchImpl = async (url) => ({ ok: true, text: async () => rss([
    { t: "Company shares surge on profit", s: "Economic Times", u: url + "#1", d },
    { t: "Company faces probe", s: "Unknown Blog", u: url + "#2", d },
    { t: "Company faces probe", s: "Unknown Blog", u: url + "#2", d }]) });
  const logs = [];
  let r = await runAll(store, { fetchImpl, key: "", log: (x) => logs.push(x) });
  assert.ok(r.every((x) => x.new === 2 && x.scored === 2), JSON.stringify(r));
  r = await runAll(store, { fetchImpl, key: "", log: () => {} });
  assert.ok(r.every((x) => x.new === 0 && x.scored === 0 && x.total === 2));
  const data = await dashboardData(store);
  assert.equal(Object.keys(data.stocks).length, 5);
  assert.equal(data.stocks.TCS.headlines.length, 2);
  assert.equal(data.engine, "keyword");
  const b = barometer(data.stocks.TCS.headlines, data.weights);
  assert.equal(b.positive, 1); assert.equal(b.negative, 1);
  assert.ok(b.score > 0, "trusted positive source should outweigh unknown negative one");
});

test("one stock failing does not stop the others", async () => {
  const store = memStore();
  const fetchImpl = async (url) => { if (url.includes("Infosys")) throw new Error("boom"); return { ok: true, text: async () => rss([]) }; };
  const r = await runAll(store, { fetchImpl, key: "", log: () => {} });
  assert.equal(r.find((x) => x.stock === "INFY").error, "boom");
  assert.equal(r.filter((x) => !x.error).length, 4);
});

test("Claude path: uses API result, falls back per batch on error, caps batches", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ title: `Headline ${i} profit`, source: "" }));
  let calls = 0;
  const fetchImpl = async (url, opt) => {
    calls++;
    assert.equal(opt.headers["x-api-key"], "test-key");
    if (calls === 2) return { ok: false, status: 529 };
    const n = (JSON.parse(opt.body).messages[0].content.match(/^\d+\. /gm) || []).length;
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: i + 1, score: -0.5, label: "negative", reason: "r" }))) }] }) };
  };
  const done = await scoreRows("TCS", rows, { key: "test-key", fetchImpl, log: () => {} });
  assert.equal(calls, 2); assert.equal(done, 40);
  assert.equal(rows[0].score, -0.5); assert.equal(rows[0].engine, "claude-haiku-5-5");
  assert.equal(rows[25].engine, "keyword"); assert.equal(rows[45].score, undefined); // waits for next run
});

test("deadline: Claude scoring stops in time and leaves rows for the next run", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ title: `H${i}`, source: "" }));
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("should not be called"); };
  const done = await scoreRows("TCS", rows, { key: "k", fetchImpl, deadline: Date.now() + 500, log: () => {} });
  assert.equal(done, 0); assert.equal(calls, 0); assert.equal(rows[0].score, undefined);
});
