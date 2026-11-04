// Buy/Sell window. Only for the logged-in admin. Real orders: always a review + confirm step first.
// The order is sent ONLY by send() -> POST /api/admin/order, and success is shown ONLY when the server says ok.
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
  const el = document.createElement("div"); el.className = "kbtns trade"; box.appendChild(el);
  if (!/\.(NS|BO|NFO)$/i.test(p.symbol)) { el.remove(); return; }    // only Indian stocks / index options via Zerodha
  if (p.index) { el.innerHTML = `<div class="note" style="grid-column:1/-1;margin:0">Ye ek <b>index</b> hai. Index ko seedha khareeda/becha nahi ja sakta, sirf uska daam dekh sakte hain.</div>`; return; }
  const st = await tradingState();
  const why = (html) => { el.innerHTML = `<div class="note" style="grid-column:1/-1;margin:0">${html}</div>`; };
  if (!st.loggedIn) return why(`Buy/Sell ke liye <a href="#/keys">API Keys</a> mein login kariye.`);
  const t = st.trading || {};
  if (!t.relay) return why(`Buy/Sell: pehle <a href="#/keys">Order relay (Firebase)</a> setup kariye.`);
  if (!t.kite) return why(`Buy/Sell: aaj <a href="#/keys">Login with Zerodha</a> nahi hua.`);
  if (p.option && !t.fno) return why(`Options trading band hai. Chalu karne ke liye <a href="#/keys">API Keys → Order relay</a> mein "Options trading" ko <b>yes</b> likh kar Save kariye.`);
  el.innerHTML = `<button class="btn btn-buy" data-s="BUY">Buy</button><button class="btn btn-sell" data-s="SELL">Sell</button>`;
  el.querySelectorAll("button").forEach((b) => (b.onclick = () => openTrade(p, b.dataset.s, t.limits)));
}

const ICON_OK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_BAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>`;

function openTrade(p, side, limits) {
  const ov = document.createElement("div"); ov.className = "modal-bg";
  ov.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-label="Order"></div>`;
  document.body.appendChild(ov);
  const m = ov.querySelector(".modal");
  let sending = false;
  const close = () => { if (sending) return; ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  const opt = p.option || null;                        // index option -> trade in lots
  const s = { side, qty: 1, lots: 1, order_type: "LIMIT", price: p.last, product: opt ? "NRML" : "CNC" };
  const sideCol = () => (s.side === "BUY" ? "var(--pos)" : "var(--neg)");
  const exch = opt ? "NFO" : /\.BO$/i.test(p.symbol) ? "BSE" : "NSE";
  const shown = opt ? opt.name : p.symbol.replace(/\.(NS|BO)$/i, "");
  const head = (title) => `<div class="ticket-h" style="--side:${sideCol()}"><div><div class="ttl">${title}</div>
      <div class="ltp">${esc(p.symbol)} · ${exch} · LTP ${inr(p.last)}</div></div><button class="icon-btn x" data-x aria-label="Close">${ICON_BAD}</button></div>`;
  const calc = () => {
    const px = s.order_type === "MARKET" ? p.last : Number(s.price) || 0;
    if (opt) {
      const lots = Number(s.lots) || 0, qty = lots * opt.lot_size, val = px * qty;
      const over = lots > limits.max_lots || val > limits.max_value;
      const invalid = over || !(Number.isInteger(lots) && lots >= 1) || (s.order_type === "LIMIT" && !(Number(s.price) > 0));
      return { px, val, over, invalid, qty, lots };
    }
    const val = px * (Number(s.qty) || 0);
    const over = (Number(s.qty) || 0) > limits.max_qty || val > limits.max_value;
    const invalid = over || !(Number(s.qty) >= 1) || (s.order_type === "LIMIT" && !(Number(s.price) > 0));
    return { px, val, over, invalid };
  };
  const limText = () => opt ? `Limit: ${limits.max_lots} lot · ${inr(limits.max_value)} · 1 lot = ${opt.lot_size} qty` : `Limit: ${limits.max_qty} shares · ${inr(limits.max_value)}`;

  const form = () => {
    const c = calc();
    m.innerHTML = `${head(`${s.side === "BUY" ? "Buy" : "Sell"} ${esc(shown)}`)}
      <div class="ticket-b">
        <div class="side-toggle">${["BUY", "SELL"].map((x) => `<button type="button" data-side="${x}" class="${s.side === x ? "on" : ""}">${x === "BUY" ? "Buy" : "Sell"}</button>`).join("")}</div>
        <div class="tf">
          ${opt
            ? `<label>Lots <span data-lq style="text-transform:none;letter-spacing:0;color:var(--text-2)">= ${c.qty} qty</span><input class="field" type="number" inputmode="numeric" min="1" step="1" max="${limits.max_lots}" data-k="lots" value="${esc(s.lots)}"></label>`
            : `<label>Quantity<input class="field" type="number" inputmode="numeric" min="1" step="1" max="${limits.max_qty}" data-k="qty" value="${esc(s.qty)}"></label>`}
          <label>Price (₹)<input class="field" type="number" inputmode="decimal" step="0.05" min="0" data-k="price" value="${esc(s.price)}" ${s.order_type === "MARKET" ? "disabled" : ""}></label>
          <label class="full">Order type<div class="seg">${[["LIMIT", "Limit"], ["MARKET", "Market"]].map(([v, l]) => `<button type="button" data-ot="${v}" class="${s.order_type === v ? "on" : ""}">${l}</button>`).join("")}</div></label>
          <label class="full">Product<div class="seg">${(opt ? [["NRML", "Carry forward (NRML)"], ["MIS", "Intraday (MIS)"]] : [["CNC", "Delivery (CNC)"], ["MIS", "Intraday (MIS)"]]).map(([v, l]) => `<button type="button" data-pr="${v}" class="${s.product === v ? "on" : ""}">${l}</button>`).join("")}</div></label>
        </div>
        <div class="sumrow"><span>${opt ? "Premium (approx.)" : "Approx. value"}<br><span data-lim>${limText()}</span></span><b data-val>${inr(c.val)}</b></div>
        ${opt && s.side === "SELL" ? `<div class="kres bad">Sirf utna option bech sakte hain jitna aapke paas pehle se hai. Naya option likhna (writing) band hai.</div>` : ""}
        <div data-over>${c.over ? `<div class="kres bad">Ye order aapki limit se bada hai. Limit API Keys → Order relay mein badal sakte hain.</div>` : ""}</div>
      </div>
      <div class="ticket-f"><button class="btn2" data-x style="flex:0 0 auto">Cancel</button>
        <button class="btn" data-review style="background:${sideCol()}" ${c.invalid ? "disabled" : ""}>Review ${s.side === "BUY" ? "buy" : "sell"}</button></div>`;
    m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = close));
    m.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { s.side = b.dataset.side; form(); }));
    m.querySelectorAll("[data-ot]").forEach((b) => (b.onclick = () => { s.order_type = b.dataset.ot; form(); }));
    m.querySelectorAll("[data-pr]").forEach((b) => (b.onclick = () => { s.product = b.dataset.pr; form(); }));
    // typing updates the summary live without re-drawing (keeps the cursor in the box)
    m.querySelectorAll("[data-k]").forEach((i) => (i.oninput = () => {
      s[i.dataset.k] = i.value; const c2 = calc();
      m.querySelector("[data-val]").textContent = inr(c2.val);
      if (opt) m.querySelector("[data-lq]").textContent = `= ${c2.qty || 0} qty`;
      m.querySelector("[data-over]").innerHTML = c2.over ? `<div class="kres bad">Ye order aapki limit se bada hai. Limit API Keys → Order relay mein badal sakte hain.</div>` : "";
      m.querySelector("[data-review]").disabled = c2.invalid;
      i.style.borderColor = ((i.dataset.k === "qty" || i.dataset.k === "lots") && !(Number(i.value) >= 1)) || (i.dataset.k === "price" && !(Number(i.value) > 0)) ? "var(--neg)" : "";
    }));
    m.querySelector("[data-review]").onclick = review;
  };

  const review = () => {
    const { px, val, qty, lots } = calc();
    m.innerHTML = `${head("Order pakka kariye")}
      <div class="ticket-b">
        <div class="kv">
          <span>Side</span><b style="color:${sideCol()}">${s.side}</b>
          ${opt ? `<span>Contract</span><b>${esc(opt.name)} (NFO)</b>
          <span>Expiry</span><b>${esc(opt.expiry)}</b>
          <span>Lots</span><b>${lots} lot = ${qty} qty</b>` : `<span>Stock</span><b>${esc(p.symbol)} (${exch})</b>
          <span>Quantity</span><b>${Number(s.qty)}</b>`}
          <span>Order type</span><b>${s.order_type === "MARKET" ? "Market (abhi ke daam par)" : "Limit"}</b>
          <span>Price</span><b>${s.order_type === "MARKET" ? "≈ " + inr(px) : inr(px)}</b>
          <span>Product</span><b>${{ CNC: "Delivery (CNC)", MIS: "Intraday (MIS)", NRML: "Carry forward (NRML)" }[s.product]}</b>
          <span>${opt ? "Premium (approx.)" : "Approx. value"}</span><b>${inr(val)}</b>
        </div>
        <div class="kres bad" style="margin-top:16px">⚠ Ye <b>asli order</b> hai. "Confirm" dabate hi Zerodha ko chala jaayega.${opt ? " Options mein poora premium doob sakta hai." : ""}</div>
      </div>
      <div class="ticket-f"><button class="btn2" data-back style="flex:0 0 auto">Wapas</button>
        <button class="btn" style="background:${sideCol()}" data-go>Confirm ${s.side === "BUY" ? "buy" : "sell"} · ${opt ? `${lots} lot` : `${Number(s.qty)} ×`} ${esc(opt ? opt.strike + " " + opt.type : shown)}</button></div>`;
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-back]").onclick = form;
    m.querySelector("[data-go]").onclick = send;
  };

  const send = async () => {
    const b = m.querySelector("[data-go]"); b.disabled = true; b.textContent = "Bhej rahe hain…";
    m.querySelector("[data-back]").disabled = true; sending = true;
    let d = {}, okk = false;
    try {
      const r = await fetch("/api/admin/order", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(opt
          ? { symbol: p.symbol, side: s.side, lots: Number(s.lots), order_type: s.order_type, price: Number(s.price), product: s.product, confirm: true }
          : { symbol: p.symbol, side: s.side, qty: Number(s.qty), order_type: s.order_type, price: Number(s.price), product: s.product, confirm: true }) });
      d = await r.json().catch(() => ({})); okk = r.ok && d.ok;
    } catch { d = { error: "Website se jawab nahi aaya. Order gaya ya nahi, Kite app ke Orders mein check kariye." }; }
    sending = false;
    m.innerHTML = okk
      ? `${head("Order bhej diya")}<div class="ticket-b result"><div class="ic" style="background:var(--pos-soft);color:var(--pos)">${ICON_OK}</div>
           <h3>Order Zerodha ko chala gaya</h3><p class="kp" style="margin:6px auto 0">Order ID <code>${esc(d.order_id)}</code><br>Order poora hua ya reject, ye Zerodha mein dekhiye.</p></div>
         <div class="ticket-f"><button class="btn2" data-x style="flex:0 0 auto">Band karein</button><a class="btn" href="https://kite.zerodha.com/orders" target="_blank" rel="noopener">Kite mein Orders dekhein ↗</a></div>`
      : `${head("Order nahi gaya")}<div class="ticket-b result"><div class="ic" style="background:var(--neg-soft);color:var(--neg)">${ICON_BAD}</div>
           <h3>Order nahi gaya</h3><div class="kres bad" style="text-align:left">${esc(d.error || "Pata nahi kya hua.")}</div></div>
         <div class="ticket-f"><button class="btn2" data-x style="flex:0 0 auto">Band karein</button><button class="btn2" data-back style="flex:1">Wapas</button></div>`;
    m.querySelectorAll("[data-x]").forEach((x) => (x.onclick = close));
    m.querySelector("[data-back]")?.addEventListener("click", form);
  };
  form();
}
