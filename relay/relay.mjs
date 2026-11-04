// Order relay: runs on Google Cloud Run (your Firebase project) behind a STATIC IP, because Zerodha only accepts
// API orders from a registered static IP (SEBI rule from 1 April 2026). It does one job: forward a signed order
// from your Netlify website to Zerodha. Requests without the right HMAC signature (RELAY_SECRET) are refused.
import crypto from "node:crypto";

const MAX_AGE_MS = 60_000;     // a signed request is only valid for 60 seconds (stops replays)
const ok = (json, status = 200) => ({ status, json });

export function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function validOrder(o) {
  if (!o || typeof o !== "object") return "order missing";
  if (!["NSE", "BSE"].includes(o.exchange)) return "exchange must be NSE or BSE";
  if (!/^[A-Z0-9&\-_.]{1,40}$/.test(o.tradingsymbol || "")) return "bad symbol";
  if (!["BUY", "SELL"].includes(o.transaction_type)) return "side must be BUY or SELL";
  if (!["MARKET", "LIMIT"].includes(o.order_type)) return "order type must be MARKET or LIMIT";
  if (!["CNC", "MIS"].includes(o.product)) return "product must be CNC or MIS";
  if (!Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > 100000) return "bad quantity";
  if (o.order_type === "LIMIT" && !(Number(o.price) > 0)) return "limit price missing";
  return null;
}

export async function handleRelay({ method, path, body = "", headers = {} }, { secret, fetchImpl = fetch, now = Date.now() }) {
  if (method === "GET" && path === "/health") {
    // Shows which IP Zerodha will see. It must equal the static IP you registered with Zerodha.
    let ip = null;
    try { ip = (await (await fetchImpl("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) })).json()).ip; } catch {}
    return ok({ ok: true, ip, configured: !!secret });
  }
  if (method !== "POST" || path !== "/order") return ok({ error: "not found" }, 404);
  if (!secret) return ok({ error: "relay not configured" }, 503);

  const sig = String(headers["x-relay-signature"] || "");
  const good = sign(secret, body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return ok({ error: "bad signature" }, 401);

  let msg;
  try { msg = JSON.parse(body); } catch { return ok({ error: "bad json" }, 400); }
  if (!Number.isFinite(msg.ts) || Math.abs(now - msg.ts) > MAX_AGE_MS) return ok({ error: "request expired" }, 401);
  const o = msg.order, k = msg.kite || {};
  const bad = validOrder(o);
  if (bad) return ok({ error: bad }, 400);
  if (!k.api_key || !k.access_token) return ok({ error: "zerodha login missing" }, 400);

  const form = new URLSearchParams({
    tradingsymbol: o.tradingsymbol, exchange: o.exchange, transaction_type: o.transaction_type,
    order_type: o.order_type, quantity: String(o.quantity), product: o.product, validity: "DAY",
    tag: "sentimentbaro",
  });
  if (o.order_type === "LIMIT") form.set("price", String(o.price));
  else form.set("market_protection", "-1");     // exchanges require market protection on API market orders; -1 = automatic

  let r, d;
  try {
    r = await fetchImpl("https://api.kite.trade/orders/regular", {
      method: "POST", body: form.toString(), signal: AbortSignal.timeout(8000),
      headers: { "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}`, "content-type": "application/x-www-form-urlencoded" },
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    return ok({ error: "Zerodha se jawab nahi aaya (" + (e.name === "TimeoutError" ? "time out" : e.message) + "). Kite app mein orders check kariye." }, 502);
  }
  if (r.ok && d.status === "success" && d.data?.order_id) return ok({ ok: true, order_id: d.data.order_id });
  return ok({ error: d.message || `Zerodha answered ${r.status}`, error_type: d.error_type || null }, r.status >= 400 ? r.status : 502);
}
