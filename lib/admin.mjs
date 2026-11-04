// Logic behind the "Manage API Keys" page. Kept apart from the Netlify wrapper so it can be tested offline.
import { PROVIDERS, byId } from "./providers.mjs";
import { isSetUp, missingSetup, runtimeEnv, loadSecrets, saveSecrets, mask, makeSession, checkSession, passwordOk, cookieOf,
         COOKIE, SESSION_HOURS, kiteTokenValid } from "./secrets.mjs";
import { testProvider } from "./keytests.mjs";
import { runAll, scoringOptions } from "./pipeline.mjs";

const MAX_FAILS = 5, LOCK_MIN = 15;
const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const cookie = (val, maxAge) => `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// What the page sees: never the full secret values.
export function publicView(all, now = new Date()) {
  return PROVIDERS.map((p) => {
    const v = all[p.id] || {};
    const view = {
      id: p.id, name: p.name, group: p.group, status: p.status, purpose: p.purpose, link: p.link || null,
      cost: p.cost || null, noKey: !!p.noKey, updated: v._updated || null, test: v._test || null,
      fields: p.fields.map((f) => ({ id: f.id, label: f.label, secret: f.secret, placeholder: f.placeholder,
        set: !!v[f.id], shown: f.secret ? mask(v[f.id]) : v[f.id] || "" })),
    };
    if (p.id === "kite") view.kite = { loggedIn: kiteTokenValid(v.token_at, now) && !!v.access_token, user: v.user || null, at: v.token_at || null };
    return view;
  });
}

export async function handleAdmin(req, { adminStore, dataStore, env = runtimeEnv(), fetchImpl = fetch }) {
  const url = new URL(req.url), action = url.pathname.replace(/^.*\/api\/admin\/?/, "");
  if (!isSetUp(env)) return json({ setup: false, loggedIn: false, missing: missingSetup(env) });

  // Requests that change things must come from this same website.
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== url.host) return json({ error: "wrong origin" }, 403);
  }

  if (action === "login" && req.method === "POST") {
    const lock = (await adminStore.get("auth", { type: "json" })) || { fails: 0, until: 0 };
    if (lock.until > Date.now()) return json({ error: `Bahut baar galat password. ${Math.ceil((lock.until - Date.now()) / 60000)} minute baad try karein.` }, 429);
    const body = await req.json().catch(() => ({}));
    if (!passwordOk(body.password, env)) {
      const fails = lock.fails + 1;
      await adminStore.setJSON("auth", fails >= MAX_FAILS ? { fails: 0, until: Date.now() + LOCK_MIN * 60000 } : { fails, until: 0 });
      return json({ error: "Password galat hai." }, 401);
    }
    await adminStore.setJSON("auth", { fails: 0, until: 0 });
    return json({ ok: true }, 200, { "set-cookie": cookie(makeSession(env), SESSION_HOURS * 3600) });
  }

  const loggedIn = checkSession(cookieOf(req), env);
  if (action === "status") return json({ setup: true, loggedIn });
  if (action === "logout") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  if (!loggedIn) return json({ error: "Pehle login kariye." }, 401);

  const all = await loadSecrets(adminStore, env);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const p = body.provider ? byId(body.provider) : null;

  if (action === "keys" && req.method === "GET") return json({ providers: publicView(all) });

  if (action === "keys" && req.method === "POST") {
    if (!p || p.noKey) return json({ error: "unknown provider" }, 400);
    const cur = { ...(all[p.id] || {}) };
    let changed = false;
    for (const f of p.fields) {
      const val = typeof body.values?.[f.id] === "string" ? body.values[f.id].trim() : "";
      if (val && val.length <= 500) { cur[f.id] = val; changed = true; }
    }
    if (!changed) return json({ error: "Koi nayi value nahi di." }, 400);
    if (p.id === "kite") { delete cur.access_token; delete cur.token_at; delete cur.user; } // new keys: login again
    cur._updated = new Date().toISOString(); delete cur._test;
    all[p.id] = cur;
    await saveSecrets(adminStore, all, env);
    return json({ providers: publicView(all) });
  }

  if (action === "remove" && req.method === "POST") {
    if (!p) return json({ error: "unknown provider" }, 400);
    delete all[p.id];
    await saveSecrets(adminStore, all, env);
    return json({ providers: publicView(all) });
  }

  if (action === "test" && req.method === "POST") {
    if (!p) return json({ error: "unknown provider" }, 400);
    let res;
    try { res = await testProvider(p.id, all[p.id] || {}, fetchImpl); }
    catch (e) { res = { ok: false, msg: `Connection nahi hua (${e.name === "TimeoutError" ? "time out" : e.message}).` }; }
    res.at = new Date().toISOString();
    all[p.id] = { ...(all[p.id] || {}), _test: res };
    await saveSecrets(adminStore, all, env);
    return json({ result: res, providers: publicView(all) });
  }

  if (action === "collect" && req.method === "POST") {
    // Netlify stops normal functions after ~10 s, so this run has a time budget; unfinished scoring is done next hour.
    const logs = [];
    const results = await runAll(dataStore, { ...scoringOptions(all, env), fetchImpl, deadline: Date.now() + 8000, newsTimeout: 4000, log: (x) => logs.push(x) });
    return json({ results });
  }

  return json({ error: "not found" }, 404);
}

// /api/kite/login sends the admin to Zerodha's login page; Zerodha then sends them back to
// /api/kite/callback with a one-time request_token, which we swap for the day's access token.
export async function handleKiteCallback(req, { adminStore, env = runtimeEnv(), fetchImpl = fetch, checksum }) {
  const url = new URL(req.url), back = (msg) => Response.redirect(new URL(`/#/keys?kite=${encodeURIComponent(msg)}`, url).toString(), 302);
  if (!isSetUp(env) || !checkSession(cookieOf(req), env)) return back("login-first");
  if (url.pathname.endsWith("/login")) {
    const k = (await loadSecrets(adminStore, env)).kite || {};
    if (!k.api_key || !k.api_secret) return back("no-keys");
    return Response.redirect(`https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(k.api_key)}`, 302);
  }
  const rt = url.searchParams.get("request_token");
  if (!rt || url.searchParams.get("status") === "cancelled") return back("cancelled");
  const all = await loadSecrets(adminStore, env), k = all.kite || {};
  if (!k.api_key || !k.api_secret) return back("no-keys");
  try {
    const r = await fetchImpl("https://api.kite.trade/session/token", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "X-Kite-Version": "3", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: k.api_key, request_token: rt, checksum: checksum(k.api_key, rt, k.api_secret) }).toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.data?.access_token) return back("failed");
    all.kite = { ...k, access_token: d.data.access_token, token_at: new Date().toISOString(), user: d.data.user_name || d.data.user_id || "",
                 _test: { ok: true, msg: "Zerodha login ho gaya.", at: new Date().toISOString() } };
    await saveSecrets(adminStore, all, env);
    return back("ok");
  } catch {
    return back("failed");
  }
}
