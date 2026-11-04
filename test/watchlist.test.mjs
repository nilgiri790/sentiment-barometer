// Offline tests for the dashboard stock list (add / remove from the website). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdmin } from "../lib/admin.mjs";
import { getWatchlist, entryFrom, MAX_STOCKS } from "../lib/watchlist.mjs";
import { runAll, dashboardData } from "../lib/pipeline.mjs";

const mem = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const ENV = { ADMIN_PASSWORD: "correct horse", KEYS_SECRET: "c".repeat(64) }, H = "https://s.example";
const news = async (url) => ({ ok: true, text: async () => `<rss><item><title>Shares rise on profit - Mint</title><link>${url}#1</link><pubDate>${new Date().toUTCString()}</pubDate><source>Mint</source></item></rss>` });

function client(fetchImpl = news) {
  const adminStore = mem(), dataStore = mem(); let jar = "";
  const call = async (path, body) => {
    const res = await handleAdmin(new Request(H + "/api/admin/" + path, { method: body ? "POST" : "GET", headers: { origin: H, cookie: jar, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }),
      { adminStore, dataStore, env: { ...ENV }, fetchImpl });
    const sc = res.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  return { call, dataStore };
}

test("starts with the stocks from config", async () => {
  assert.deepEqual(Object.keys(await getWatchlist(mem())), ["RELIANCE", "TCS", "HDFCBANK", "INFY", "TATAMOTORS"]);
});

test("entry from a search result: share, index, refuses options", () => {
  assert.deepEqual(entryFrom({ symbol: "ITC.NS", name: "ITC LTD" }), { key: "ITC", entry: { query: "ITC share", ticker: "ITC.NS", name: "ITC LTD" } });
  assert.deepEqual(entryFrom({ symbol: "NIFTY BANK.NS", name: "NIFTY BANK", index: true }).entry, { query: "Bank Nifty", ticker: "NIFTY BANK.NS", name: "NIFTY BANK", index: true });
  assert.match(entryFrom({ symbol: "BANKNIFTY26NOV52000CE.NFO" }).error, /Sirf NSE\/BSE/);
});

test("add / remove need admin login; add fetches news at once; dashboard follows the list", async () => {
  const c = client();
  assert.equal((await c.call("watch", { op: "add", symbol: "ITC.NS", name: "ITC LTD" })).status, 401);
  await c.call("login", { password: "correct horse" });
  let r = await c.call("watch", { op: "add", symbol: "ITC.NS", name: "ITC LTD" });
  assert.equal(r.status, 200); assert.ok(r.body.data.stocks.ITC, "ITC on dashboard");
  assert.equal(r.body.data.stocks.ITC.headlines.length, 1, "news fetched right away");
  assert.equal((await c.call("watch", { op: "add", symbol: "ITC.NS" })).status, 400, "no duplicates");
  r = await c.call("watch", { op: "remove", key: "TATAMOTORS" });
  assert.ok(!r.body.data.stocks.TATAMOTORS);
  assert.deepEqual(Object.keys(r.body.data.stocks), ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ITC"]);
  // hourly run collects only the dashboard stocks
  const asked = [];
  await runAll(c.dataStore, { key: "", fetchImpl: async (u) => { asked.push(decodeURIComponent(u)); return news(u); }, log: () => {} });
  assert.equal(asked.length, 5); assert.ok(asked.some((u) => u.includes("ITC share"))); assert.ok(!asked.some((u) => u.includes("Tata Motors")));
  assert.equal(Object.keys((await dashboardData(c.dataStore)).stocks).length, 5);
});

test("limit on number of stocks", async () => {
  const c = client(async () => ({ ok: true, text: async () => "<rss></rss>" }));
  await c.call("login", { password: "correct horse" });
  for (let i = 0; i < MAX_STOCKS - 5; i++) assert.equal((await c.call("watch", { op: "add", symbol: `S${i}.NS`, name: `S${i}` })).status, 200);
  const r = await c.call("watch", { op: "add", symbol: "ONEMORE.NS" });
  assert.equal(r.status, 400); assert.match(r.body.error, /max 25/);
});
