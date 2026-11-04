// Buy/Sell from the website. Checks the order and your safety limits here (Netlify), then sends it,
// signed with RELAY_SECRET, to the order relay on Google Cloud (static IP) which passes it to Zerodha.
import { toKite, kiteReady } from "./prices.mjs";
import { sign, validOrder } from "../relay/relay.mjs";

export const DEFAULT_LIMITS = { max_qty: 10, max_value: 25000 };
const num = (v, d) => { const n = Number(String(v ?? "").replace(/[,₹\s]/g, "")); return Number.isFinite(n) && n > 0 ? n : d; };
export const limitsOf = (relay = {}) => ({
  max_qty: Math.floor(num(relay.max_qty, DEFAULT_LIMITS.max_qty)), max_value: num(relay.max_value, DEFAULT_LIMITS.max_value) });

export function tradingStatus(secrets = {}) {
  const r = secrets.order_relay || {};
  return { relay: !!(r.url && r.secret), kite: kiteReady(secrets.kite), limits: limitsOf(r) };
}

// body from the page: {symbol:"ITC.NS", side:"BUY", qty:5, order_type:"LIMIT", price:280.5, product:"CNC"}
export function buildOrder(body = {}) {
  const ins = toKite(String(body.symbol || ""));
  if (!ins) return { error: "Sirf NSE/BSE ke stocks (jaise ITC.NS) ka order de sakte hain." };
  const [exchange, tradingsymbol] = ins.split(":");
  const order = {
    exchange, tradingsymbol, transaction_type: String(body.side || "").toUpperCase(),
    order_type: String(body.order_type || "").toUpperCase(), product: String(body.product || "").toUpperCase(),
    quantity: Number(body.qty),
  };
  if (order.order_type === "LIMIT") order.price = Math.round(Number(body.price) * 100) / 100;
  const bad = validOrder(order);
  return bad ? { error: "Order theek nahi: " + bad } : { order };
}

async function lastPrice(ins, k, fetchImpl) {
  const r = await fetchImpl(`https://api.kite.trade/quote/ltp?i=${encodeURIComponent(ins)}`, {
    headers: { "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}` }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Zerodha answered ${r.status}`);
  return (await r.json()).data?.[ins]?.last_price ?? null;
}

export async function placeOrder(body, secrets, { fetchImpl = fetch, now = Date.now() } = {}) {
  const st = tradingStatus(secrets);
  if (!st.relay) return { status: 400, error: "Pehle Manage API Keys mein 'Order relay (Firebase)' ka URL aur secret save kariye." };
  if (!st.kite) return { status: 400, error: "Aaj Zerodha login nahi hua. Manage API Keys mein 'Login with Zerodha' dabaiye." };
  const { order, error } = buildOrder(body);
  if (error) return { status: 400, error };
  if (order.quantity > st.limits.max_qty) return { status: 400, error: `Quantity limit ${st.limits.max_qty} hai. Limit Manage API Keys mein badal sakte hain.` };

  const k = secrets.kite, ins = `${order.exchange}:${order.tradingsymbol}`;
  let px = order.price;
  if (order.order_type === "MARKET") {
    try { px = await lastPrice(ins, k, fetchImpl); } catch { px = null; }
    if (!px) return { status: 400, error: "Market order ke liye abhi ka daam nahi mila, isliye order roka. Limit order try kariye." };
  }
  const value = Math.round(px * order.quantity * 100) / 100;
  if (value > st.limits.max_value) return { status: 400, error: `Order ki rakam ₹${value.toLocaleString("en-IN")} hai, limit ₹${st.limits.max_value.toLocaleString("en-IN")} hai.` };

  const payload = JSON.stringify({ ts: now, order, kite: { api_key: k.api_key, access_token: k.access_token } });
  let r, d;
  try {
    r = await fetchImpl(secrets.order_relay.url.replace(/\/+$/, "") + "/order", {
      method: "POST", body: payload, signal: AbortSignal.timeout(9000),
      headers: { "content-type": "application/json", "x-relay-signature": sign(secrets.order_relay.secret, payload) } });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    return { status: 502, error: "Relay se jawab nahi aaya. Order gaya ya nahi, Kite app ke Orders mein zaroor check kariye.", order, value };
  }
  if (r.ok && d.order_id) return { status: 200, ok: true, order_id: d.order_id, order, value };
  return { status: r.status === 401 ? 502 : 400, error: "Zerodha/relay: " + (d.error || `answered ${r.status}`), order, value };
}
