// Order relay: runs on Google Cloud Run (your Firebase project) behind a STATIC IP, because Zerodha only accepts
// API orders from a registered static IP (SEBI rule from 1 April 2026). It does one job: forward a signed order
// from your Netlify website to Zerodha (place, and for the scalping page: cancel / change price). Requests without the right HMAC signature (RELAY_SECRET) are refused.
import crypto from "node:crypto";

const MAX_AGE_MS = 60_000;     // a signed request is only valid for 60 seconds (stops replays)
const ok = (json, status = 200) => ({ status, json });

export function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function validOrder(o) {
  if (!o || typeof o !== "object") return "order missing";
  if (!["NSE", "BSE", "NFO"].includes(o.exchange)) return "exchange must be NSE, BSE or NFO";
  if (!/^[A-Z0-9&\-_.]{1,40}$/.test(o.tradingsymbol || "")) return "bad symbol";
  if (!["BUY", "SELL"].includes(o.transaction_type)) return "side must be BUY or SELL";
  if (!["MARKET", "LIMIT", "SL"].includes(o.order_type)) return "order type must be MARKET, LIMIT or SL";
  if (o.exchange === "NFO" ? !["NRML", "MIS"].includes(o.product) : !["CNC", "MIS"].includes(o.product))
    return o.exchange === "NFO" ? "options product must be NRML or MIS" : "product must be CNC or MIS";
  if (!Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > 100000) return "bad quantity";
  if ((o.order_type === "LIMIT" || o.order_type === "SL") && !(Number(o.price) > 0)) return "limit price missing";
  if (o.order_type === "SL") {                       // stop-loss limit: waits on the exchange until the trigger price trades
    const p = Number(o.price), t = Number(o.trigger_price);
    if (!(t > 0)) return "trigger price missing";
    if (o.transaction_type === "SELL" ? p > t : p < t) return "SL limit must be beyond the trigger (sell: limit <= trigger)";
  }
  return null;
}

export async function handleRelay({ method, path, body = "", headers = {} }, { secret, fetchImpl = fetch, now = Date.now() }) {
  if (method === "GET" && path === "/health") {
    // Shows which IP Zerodha will see. It must equal the static IP you registered with Zerodha.
    let ip = null;
    try { ip = (await (await fetchImpl("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) })).json()).ip; } catch {}
    return ok({ ok: true, ip, configured: !!secret });
  }
  if (method !== "POST" || !["/order", "/cancel", "/modify"].includes(path)) return ok({ error: "not found" }, 404);
  if (!secret) return ok({ error: "relay not configured" }, 503);

  const sig = String(headers["x-relay-signature"] || "");
  const good = sign(secret, body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return ok({ error: "bad signature" }, 401);

  let msg;
  try { msg = JSON.parse(body); } catch { return ok({ error: "bad json" }, 400); }
  if (!Number.isFinite(msg.ts) || Math.abs(now - msg.ts) > MAX_AGE_MS) return ok({ error: "request expired" }, 401);
  const k = msg.kite || {};
  if (!k.api_key || !k.access_token) return ok({ error: "zerodha login missing" }, 400);
  const kiteHeaders = { "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}`, "content-type": "application/x-www-form-urlencoded" };

  let url, init;
  if (path === "/order") {
    const o = msg.order;
    const bad = validOrder(o);
    if (bad) return ok({ error: bad }, 400);
    const form = new URLSearchParams({
      tradingsymbol: o.tradingsymbol, exchange: o.exchange, transaction_type: o.transaction_type,
      order_type: o.order_type, quantity: String(o.quantity), product: o.product, validity: "DAY",
      tag: "sentimentbaro",
    });
    if (o.order_type === "LIMIT" || o.order_type === "SL") form.set("price", String(o.price));
    else form.set("market_protection", "-1");
    if (o.order_type === "SL") form.set("trigger_price", String(o.trigger_price));     // exchanges require market protection on API market orders; -1 = automatic
    url = "https://api.kite.trade/orders/regular"; init = { method: "POST", body: form.toString() };
  } else {
    // Scalping page: cancel an open order, or change an open LIMIT order's price (SL chase / exit now).
    const id = String(msg.order_id || "");
    if (!/^[0-9]{1,24}$/.test(id)) return ok({ error: "bad order id" }, 400);
    url = `https://api.kite.trade/orders/regular/${id}`;
    if (path === "/cancel") init = { method: "DELETE" };
    else {
      const price = Number(msg.price), trig = msg.trigger_price == null ? null : Number(msg.trigger_price);
      if (!(price > 0 && price < 1e7)) return ok({ error: "bad price" }, 400);
      if (trig != null && !(trig > 0 && trig < 1e7 && price <= trig)) return ok({ error: "bad trigger price" }, 400);
      // a stop-loss move (trailing) keeps it an SL order; a price-only change makes it a plain LIMIT (chase / exit)
      init = { method: "PUT", body: new URLSearchParams(trig != null ? { order_type: "SL", price: String(price), trigger_price: String(trig) } : { order_type: "LIMIT", price: String(price) }).toString() };
    }
  }

  let r, d;
  try {
    r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000), headers: kiteHeaders });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    return ok({ error: "Zerodha se jawab nahi aaya (" + (e.name === "TimeoutError" ? "time out" : e.message) + "). Kite app mein orders check kariye." }, 502);
  }
  if (r.ok && d.status === "success" && d.data?.order_id) return ok({ ok: true, order_id: String(d.data.order_id) });
  return ok({ error: d.message || `Zerodha answered ${r.status}`, error_type: d.error_type || null }, r.status >= 400 ? r.status : 502);
}
