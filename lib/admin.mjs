// Logic behind the "Manage API Keys" page. Kept apart from the Netlify wrapper so it can be tested offline.
import { PROVIDERS, byId } from "./providers.mjs";
import { isSetUp, missingSetup, runtimeEnv, loadSecrets, saveSecrets, mask, makeSession, checkSession, passwordOk, cookieOf,
         COOKIE, SESSION_HOURS, kiteTokenValid } from "./secrets.mjs";
import { testProvider } from "./keytests.mjs";
import { runAll, scoringOptions, collectStock, dashboardData } from "./pipeline.mjs";
import { getWatchlist, saveWatchlist, entryFrom, MAX_STOCKS } from "./watchlist.mjs";
import { saveSettings, getSettings } from "./settings.mjs";
import { scanNews, makeReport } from "./scan.mjs";
import { aiAnalyze, aiStrategy } from "./aianalyze.mjs";
import { aiTrade, getUsage, setLimit } from "./aitrade.mjs";
import { getJournal, addTrade, clearPaper, getAuto, saveAuto, autoGuard, bumpAuto, todayAI } from "./journal.mjs";
import { placeOrder, tradingStatus, changeOrder, orderStatus, quoteLtp } from "./orders.mjs";

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

export async function handleAdmin(req, { adminStore, dataStore, cacheStore = null, env = runtimeEnv(), fetchImpl = fetch }) {
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
  if (action === "status") {
    const extra = loggedIn ? { trading: tradingStatus(await loadSecrets(adminStore, env)) } : {};
    return json({ setup: true, loggedIn, ...extra });
  }
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

  if (action === "order" && req.method === "POST") {
    if (body.confirm !== true) return json({ error: "Order confirm nahi hua." }, 400);
    // double-click guard for new positions; an option SELL only closes what you hold (checked in placeOrder),
    // and the scalping page must be able to put its target / stop-loss in right after the entry fills
    const closingOpt = /\.NFO$/i.test(String(body.symbol || "")) && String(body.side || "").toUpperCase() === "SELL";
    if (!closingOpt) {
      const last = (await adminStore.get("order-lock", { type: "json" })) || {};
      if (Date.now() - (last.at || 0) < 3000) return json({ error: "Ek order abhi-abhi gaya hai. 3 second ruk kar dobara try kariye." }, 429);
      await adminStore.setJSON("order-lock", { at: Date.now() });
    }
    // the AI's own BUY orders (Scalping "Auto trade", real mode): daily trade / loss / lot limits checked here too
    const autoBuy = body.auto === true && String(body.side || "").toUpperCase() === "BUY";
    if (autoBuy) { const g = await autoGuard(adminStore, body); if (g) return json({ error: g }, 429); }
    const res = await placeOrder(body, all, { fetchImpl, cache: cacheStore });
    if (autoBuy && res.ok) await bumpAuto(adminStore);
    const log = (await adminStore.get("orders", { type: "json" })) || [];
    log.unshift({ at: new Date().toISOString(), order: res.order || { symbol: body.symbol, side: body.side, qty: body.qty ?? (body.lots ? body.lots + " lot" : "") },
                  value: res.value ?? null, ok: !!res.ok, order_id: res.order_id || null, error: res.error || null });
    await adminStore.setJSON("orders", log.slice(0, 50));
    const { status, ...out } = res;
    return json(out, status);
  }

  // Scalping page: {op:"cancel"|"modify", order_id, price?}  and  GET order-status?id=
  if (action === "order-change" && req.method === "POST") {
    const res = await changeOrder(body, all, { fetchImpl });
    const log = (await adminStore.get("orders", { type: "json" })) || [];
    log.unshift({ at: new Date().toISOString(), order: { op: body.op, order_id: String(body.order_id || ""), price: body.price ?? null, symbol: res.order?.tradingsymbol || null },
                  value: null, ok: !!res.ok, order_id: res.order_id || null, error: res.error || null });
    await adminStore.setJSON("orders", log.slice(0, 50));
    const { status, ...out } = res;
    return json(out, status);
  }
  if (action === "ltp" && req.method === "GET") {
    const { status, ...out } = await quoteLtp(url.searchParams.get("sym"), all, { fetchImpl });
    return json(out, status);
  }
  if (action === "order-status" && req.method === "GET") {
    const { status, ...out } = await orderStatus(url.searchParams.get("id"), all, { fetchImpl });
    return json(out, status);
  }

  // Live ticks on the chart page: the browser connects to Zerodha's WebSocket itself (admin only).
  // The day's access token can read market data; orders still only go through the static-IP relay.
  if (action === "ticker" && req.method === "GET") {
    const kk = all.kite || {};
    if (!kk.api_key || !kk.access_token || !kiteTokenValid(kk.token_at)) return json({ error: "Aaj Zerodha login nahi hua. API Keys mein 'Login with Zerodha' kariye." }, 400);
    return json({ api_key: kk.api_key, access_token: kk.access_token });
  }

  if (action === "orders" && req.method === "GET") return json({ orders: (await adminStore.get("orders", { type: "json" })) || [] });

  // Dashboard stock list: {op:"add", symbol, name, index} or {op:"remove", key}. Returns fresh dashboard data.
  if (action === "watch" && req.method === "POST") {
    const list = await getWatchlist(dataStore);
    if (body.op === "remove") {
      const key = String(body.key || "").toUpperCase();
      if (!list[key]) return json({ error: "Ye stock dashboard par nahi hai." }, 400);
      delete list[key];
      await saveWatchlist(dataStore, list);
    } else if (body.op === "add") {
      const { key, entry, error } = entryFrom(body);
      if (error) return json({ error }, 400);
      if (list[key]) return json({ error: `${key} pehle se dashboard par hai.` }, 400);
      if (Object.keys(list).length >= MAX_STOCKS) return json({ error: `Dashboard par max ${MAX_STOCKS} stocks ho sakte hain. Pehle koi hataiye.` }, 400);
      list[key] = entry;
      await saveWatchlist(dataStore, list);
      // fetch its news right away (short budget); the hourly run does the rest
      try { await collectStock(dataStore, key, entry, { ...scoringOptions(all, env), fetchImpl, deadline: Date.now() + 6500, newsTimeout: 3500, log: () => {} }); } catch {}
    } else return json({ error: "unknown op" }, 400);
    return json({ ok: true, data: await dashboardData(dataStore) });
  }

  // Sentiment page settings (non-secret, stored next to the news data)
  if (action === "settings" && req.method === "POST") return json({ settings: await saveSettings(dataStore, body.settings || {}) });

  // Scan news -> AI report. Step "news" fetches + scores, step "report" writes the report from the saved scan.
  if (action === "scan" && req.method === "POST") {
    const so = scoringOptions(all, env), o = { apiKey: so.key, model: so.model, fetchImpl };
    try {
      if (body.step === "report") return json({ report: await makeReport(String(body.key || "").toUpperCase(), dataStore, o) });
      return json({ scan: await scanNews({ symbol: body.symbol, name: body.name, index: !!body.index }, dataStore, o) });
    } catch (e) { return json({ error: e.message }, 400); }
  }
  // Backtest page AI: {mode:"analyze", symbol, name, interval, stats, candles, backtest?, prompt} | {mode:"strategy", prompt, interval}
  // Scalping AI trade assistant: one Haiku call per click, daily limit
  if (action === "ai" && req.method === "POST" && body.mode === "trade") {
    try { const { status, ...out } = await aiTrade(body, { adminStore, dataStore, apiKey: scoringOptions(all, env).key, fetchImpl }); return json(out, status); }
    catch (e) { return json({ error: e.message, usage: await getUsage(adminStore) }, 400); }
  }
  if (action === "ai-usage" && req.method === "GET") {
    const j = await getJournal(adminStore);
    return json({ usage: await getUsage(adminStore), auto: await getAuto(adminStore), today: { paper: todayAI(j, "paper"), real: todayAI(j, "real") } });
  }
  if (action === "ai-auto" && req.method === "POST") return json({ auto: await saveAuto(adminStore, body.auto || {}) });
  // Trade summary (journal): GET list; POST {op:"add", trade} (reviewed by AI or a simple rule) | {op:"clear", mode:"paper"}
  if (action === "journal") {
    if (req.method === "GET") return json({ trades: await getJournal(adminStore) });
    if (body.op === "clear") return json({ trades: await clearPaper(adminStore) });
    if (body.op === "add") {
      const so = scoringOptions(all, env), st = await getSettings(dataStore).catch(() => ({}));
      const lang = { english: "simple English", hindi: "simple Hindi (Devanagari)" }[st.reportLang] || "Hinglish (Hindi words in English letters, simple)";
      const { status, ...out } = await addTrade(body, { adminStore, apiKey: so.key, model: "claude-haiku-5-5", lang, fetchImpl });
      return json(out, status);
    }
    return json({ error: "unknown op" }, 400);
  }
  if (action === "ai-limit" && req.method === "POST") {
    try { return json({ usage: await setLimit(adminStore, body.limit) }); } catch (e) { return json({ error: e.message }, 400); }
  }
  if (action === "ai" && req.method === "POST") {
    const so = scoringOptions(all, env), o = { apiKey: so.key, model: so.model, fetchImpl };
    try { return json(body.mode === "strategy" ? await aiStrategy(body, o) : await aiAnalyze(body, dataStore, o)); }
    catch (e) { return json({ error: e.message }, 400); }
  }

  if (action === "report" && req.method === "GET") {
    const key = String(url.searchParams.get("key") || "").toUpperCase();
    return json({ report: key ? await dataStore.get(`report-${key}`, { type: "json" }) : null });
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
