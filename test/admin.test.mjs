// Offline tests for the "Manage API Keys" backend. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdmin, handleKiteCallback } from "../lib/admin.mjs";
import { encrypt, decrypt, kiteTokenValid, kiteChecksum, loadSecrets } from "../lib/secrets.mjs";

const memStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) }; };
const ENV = { ADMIN_PASSWORD: "correct horse", KEYS_SECRET: "a".repeat(64) };
const H = "https://site.example";
function client(env = ENV, fetchImpl) {
  const adminStore = memStore(), dataStore = memStore();
  let jar = "";
  const call = async (path, body, method) => {
    const headers = { origin: H }; if (jar) headers.cookie = jar;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleAdmin(new Request(H + "/api/admin/" + path, { method: method || (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      { adminStore, dataStore, env, fetchImpl });
    const sc = res.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0];
    return { status: res.status, body: await res.json(), setCookie: sc };
  };
  return { call, adminStore, dataStore, get jar() { return jar; } };
}

test("not set up: page is told to run Deploy.command", async () => {
  const c = client({});
  const miss = { setup: false, loggedIn: false, missing: ["ADMIN_PASSWORD", "KEYS_SECRET"] };
  assert.deepEqual((await c.call("status")).body, miss);
  assert.deepEqual((await c.call("keys")).body, miss);
  const half = client({ ADMIN_PASSWORD: "x" });
  assert.deepEqual((await half.call("status")).body.missing, ["KEYS_SECRET"]);
});

test("settings are also read the new Netlify way (Netlify.env)", async () => {
  const { runtimeEnv, isSetUp } = await import("../lib/secrets.mjs");
  const vals = { ADMIN_PASSWORD: "pw-from-netlify-env", KEYS_SECRET: "k" };
  globalThis.Netlify = { env: { get: (k) => vals[k] } };
  try { assert.equal(runtimeEnv().ADMIN_PASSWORD, "pw-from-netlify-env"); assert.equal(isSetUp(), true); }
  finally { delete globalThis.Netlify; }
});

test("everything needs login; wrong password is refused and locks after 5 tries", async () => {
  const c = client();
  assert.equal((await c.call("keys")).status, 401);
  assert.equal((await c.call("keys", { provider: "anthropic", values: { api_key: "x" } })).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await c.call("login", { password: "nope" })).status, 401);
  const locked = await c.call("login", { password: "correct horse" });
  assert.equal(locked.status, 429, "locked even with right password");
});

test("login cookie is HttpOnly/Secure; save masks secrets; test, remove work; storage is encrypted", async () => {
  let seenKey = null;
  const fetchImpl = async (url, o) => { seenKey = o.headers["x-api-key"]; return { ok: seenKey === "sk-ant-REALKEY1234", status: 401 }; };
  const c = client(ENV, fetchImpl);
  const lg = await c.call("login", { password: "correct horse" });
  assert.equal(lg.status, 200);
  assert.match(lg.setCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await c.call("status")).body.loggedIn, true);

  let r = await c.call("keys", { provider: "anthropic", values: { api_key: "sk-ant-REALKEY1234", model: "claude-haiku-5-5" } });
  const a = r.body.providers.find((p) => p.id === "anthropic");
  assert.equal(a.fields[0].shown, "••••1234"); assert.equal(a.fields[1].shown, "claude-haiku-5-5");
  assert.ok(!JSON.stringify(r.body).includes("REALKEY"), "full key never sent back");
  assert.ok(!c.adminStore.m.get("secrets").includes("REALKEY"), "stored encrypted");

  r = await c.call("test", { provider: "anthropic" });
  assert.equal(seenKey, "sk-ant-REALKEY1234"); assert.equal(r.body.result.ok, true);
  // empty values do not wipe a saved key
  assert.equal((await c.call("keys", { provider: "anthropic", values: { api_key: "  " } })).status, 400);
  r = await c.call("remove", { provider: "anthropic" });
  assert.equal(r.body.providers.find((p) => p.id === "anthropic").fields[0].set, false);

  await c.call("logout", {});
  assert.equal((await c.call("keys")).status, 401);
});

test("request from another website is blocked", async () => {
  const c = client();
  await c.call("login", { password: "correct horse" });
  const res = await handleAdmin(new Request(H + "/api/admin/remove", { method: "POST", headers: { origin: "https://evil.example", cookie: c.jar }, body: "{}" }),
    { adminStore: c.adminStore, dataStore: c.dataStore, env: ENV });
  assert.equal(res.status, 403);
});

test("changing the admin password logs everyone out but keeps keys", async () => {
  const c = client();
  await c.call("login", { password: "correct horse" });
  await c.call("keys", { provider: "youtube", values: { api_key: "AIzaSECRET9999" } });
  const env2 = { ...ENV, ADMIN_PASSWORD: "new password!" };
  const res = await handleAdmin(new Request(H + "/api/admin/status", { headers: { cookie: c.jar } }), { adminStore: c.adminStore, dataStore: c.dataStore, env: env2 });
  assert.equal((await res.json()).loggedIn, false);
  assert.equal((await loadSecrets(c.adminStore, env2)).youtube.api_key, "AIzaSECRET9999");
});

test("encryption round trip; wrong secret cannot read", () => {
  const box = encrypt({ x: 1 }, "s1");
  assert.deepEqual(decrypt(box, "s1"), { x: 1 });
  assert.throws(() => decrypt(box, "s2"));
});

test("Kite token resets at 6 AM India time", () => {
  const at = "2026-11-04T00:00:00Z"; // 5:30 AM IST
  assert.equal(kiteTokenValid(at, new Date("2026-11-04T00:20:00Z")), true);  // 5:50 IST same morning
  assert.equal(kiteTokenValid(at, new Date("2026-11-04T00:31:00Z")), false); // 6:01 IST
  assert.equal(kiteTokenValid("2026-11-04T01:00:00Z", new Date("2026-11-05T00:00:00Z")), true); // next day 5:30 IST
  assert.match(kiteChecksum("k", "r", "s"), /^[0-9a-f]{64}$/);
});

test("Zerodha: login redirect and callback store the day's token", async () => {
  let sent;
  const fetchImpl = async (url, o) => { sent = { url, body: o.body }; return { ok: true, json: async () => ({ status: "success", data: { access_token: "ACCESS1", user_name: "Test User" } }) }; };
  const c = client(ENV, fetchImpl);
  await c.call("login", { password: "correct horse" });
  await c.call("keys", { provider: "kite", values: { api_key: "kitekey123", api_secret: "kitesecret456" } });
  const ctx = { adminStore: c.adminStore, env: ENV, fetchImpl, checksum: kiteChecksum };
  let res = await handleKiteCallback(new Request(H + "/api/kite/login", { headers: { cookie: c.jar } }), ctx);
  assert.equal(res.headers.get("location"), "https://kite.zerodha.com/connect/login?v=3&api_key=kitekey123");
  res = await handleKiteCallback(new Request(H + "/api/kite/callback?request_token=RT9&action=login&status=success"), ctx);
  assert.match(res.headers.get("location"), /kite=login-first/, "no admin session -> refused");
  res = await handleKiteCallback(new Request(H + "/api/kite/callback?request_token=RT9&action=login&status=success", { headers: { cookie: c.jar } }), ctx);
  assert.match(res.headers.get("location"), /#\/keys\?kite=ok$/);
  assert.equal(sent.url, "https://api.kite.trade/session/token");
  assert.match(sent.body, new RegExp(`checksum=${kiteChecksum("kitekey123", "RT9", "kitesecret456")}`));
  const k = (await c.call("keys")).body.providers.find((p) => p.id === "kite");
  assert.equal(k.kite.loggedIn, true); assert.equal(k.kite.user, "Test User");
  assert.ok(!c.adminStore.m.get("secrets").includes("ACCESS1"));
});

test("Run now uses the Claude key saved on the website", async () => {
  const d = new Date().toUTCString(); let claudeKey = null;
  const fetchImpl = async (url, o) => {
    if (url.includes("anthropic")) { claudeKey = o.headers["x-api-key"];
      const n = (JSON.parse(o.body).messages[0].content.match(/^\d+\. /gm) || []).length;
      assert.equal(JSON.parse(o.body).model, "claude-test-model");
      return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: i + 1, score: 0.4, label: "positive", reason: "ok" }))) }] }) }; }
    return { ok: true, text: async () => `<rss><item><title>Shares steady - Mint</title><link>${url}#1</link><pubDate>${d}</pubDate><source>Mint</source></item></rss>` };
  };
  const c = client(ENV, fetchImpl);
  await c.call("login", { password: "correct horse" });
  await c.call("keys", { provider: "anthropic", values: { api_key: "sk-ant-SAVED0001", model: "claude-test-model" } });
  const r = await c.call("collect", {});
  assert.equal(r.status, 200);
  assert.ok(r.body.results.every((x) => x.new === 1 && x.scored === 1), JSON.stringify(r.body));
  assert.equal(claudeKey, "sk-ant-SAVED0001");
  const meta = JSON.parse(c.dataStore.m.get("meta"));
  assert.equal(meta.engine, "Claude (claude-test-model)");
});
