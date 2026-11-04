// Buy/Sell window. Only for the logged-in admin. Real orders: always a review + confirm step first.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inr = (v) => "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let stCache = null, stAt = 0;

export async function tradingState(force = false) {
  if (!force && stCache && Date.now() - stAt < 60000) return stCache;
  try { stCache = await (await fetch("/api/admin/status")).json(); } catch { stCache = {}; }
  stAt = Date.now(); return stCache;
}

// Adds Buy/Sell buttons (or a note why not) under a price box. p = /api/price result.
export async function mountTrade(box, p) {
  const el = document.createElement("div"); el.className = "kbtns"; box.appendChild(el);
  if (!/\.(NS|BO)$/i.test(p.symbol)) return;               // only Indian stocks can be traded via Zerodha
  const st = await tradingState();
  if (!st.loggedIn) { el.innerHTML = `<span class="note" style="margin:0">Buy/Sell ke liye <a href="#/keys">🔑 Manage API Keys</a> mein login kariye.</span>`; return; }
  const t = st.trading || {};
  if (!t.relay) { el.innerHTML = `<span class="note" style="margin:0">Buy/Sell: pehle <a href="#/keys">Order relay (Firebase)</a> setup kariye.</span>`; return; }
  if (!t.kite) { el.innerHTML = `<span class="note" style="margin:0">Buy/Sell: aaj <a href="#/keys">Login with Zerodha</a> nahi hua.</span>`; return; }
  el.innerHTML = `<button class="btn" style="background:var(--pos)" data-s="BUY">Buy</button><button class="btn" style="background:var(--neg)" data-s="SELL">Sell</button>`;
  el.querySelectorAll("button").forEach((b) => (b.onclick = () => openTrade(p, b.dataset.s, t.limits)));
}

function openTrade(p, side, limits) {
  const ov = document.createElement("div"); ov.className = "modal-bg";
  ov.innerHTML = `<div class="card modal" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(ov);
  const m = ov.querySelector(".modal"), close = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  const s = { side, qty: 1, order_type: "LIMIT", price: p.last, product: "CNC" };

  const form = () => {
    const px = s.order_type === "MARKET" ? p.last : Number(s.price) || 0, val = px * (Number(s.qty) || 0);
    const over = (Number(s.qty) || 0) > limits.max_qty || val > limits.max_value;
    m.innerHTML = `
      <div class="khead" style="justify-content:space-between"><h3>${esc(p.symbol)} · abhi ${inr(p.last)}</h3><button class="btn2" data-x>✕</button></div>
      <div class="seg" style="margin:8px 0 12px">${["BUY", "SELL"].map((x) => `<button type="button" data-side="${x}" class="${s.side === x ? "on" : ""}">${x === "BUY" ? "Buy" : "Sell"}</button>`).join("")}</div>
      <div class="kfields">
        <label>Quantity (shares)<input type="number" min="1" step="1" max="${limits.max_qty}" data-k="qty" value="${esc(s.qty)}"></label>
        <label>Order type<select data-k="order_type"><option value="LIMIT"${s.order_type === "LIMIT" ? " selected" : ""}>Limit (aapka daam)</option><option value="MARKET"${s.order_type === "MARKET" ? " selected" : ""}>Market (abhi ke daam par)</option></select></label>
        <label>Price (₹)<input type="number" step="0.05" min="0" data-k="price" value="${esc(s.price)}" ${s.order_type === "MARKET" ? "disabled" : ""}></label>
        <label>Product<select data-k="product"><option value="CNC"${s.product === "CNC" ? " selected" : ""}>Delivery (CNC)</option><option value="MIS"${s.product === "MIS" ? " selected" : ""}>Intraday (MIS)</option></select></label>
      </div>
      <p class="kp" style="margin-top:12px">Andaazan rakam: <b>${inr(val)}</b> · Limits: max ${limits.max_qty} shares, max ${inr(limits.max_value)}</p>
      ${over ? `<div class="kres bad">Ye order aapki limit se bada hai. Limit Manage API Keys → Order relay mein badal sakte hain.</div>` : ""}
      <div class="kbtns"><button class="btn" data-review ${over || !(Number(s.qty) >= 1) || (s.order_type === "LIMIT" && !(Number(s.price) > 0)) ? "disabled" : ""}>Review order</button><button class="btn2" data-x>Cancel</button></div>`;
    m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = close));
    m.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { s.side = b.dataset.side; form(); }));
    m.querySelectorAll("[data-k]").forEach((i) => (i.onchange = () => { s[i.dataset.k] = i.value; form(); }));
    m.querySelector("[data-review]").onclick = review;
  };

  const review = () => {
    const px = s.order_type === "MARKET" ? p.last : Number(s.price), val = px * Number(s.qty);
    const color = s.side === "BUY" ? "var(--pos)" : "var(--neg)";
    m.innerHTML = `<h3 style="margin:0 0 10px">Order pakka kariye</h3>
      <div class="card" style="border-color:${color}"><div style="font-size:20px;font-weight:700;color:${color}">${s.side} ${Number(s.qty)} × ${esc(p.symbol)}</div>
        <div class="kp">${s.order_type === "MARKET" ? "Market (abhi ke daam par)" : "Limit @ " + inr(px)} · ${s.product === "CNC" ? "Delivery" : "Intraday"} · andaazan ${inr(val)}</div></div>
      <div class="kres bad">⚠ Ye <b>asli order</b> hai. Haan dabate hi Zerodha ko chala jaayega.</div>
      <div class="kbtns"><button class="btn" style="background:${color}" data-go>Haan, order bhejo</button><button class="btn2" data-back>Wapas</button></div>`;
    m.querySelector("[data-back]").onclick = form;
    m.querySelector("[data-go]").onclick = send;
  };

  const send = async () => {
    const b = m.querySelector("[data-go]"); b.disabled = true; b.textContent = "Bhej rahe hain…";
    let d = {}, okk = false;
    try {
      const r = await fetch("/api/admin/order", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: p.symbol, side: s.side, qty: Number(s.qty), order_type: s.order_type, price: Number(s.price), product: s.product, confirm: true }) });
      d = await r.json().catch(() => ({})); okk = r.ok && d.ok;
    } catch { d = { error: "Website se jawab nahi aaya. Order gaya ya nahi, Kite app ke Orders mein check kariye." }; }
    m.innerHTML = okk
      ? `<h3>✓ Order Zerodha ko chala gaya</h3><p class="kp">Order ID: <code>${esc(d.order_id)}</code>. Order poora hua ya nahi (executed/rejected), ye Zerodha mein dekhiye.</p>
         <div class="kbtns"><a class="btn" href="https://kite.zerodha.com/orders" target="_blank" rel="noopener">Kite mein Orders dekhein ↗</a><button class="btn2" data-x>Band karein</button></div>`
      : `<h3>✗ Order nahi gaya</h3><div class="kres bad">${esc(d.error || "Pata nahi kya hua.")}</div>
         <div class="kbtns"><button class="btn2" data-back>Wapas</button><button class="btn2" data-x>Band karein</button></div>`;
    m.querySelectorAll("[data-x]").forEach((x) => (x.onclick = close));
    m.querySelector("[data-back]")?.addEventListener("click", form);
  };
  form();
}
