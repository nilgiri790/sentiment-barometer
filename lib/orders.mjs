// Buy/Sell from the website. Checks the order and your safety limits here (Netlify), then sends it,
// signed with RELAY_SECRET, to the order relay on Google Cloud (static IP) which passes it to Zerodha.
import { toKite, kiteReady, isOptionSym } from "./prices.mjs";
import { optionInfo } from "./options.mjs";
import { sign, validOrder } from "../relay/relay.mjs";

export const DEFAULT_LIMITS = { max_qty: 10, max_value: 25000 };
const num = (v, d) => { const n = Number(String(v ?? "").replace(/[,₹\s]/g, "")); return Number.isFinite(n) && n > 0 ? n : d; };
export const limitsOf = (relay = {}) => ({
  max_qty: Math.floor(num(relay.max_qty, DEFAULT_LIMITS.max_qty)), max_value: num(relay.max_value, DEFAULT_LIMITS.max_value),
  max_lots: Math.floor(num(relay.max_lots, 1)) });
// Options trading is OFF unless the user typed "yes" in the Order relay card.
export const fnoAllowed = (relay = {}) => /^(yes|y|haan|ha|on|true)$/i.test(String(relay.allow_fno || "").trim());

export function tradingStatus(secrets = {}) {
  const r = secrets.order_relay || {};
  return { relay: !!(r.url && r.secret), kite: kiteReady(secrets.kite), limits: limitsOf(r), fno: fnoAllowed(r) };
}

// Options: quantity is lots x lot size; product NRML (carry forward) or MIS (intraday).
export function buildOptionOrder(body = {}, info) {
  const lots = Number(body.lots);
  if (!Number.isInteger(lots) || lots < 1) return { error: "Order theek nahi: lots 1 ya usse zyada (poora number) hone chahiye." };
  const order = {
    exchange: "NFO", tradingsymbol: info.tradingsymbol, transaction_type: String(body.side || "").toUpperCase(),
    order_type: String(body.order_type || "").toUpperCase(), product: String(body.product || "").toUpperCase(),
    quantity: lots * info.lot_size,
  };
  if (order.order_type === "LIMIT" || order.order_type === "SL") order.price = Math.round(Number(body.price) * 20) / 20;   // options tick: 0.05
  if (order.order_type === "SL") order.trigger_price = Math.round(Number(body.trigger_price) * 20) / 20;
  const bad = validOrder(order);
  return bad ? { error: "Order theek nahi: " + bad } : { order, lots };
}

const kh = (k) => ({ "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}` });
const PENDING = /^(OPEN|TRIGGER PENDING|.*PENDING|.*RECEIVED|MODIFIED)$/i;
// SELL orders for this contract that are still waiting on the exchange (their qty is already "promised")
async function pendingSellQty(k, tradingsymbol, fetchImpl) {
  const r = await fetchImpl("https://api.kite.trade/orders", { headers: kh(k), signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Zerodha answered ${r.status}`);
  return ((await r.json()).data || []).filter((o) => o.exchange === "NFO" && o.tradingsymbol === tradingsymbol && o.transaction_type === "SELL" && PENDING.test(o.status || ""))
    .reduce((a, o) => a + (Number(o.pending_quantity ?? (o.quantity - (o.filled_quantity || 0))) || 0), 0);
}

async function heldQty(k, tradingsymbol, fetchImpl) {
  const r = await fetchImpl("https://api.kite.trade/portfolio/positions", {
    headers: { "X-Kite-Version": "3", Authorization: `token ${k.api_key}:${k.access_token}` }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Zerodha answered ${r.status}`);
  const net = (await r.json()).data?.net || [];
  return net.filter((p) => p.exchange === "NFO" && p.tradingsymbol === tradingsymbol).reduce((a, p) => a + (Number(p.quantity) || 0), 0);
}

// body from the page: {symbol:"ITC.NS", side:"BUY", qty:5, order_type:"LIMIT", price:280.5, product:"CNC"}
export function buildOrder(body = {}) {
  const ins = isOptionSym(String(body.symbol || "")) ? null : toKite(String(body.symbol || ""));
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

export async function placeOrder(body, secrets, { fetchImpl = fetch, now = Date.now(), cache = null } = {}) {
  const st = tradingStatus(secrets);
  if (!st.relay) return { status: 400, error: "Pehle Manage API Keys mein 'Order relay (Firebase)' ka URL aur secret save kariye." };
  if (!st.kite) return { status: 400, error: "Aaj Zerodha login nahi hua. Manage API Keys mein 'Login with Zerodha' dabaiye." };
  const k = secrets.kite;
  let order, error, closing = false;
  if (isOptionSym(String(body.symbol || ""))) {
    if (!st.fno) return { status: 400, error: "Options trading band hai. API Keys → Order relay mein 'Options trading' ko yes likh kar Save kariye." };
    let info = null;
    try { info = await optionInfo(body.symbol, k, cache, fetchImpl, now); } catch { info = null; }
    if (!info) return { status: 400, error: "Ye option contract Zerodha ki list mein nahi mila (shayad expire ho gaya)." };
    let lots;
    ({ order, error, lots } = buildOptionOrder(body, info));
    if (error) return { status: 400, error };
    if (lots > st.limits.max_lots) return { status: 400, error: `Options mein ek order ki limit ${st.limits.max_lots} lot hai. Limit API Keys mein badal sakte hain.` };
    if (order.transaction_type === "SELL") {          // no option writing from this website: only sell what you hold
      let held = 0, pending = 0;
      try { [held, pending] = await Promise.all([heldQty(k, order.tradingsymbol, fetchImpl), pendingSellQty(k, order.tradingsymbol, fetchImpl)]); }
      catch { return { status: 400, error: "Zerodha se aapki positions/orders nahi mil paaye, isliye SELL roka." }; }
      if (held < order.quantity) return { status: 400, error: `Option bechne ki ijazat sirf utna hai jitna aapke paas hai (abhi ${held} qty). Naya option likhna (writing) is website se band hai.` };
      if (held - pending < order.quantity) return { status: 400, error: `Aapke ${held} qty mein se ${pending} ka SELL order pehle se laga hai. Do SELL ek saath nahi (warna option likh jaayega). Pehla order cancel kariye.` };
      closing = true;
    }
  } else {
    ({ order, error } = buildOrder(body));
    if (error) return { status: 400, error };
    if (order.quantity > st.limits.max_qty) return { status: 400, error: `Quantity limit ${st.limits.max_qty} hai. Limit Manage API Keys mein badal sakte hain.` };
  }

  const ins = `${order.exchange}:${order.tradingsymbol}`;
  let px = order.price;
  if (order.order_type === "MARKET") {
    try { px = await lastPrice(ins, k, fetchImpl); } catch { px = null; }
    if (!px) return { status: 400, error: "Market order ke liye abhi ka daam nahi mila, isliye order roka. Limit order try kariye." };
  }
  const value = Math.round(px * order.quantity * 100) / 100;
  if (!closing && value > st.limits.max_value) return { status: 400, error: `Order ki rakam ₹${value.toLocaleString("en-IN")} hai, limit ₹${st.limits.max_value.toLocaleString("en-IN")} hai.` };

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
  if (r.ok && d.order_id) return { status: 200, ok: true, order_id: String(d.order_id), order, value };
  return { status: r.status === 401 ? 502 : 400, error: "Zerodha/relay: " + (d.error || `answered ${r.status}`), order, value };
}

// Light "last price" for the scalping page when live ticks are not available.
export async function quoteLtp(symbol, secrets, { fetchImpl = fetch } = {}) {
  const k = secrets.kite || {}, sym = String(symbol || "").trim();
  if (!kiteReady(k)) return { status: 400, error: "Aaj Zerodha login nahi hua." };
  const ins = isOptionSym(sym) ? "NFO:" + sym.replace(/\.NFO$/i, "").toUpperCase() : toKite(sym);
  if (!ins || !/^[A-Z]+:[A-Z0-9&\-_. ]{1,40}$/.test(ins)) return { status: 400, error: "bad symbol" };
  try { const last = await lastPrice(ins, k, fetchImpl); return last ? { status: 200, last } : { status: 404, error: "Daam nahi mila." }; }
  catch (e) { return { status: 502, error: e.message }; }
}

// One order's latest state, straight from Zerodha (reading needs no static IP).
const pick = (o) => ({ order_id: String(o.order_id), status: o.status, status_message: o.status_message || null, transaction_type: o.transaction_type,
  exchange: o.exchange, tradingsymbol: o.tradingsymbol, order_type: o.order_type, price: o.price, quantity: o.quantity,
  filled_quantity: o.filled_quantity, pending_quantity: o.pending_quantity, average_price: o.average_price });
export async function orderStatus(orderId, secrets, { fetchImpl = fetch } = {}) {
  const k = secrets.kite || {};
  if (!kiteReady(k)) return { status: 400, error: "Aaj Zerodha login nahi hua." };
  const id = String(orderId || "");
  if (!/^[0-9]{1,24}$/.test(id)) return { status: 400, error: "Order id theek nahi." };
  let r, d;
  try { r = await fetchImpl(`https://api.kite.trade/orders/${id}`, { headers: kh(k), signal: AbortSignal.timeout(4000) }); d = await r.json().catch(() => ({})); }
  catch { return { status: 502, error: "Zerodha se order ki jaankari nahi aayi." }; }
  const hist = Array.isArray(d.data) ? d.data : [];
  if (!r.ok || !hist.length) return { status: r.status === 404 ? 404 : 400, error: d.message || `Zerodha answered ${r.status}` };
  return { status: 200, order: pick(hist[hist.length - 1]) };
}

// Scalping page: cancel an open order, or change the price of an open SELL LIMIT order (SL chase / exit now).
// Only SELL orders can be re-priced from here, so a change can never make you buy more or pay more.
export async function changeOrder(body, secrets, { fetchImpl = fetch, now = Date.now() } = {}) {
  const st = tradingStatus(secrets);
  if (!st.relay) return { status: 400, error: "Order relay setup nahi hai." };
  if (!st.kite) return { status: 400, error: "Aaj Zerodha login nahi hua." };
  const op = body.op === "modify" ? "modify" : body.op === "cancel" ? "cancel" : null;
  if (!op) return { status: 400, error: "unknown op" };
  const cur = await orderStatus(body.order_id, secrets, { fetchImpl });
  if (!cur.order) return { status: cur.status, error: cur.error };
  const o = cur.order;
  if (!PENDING.test(o.status || "")) return { status: 409, error: `Order ab khula nahi hai (${o.status}).`, order: o };
  const msg = { ts: now, order_id: o.order_id, kite: { api_key: secrets.kite.api_key, access_token: secrets.kite.access_token } };
  if (op === "modify") {
    // only SELL orders: a LIMIT gets a new price; a Zerodha stop-loss (SL) either moves its trigger up (trailing, while it still
    // waits) or, once triggered, becomes a LIMIT at the new price (chase). Nothing here can make you buy more or pay more.
    if (o.transaction_type !== "SELL" || !["LIMIT", "SL"].includes(o.order_type)) return { status: 400, error: "Sirf SELL LIMIT / SL order badal sakte hain." };
    const tick = o.exchange === "NFO" ? 20 : 100, price = Math.round(Number(body.price) * tick) / tick;
    if (!(price > 0)) return { status: 400, error: "Naya daam theek nahi." };
    msg.price = price;
    if (o.order_type === "SL") {
      const waiting = /TRIGGER PENDING/i.test(o.status || "");
      if (body.trigger_price != null) {
        const trig = Math.round(Number(body.trigger_price) * tick) / tick;
        if (!waiting) return { status: 409, error: "SL trigger ho chuka hai: ab sirf daam badal sakte hain.", order: o };
        if (!(trig > 0 && price <= trig)) return { status: 400, error: "SL trigger / daam theek nahi (bechne ka daam trigger se upar nahi ho sakta)." };
        msg.trigger_price = trig;
      } else if (waiting) return { status: 400, error: "SL abhi trigger nahi hua: iska trigger badaliye, sirf daam nahi.", order: o };
    }
  }
  const payload = JSON.stringify(msg);
  let r, d;
  try {
    r = await fetchImpl(secrets.order_relay.url.replace(/\/+$/, "") + "/" + op, {
      method: "POST", body: payload, signal: AbortSignal.timeout(9000),
      headers: { "content-type": "application/json", "x-relay-signature": sign(secrets.order_relay.secret, payload) } });
    d = await r.json().catch(() => ({}));
  } catch { return { status: 502, error: "Relay se jawab nahi aaya. Kite app mein order check kariye.", order: o }; }
  if (r.status === 404 && d.error === "not found") return { status: 400, error: "Relay purana hai: Cloud Shell mein relay update kariye (git pull && bash relay/setup.sh).", order: o };
  if (r.ok && d.ok) return { status: 200, ok: true, order_id: o.order_id, op, price: msg.price ?? null, trigger_price: msg.trigger_price ?? null, order: o };
  return { status: r.status === 401 ? 502 : 400, error: "Zerodha/relay: " + (d.error || `answered ${r.status}`), order: o };
}
