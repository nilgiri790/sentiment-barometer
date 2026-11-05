// Scalping terminal: option search -> live chart (Zerodha ticks) + market depth + BUY with automatic target / stop-loss.
// Loaded only when the page is opened. The bracket logic is ./scalpengine.mjs and runs IN THIS BROWSER TAB:
// orders go through /api/admin/order (+ order-change for cancel / price change), order status comes from
// Zerodha's WebSocket order updates and /api/admin/order-status polling. Page closed = no stop-loss management.
import { createChart, CrosshairMode, LineStyle } from "./vendor/lightweight-charts-4.2.3.mjs";
import { parseTicks, applyTick, barsFromTicks, IST, orderUpdate } from "./kiteticks.mjs";
import { Bracket, checkPlan, tickFloor, LIVE } from "./scalpengine.mjs";
import { mountTrade, tradingState } from "./trade.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const inr = (v) => (v == null || !Number.isFinite(v) ? "–" : "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 0 }));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const hhmmss = (ms) => new Date(ms + IST * 1000).toISOString().slice(11, 19);
const r2 = (p) => Math.round(p * 100) / 100;
const TICK = 0.05;
const TFS = [{ k: "1s", sec: 1, live: true }, { k: "5s", sec: 5, live: true }, { k: "15s", sec: 15, live: true }, { k: "1m", sec: 60, api: "minute" }, { k: "5m", sec: 300, api: "5minute" }];
const WSBASE = (location.hostname === "localhost" && new URLSearchParams(location.search).get("wsurl")) || "wss://ws.kite.trade";   // test hook
const KEY = "sb-scalp";
const STATE_TXT = { idle: "Taiyaar", entry_open: "Entry order khula hai", active: "Position chalu · target laga hai", sl_armed: "SL chalu: target cancel ho raha hai",
  sl_open: "Stop-loss order laga hai", done: "Poora hua", error: "Dhyan dijiye", stopped: "Managing band" };

let H, root, chart = null, main = null, vol = null, plines = [];
let target = null, tf = TFS[3], bars = [], ticks = [], ltp = null, bid = null, ask = null, depth = null, prevClose = null, lastCum = null;
let ws = null, wsLive = false, retry = 0, subTok = null, ltpTimer = null, candleTimer = null, pollTimer = null, polling = false, pollN = 0;
let engine = null, ctx = null, limits = null, trading = null, confirming = false;
// form: offsets are kept when the entry price changes (user's example: +10 target, -7 trigger, -6 SL limit)
const F = { lots: 1, entry: null, target: null, trig: null, sl: null, chase: 30, product: "MIS", oneClick: false, off: { target: 10, trig: 7, sl: 6 }, entryTouched: false };
try { const s = JSON.parse(localStorage.getItem(KEY + "-form") || "null"); if (s) { Object.assign(F.off, s.off || {}); F.chase = s.chase || 30; F.product = s.product === "NRML" ? "NRML" : "MIS"; } } catch {}

export function mountScalp(el, helpers) {
  H = helpers; root = el;
  if (!document.getElementById("sp-css")) document.head.insertAdjacentHTML("beforeend", `<style id="sp-css">${CSS}</style>`);
  root.innerHTML = `
    <div class="page-head"><div><h1>Scalping</h1><p class="sub">Option ka live chart, market depth, aur ek click mein BUY + target + stop-loss.</p></div></div>
    <section class="panel"><div class="panel-b">
      <div class="btbar">
        <form class="search" id="sform4"><div class="in"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q4" placeholder="Option search: banknifty 52000 ce, nifty 24500 pe" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="ac4" aria-expanded="false"><div class="ac" id="ac4" role="listbox" hidden></div></div><button>Open</button></form>
        <div class="seg" id="sptf">${TFS.map((t) => `<button type="button" data-k="${t.k}" class="${t.k === tf.k ? "on" : ""}">${t.k}</button>`).join("")}</div>
        <span class="sp-status"><span class="dot" id="spdot"></span><span id="spstat">Option chuniye</span></span>
      </div>
      <div class="note" id="splock" hidden></div>
    </div></section>
    <div class="sp-grid">
      <div class="sp-left">
        <section class="panel">
          <div class="panel-h"><h2 id="spname">Koi option nahi chuna</h2><span class="right"><span class="ltp tnum" id="spltp"></span><span class="chg tnum" id="spchg"></span></span></div>
          <div class="sp-ba tnum" id="spba"></div>
          <div id="spchart"><div class="empty sp-empty">Upar option search kariye (jaise <b>banknifty 52000 ce</b>). Chart, depth aur order panel yahan khulenge.</div></div>
        </section>
        <section class="panel" id="spdepthp" hidden><div class="panel-h"><h2>Market depth</h2><span class="right label" id="spdq"></span></div><div class="panel-b" id="spdepth"></div></section>
      </div>
      <div class="sp-right">
        <section class="panel" id="spbr" hidden></section>
        <section class="panel" id="sporder"><div class="panel-h"><h2>Smart order</h2></div><div class="panel-b"><div class="note">Pehle option chuniye.</div></div></section>
        <section class="panel" id="spplain" hidden><div class="panel-h"><h2>Simple order</h2><span class="right label">bina target/SL</span></div><div class="panel-b" id="spplainb"></div></section>
      </div>
    </div>
    <footer>Scalping mein nuksan jaldi ho sakta hai. Stop-loss is page se chalta hai: page band = SL band. Ye investment advice nahi hai.</footer>`;
  const qIn = root.querySelector("#q4");
  const ac = H.makeAC(qIn, root.querySelector("#ac4"), { filter: (o) => o.option, onChoose: (o) => { qIn.value = o.name; choose(o); } });
  root.querySelector("#sform4").onsubmit = async (e) => {
    e.preventDefault(); if (ac.openWithSel()) return ac.pickSel();
    const q = qIn.value.trim(); if (!q) return; ac.cancel();
    const list = (await H.suggest(q)).filter((o) => o.option);
    if (list.length) { qIn.value = list[0].name; choose(list[0]); } else H.toast(`"${q}" jaisa koi option nahi mila. Jaise: banknifty 52000 ce`);
  };
  root.querySelector("#sptf").onclick = (e) => { const b = e.target.closest("button"); if (!b || b.dataset.k === tf.k) return; tf = TFS.find((t) => t.k === b.dataset.k);
    root.querySelectorAll("#sptf button").forEach((x) => x.classList.toggle("on", x === b)); if (target) loadBars(); };
  window.addEventListener("beforeunload", (e) => { if (engine?.live) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("hashchange", () => { if (engine?.live && !location.hash.startsWith("#/scalp")) H.toast("Scalping bracket chal raha hai. Is tab ko band mat kariye, SL isi se chalta hai."); });
  resume();
}
export function onShowScalp() { if (target) { orderPanel(); renderBracket(); } }

// ---------- choose a contract ----------
async function choose(o, keepEngine = false) {
  if (engine?.live && !keepEngine) { H.toast("Ek bracket abhi chal raha hai. Pehle use poora hone dijiye ya 'Managing band' kariye."); return; }
  target = { symbol: o.symbol, name: o.name || o.symbol, lot: +o.lot_size || +o.lot || null, token: o.token || null };
  ltp = null; bid = ask = null; depth = null; prevClose = null; ticks = []; lastCum = null; F.entry = null; F.entryTouched = false; confirming = false;
  if (!keepEngine) { engine = null; ctx = null; save(); }
  root.querySelector("#spname").textContent = target.name;
  root.querySelector("#spdepthp").hidden = true;
  [trading] = await Promise.all([tradingState(true), loadMeta()]);
  limits = trading?.trading?.limits || null;
  await loadBars();
  orderPanel(); renderBracket(); plain();
  connect();
}
let metaP = null;
async function loadMeta() {                                 // lot size + price snapshot from Zerodha (also used by the simple Buy/Sell)
  try { const r = await fetch(`/api/price?sym=${encodeURIComponent(target.symbol)}&range=1d`, { cache: "no-store" }); const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    metaP = d; target.lot = +d.option?.lot_size || target.lot; prevClose = d.prevClose ?? prevClose; if (ltp == null && d.last) ltp = d.last;
  } catch (e) { metaP = null; H.toast("Option ki jaankari nahi aayi: " + e.message); }
}
function plain() {
  const box = root.querySelector("#spplainb"); box.innerHTML = ""; root.querySelector("#spplain").hidden = !metaP;
  if (metaP) mountTrade(box, { ...metaP, last: ltp ?? metaP.last });
}

// ---------- chart ----------
function ensureChart() {
  if (chart) return;
  const el = root.querySelector("#spchart"); el.innerHTML = "";
  chart = createChart(el, { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
    grid: { vertLines: { color: "rgba(125,135,153,.08)" }, horzLines: { color: "rgba(125,135,153,.08)" } }, crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: true, rightOffset: 6 },
    localization: { priceFormatter: (p) => f2(p) } });
  const up = css("--pos"), dn = css("--neg");
  main = chart.addCandlestickSeries({ upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn, priceFormat: { type: "price", precision: 2, minMove: TICK } });
  main.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
  vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
}
const pt = ({ time, open, high, low, close }) => ({ time, open, high, low, close });
const vpt = (b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? css("--pos-soft") : css("--neg-soft") });
async function loadBars() {
  ensureChart(); clearInterval(candleTimer);
  chart.applyOptions({ timeScale: { secondsVisible: tf.sec < 60 } });
  if (tf.live) { bars = barsFromTicks(ticks, tf.sec); }
  else {
    try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(target.symbol)}&interval=${tf.api}`, { cache: "no-store" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      target.token ??= d.instrument_token; prevClose = d.prevClose ?? prevClose;
      bars = d.candles.map(([t, o, h, l, c, v]) => ({ time: t + IST, open: o, high: h, low: l, close: c, volume: v || 0 }));
      if (ltp == null && bars.length) ltp = bars[bars.length - 1].close;
    } catch (e) { bars = []; H.toast("Chart data nahi aaya: " + e.message); }
    if (!H.isAdmin()) candleTimer = setInterval(() => { if (!document.hidden && target) loadBars(); }, 20000);    // no live ticks: refresh
  }
  main.setData(bars.map(pt)); vol.setData(bars.map(vpt)); chart.timeScale().fitContent();
  header(); drawLines();
}
function header() {
  root.querySelector("#spltp").textContent = f2(ltp);
  const c = root.querySelector("#spchg");
  if (prevClose && ltp != null) { const d = ltp - prevClose; c.className = "chg tnum " + (d >= 0 ? "up" : "down"); c.textContent = `${d >= 0 ? "+" : ""}${f2(d)} (${((d / prevClose) * 100).toFixed(2)}%)`; }
  else c.textContent = "";
  root.querySelector("#spba").innerHTML = bid || ask ? `<span>Bid <b class="up">${f2(bid)}</b></span><span>Ask <b class="down">${f2(ask)}</b></span><span>Spread <b>${bid && ask ? f2(ask - bid) : "–"}</b></span>${target?.lot ? `<span>Lot <b>${target.lot}</b></span>` : ""}`
    : target?.lot ? `<span>Lot <b>${target.lot}</b></span><span class="note" style="margin:0">Bid/Ask live ticks se aata hai</span>` : "";
}
function drawLines() {
  if (!main) return;
  plines.forEach((l) => main.removePriceLine(l)); plines = [];
  const add = (price, color, title, style = LineStyle.Dashed) => { if (price > 0) plines.push(main.createPriceLine({ price: +price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })); };
  if (engine && (engine.live || engine.state === "done")) {
    add(engine.avg ?? engine.p.entry, css("--accent"), engine.filled ? "Avg" : "Entry", LineStyle.Solid);
    if (engine.p.target != null) add(engine.p.target, css("--pos"), "Target");
    if (engine.p.slTrigger != null) add(engine.p.slTrigger, css("--warn"), "SL trig");
    if (engine.o.sl) add(engine.o.sl.price, css("--neg"), engine.o.sl.exit ? "Exit" : "SL order", LineStyle.Solid);
    else if (engine.p.slLimit != null) add(engine.p.slLimit, css("--neg"), "SL");
  } else if (target && F.entry > 0) {
    add(F.entry, css("--accent"), "Entry"); add(F.target, css("--pos"), "Target"); add(F.trig, css("--warn"), "SL trig"); add(F.sl, css("--neg"), "SL");
  }
}

// ---------- live data ----------
function setStatus(kind, text) { root.querySelector("#spdot").className = "dot " + kind; root.querySelector("#spstat").textContent = text; }
async function connect() {
  if (!target) return;
  if (ws && ws.readyState <= 1) { subscribe(); return; }
  if (!H.isAdmin()) { setStatus("", "Delayed · login ke bina live nahi"); return; }
  let auth;
  try { auth = await H.adminGet("ticker"); }
  catch (e) { wsLive = false; setStatus("warn", "Live ticks nahi: " + e.message.slice(0, 60)); startLtpPoll(); return; }
  ws = new WebSocket(`${WSBASE}?api_key=${encodeURIComponent(auth.api_key)}&access_token=${encodeURIComponent(auth.access_token)}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { retry = 0; wsLive = true; subTok = null; subscribe(); stopLtpPoll(); setStatus("live", "Live · Zerodha ticks"); };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const u = orderUpdate(e.data);
      if (u) { engine?.onOrder(u); return; }
      try { const m = JSON.parse(e.data); if (m.type === "error") setStatus("warn", "Zerodha: " + m.data); } catch {}
      return;
    }
    for (const t of parseTicks(e.data)) onTick(t);
  };
  ws.onclose = () => { const was = wsLive; wsLive = false; ws = null; setStatus("warn", "Reconnecting…"); startLtpPoll();
    setTimeout(connect, was ? 1000 : Math.min(30000, 2000 * 2 ** retry++)); };
}
function subscribe() {
  if (!ws || ws.readyState !== 1 || !target?.token) return;
  if (subTok === target.token) return;
  if (subTok) ws.send(JSON.stringify({ a: "unsubscribe", v: [subTok] }));
  subTok = target.token;
  ws.send(JSON.stringify({ a: "subscribe", v: [subTok] })); ws.send(JSON.stringify({ a: "mode", v: ["full", [subTok]] }));
}
function startLtpPoll() {                                   // fallback: light last-price poll every 3 s (admin)
  if (ltpTimer || !H.isAdmin()) return;
  ltpTimer = setInterval(async () => {
    if (!target || wsLive) return;
    try { const d = await H.adminGet(`ltp?sym=${encodeURIComponent(target.symbol)}`); if (d.last) onTick({ token: target.token, ltp: d.last }, true); } catch {}
  }, 3000);
}
function stopLtpPoll() { clearInterval(ltpTimer); ltpTimer = null; }
function onTick(t, polled = false) {
  if (!target || (t.token !== target.token && !polled)) return;
  const ms = Date.now(), dv = t.volume != null && lastCum != null ? Math.max(0, t.volume - lastCum) : 0;
  if (t.volume != null) lastCum = t.volume;
  ltp = t.ltp; if (t.bid !== undefined) { bid = t.bid; ask = t.ask; depth = t.depth; }
  if (!prevClose && t.close) prevClose = t.close;
  ticks.push({ ms, price: ltp, dv }); if (ticks.length > 100000) ticks.splice(0, 20000);
  if (main) { const before = bars.length, bar = applyTick(bars, ms, ltp, dv, tf.sec);
    if (bar) { if (!before) { main.setData(bars.map(pt)); vol.setData(bars.map(vpt)); } else { main.update(pt(bar)); vol.update(vpt(bar)); } } }
  header(); drawDepth(); liveCalc(); pnlTick();
  engine?.onTick(ltp);
}
function drawDepth() {
  const p = root.querySelector("#spdepthp");
  if (!depth) { p.hidden = true; return; }
  p.hidden = false;
  const max = Math.max(1, ...depth.buy.map((x) => x.qty), ...depth.sell.map((x) => x.qty));
  const row = (b, s) => `<tr><td class="o">${b.orders || ""}</td><td class="q"><i class="bb" style="width:${(b.qty / max) * 100}%"></i>${b.qty || ""}</td><td class="p up">${b.price ? f2(b.price) : ""}</td>
    <td class="p down">${s.price ? f2(s.price) : ""}</td><td class="q"><i class="sb" style="width:${(s.qty / max) * 100}%"></i>${s.qty || ""}</td><td class="o">${s.orders || ""}</td></tr>`;
  root.querySelector("#spdepth").innerHTML = `<table class="sp-dt tnum"><thead><tr><th>Orders</th><th>Qty</th><th>Bid</th><th>Ask</th><th>Qty</th><th>Orders</th></tr></thead><tbody>${depth.buy.map((b, i) => row(b, depth.sell[i])).join("")}</tbody></table>`;
  const tb = depth.buy.reduce((a, x) => a + x.qty, 0), ts = depth.sell.reduce((a, x) => a + x.qty, 0);
  root.querySelector("#spdq").textContent = `Buy ${tb.toLocaleString("en-IN")} · Sell ${ts.toLocaleString("en-IN")}`;
}

// ---------- order form ----------
const snap = (v) => (v > 0 ? r2(Math.round(v / TICK) * TICK) : null);
function fromEntry() {                                      // keep the point offsets when the entry moves
  if (!(F.entry > 0)) return;
  F.target = snap(F.entry + F.off.target); F.trig = snap(F.entry - F.off.trig); F.sl = snap(F.entry - F.off.sl);
}
function plan() {
  return { qty: (F.lots || 0) * (target?.lot || 0), entry: F.entry, target: F.target ?? "", slTrigger: F.trig ?? "", slLimit: F.sl ?? "", chaseSec: F.chase, tick: TICK };
}
function why() {
  if (!H.isAdmin()) return `Order ke liye <a href="#/keys">API Keys</a> mein login kariye.`;
  const t = trading?.trading || {};
  if (!t.relay) return `Pehle <a href="#/keys">Order relay</a> setup kariye.`;
  if (!t.kite) return `Aaj <a href="#/keys">Login with Zerodha</a> nahi hua.`;
  if (!t.fno) return `Options trading band hai: <a href="#/keys">API Keys → Order relay</a> mein "Options trading" = <b>yes</b> kariye.`;
  if (!target?.lot) return "Is option ka lot size nahi mila.";
  return null;
}
function orderPanel() {
  const box = root.querySelector("#sporder");
  if (!target) return;
  if (engine && (engine.live || engine.state === "idle")) { box.innerHTML = `<div class="panel-h"><h2>Smart order</h2></div><div class="panel-b"><div class="note">Ek bracket chal raha hai (upar dekhiye). Naya trade uske poora hone ke baad.</div></div>`; return; }
  if (F.entry == null && ltp) { F.entry = snap(ltp); fromEntry(); }
  const block = why();
  const num = (id, v, step = TICK) => `<input class="field" id="${id}" type="number" inputmode="decimal" step="${step}" min="0" value="${v ?? ""}">`;
  box.innerHTML = `<div class="panel-h"><h2>Smart order</h2><span class="right"><span class="pill p-opt">BUY</span></span></div>
    <div class="panel-b sp-form">
      ${block ? `<div class="sp-warn">${block}</div>` : ""}
      <div class="sp-row"><label class="label" for="splots">Lots</label><div class="sp-in"><button type="button" class="btn2 sm" data-lot="-1" aria-label="Kam">−</button>${num("splots", F.lots, 1)}<button type="button" class="btn2 sm" data-lot="1" aria-label="Zyada">+</button><span class="sp-off" id="spqty"></span></div></div>
      <div class="sp-row"><label class="label" for="spentry">Entry (Buy limit)<small class="sp-follow" id="spfollow"></small></label><div class="sp-in">${num("spentry", F.entry)}<button type="button" class="btn2 sm" id="spuseltp" title="Abhi ka daam">LTP</button><button type="button" class="btn2 sm" id="spuseask" title="Sabse sasta seller">Ask</button></div></div>
      <div class="sp-row"><label class="label" for="sptgt">Target</label><div class="sp-in">${num("sptgt", F.target)}<span class="sp-off up" id="offt"></span></div></div>
      <div class="sp-row"><label class="label" for="sptrig">SL trigger</label><div class="sp-in">${num("sptrig", F.trig)}<span class="sp-off" id="offg"></span></div></div>
      <div class="sp-row"><label class="label" for="spsl">SL limit</label><div class="sp-in">${num("spsl", F.sl)}<span class="sp-off down" id="offs"></span></div></div>
      <div class="sp-row"><label class="label" for="spchase">SL na bhare to</label><div class="sp-in">${num("spchase", F.chase, 1)}<span class="sp-off" style="min-width:120px;text-align:left">sec baad abhi ke daam par</span></div></div>
      <div class="sp-row"><span class="label">Product</span><div class="seg" id="spprod"><button type="button" data-p="MIS" class="${F.product === "MIS" ? "on" : ""}">MIS (intraday)</button><button type="button" data-p="NRML" class="${F.product === "NRML" ? "on" : ""}">NRML</button></div></div>
      <div class="sp-sum tnum" id="spsum"></div>
      <label class="switch" title="On karne par confirm nahi poochha jaayega"><input type="checkbox" id="sp1c" ${F.oneClick ? "checked" : ""}><span></span>One-click (bina confirm)</label>
      <div id="spconfirm"></div>
      <button class="btn btn-buy sp-go" id="spgo" ${block ? "disabled" : ""}>BUY + Target / SL</button>
      <div class="kres bad" id="sperr" hidden></div>
      <div class="sp-warn"><b>Dhyan dijiye:</b> Target Zerodha par laga rehta hai, lekin <b>SL trigger aur ${F.chase}s chase is page se chalte hain</b>. Trade ke dauraan ye tab khula rakhiye aur internet chalu rakhiye.</div>
    </div>`;
  const $ = (id) => box.querySelector("#" + id);
  const val = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
  $("splots").oninput = () => { F.lots = Math.max(0, Math.floor(val("splots") || 0)); calc(); };
  box.querySelectorAll("[data-lot]").forEach((b) => (b.onclick = () => { F.lots = Math.max(1, (F.lots || 0) + +b.dataset.lot); $("splots").value = F.lots; calc(); }));
  const setEntry = (v) => { F.entry = snap(v); F.entryTouched = true; fromEntry(); ["spentry", "sptgt", "sptrig", "spsl"].forEach((id, i) => ($(id).value = [F.entry, F.target, F.trig, F.sl][i] ?? "")); calc(); };
  $("spentry").oninput = () => { F.entry = val("spentry"); F.entryTouched = true; fromEntry(); $("sptgt").value = F.target ?? ""; $("sptrig").value = F.trig ?? ""; $("spsl").value = F.sl ?? ""; calc(); };
  $("spentry").onchange = () => { if (F.entry > 0) setEntry(F.entry); };
  $("spuseltp").onclick = () => ltp && setEntry(ltp);
  $("spuseask").onclick = () => (ask || ltp) && setEntry(ask || ltp);
  const offIn = (id, key, sign) => ($(id).oninput = () => { const v = val(id); F[key] = v; if (v > 0 && F.entry > 0) F.off[key] = r2(sign * (v - F.entry)); calc(); });
  offIn("sptgt", "target", 1); offIn("sptrig", "trig", -1); offIn("spsl", "sl", -1);
  $("spchase").oninput = () => { F.chase = Math.round(val("spchase") || 0); calc(); };
  $("spprod").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; F.product = b.dataset.p; $("spprod").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); saveForm(); };
  $("sp1c").onchange = (e) => { F.oneClick = e.target.checked; confirming = false; $("spconfirm").innerHTML = ""; H.toast(F.oneClick ? "One-click ON: button dabate hi order chala jaayega." : "One-click OFF: har order se pehle confirm."); };
  $("spgo").onclick = go;
  calc();
}
function calc() {
  const box = root.querySelector("#sporder"), $ = (id) => box.querySelector("#" + id);
  if (!$("spsum")) return;
  const p = plan(), q = p.qty, off = (v, s) => (v > 0 && F.entry > 0 ? `${s > 0 ? "+" : "−"}${f2(Math.abs(v - F.entry))}` : "");
  $("spqty").textContent = target?.lot ? `= ${q} qty` : "";
  $("spfollow").textContent = F.entryTouched ? "" : "live daam ke saath";
  $("offt").textContent = off(F.target, 1); $("offg").textContent = off(F.trig, -1); $("offs").textContent = off(F.sl, -1);
  let err = checkPlan(p);
  if (!err && limits && F.lots > limits.max_lots) err = `Ek order ki limit ${limits.max_lots} lot hai (API Keys mein badal sakte hain)`;
  if (!err && limits && F.entry * q > limits.max_value) err = `Rakam ₹${Math.round(F.entry * q).toLocaleString("en-IN")} limit ₹${limits.max_value.toLocaleString("en-IN")} se zyada hai`;
  if (!err && ltp && F.entry > ltp * 1.02) err = `Entry ${f2(F.entry)} abhi ke daam ${f2(ltp)} se kaafi upar hai. Turant mehenga bhar jaayega.`;
  const val = F.entry * q, risk = F.sl > 0 ? (F.entry - F.sl) * q : null, rew = F.target > 0 ? (F.target - F.entry) * q : null;
  $("spsum").innerHTML = `<span>Qty</span><b>${q || "–"}</b><span>Rakam</span><b>${inr(val)}</b><span>Max nuksan ≈</span><b class="down">${risk == null ? "–" : inr(risk)}</b><span>Target munafa ≈</span><b class="up">${rew == null ? "–" : inr(rew)}</b>`;
  const e = $("sperr"); e.hidden = !err; e.textContent = err ? "✗ " + err : "";
  $("spgo").disabled = !!err || !!why();
  saveForm(); drawLines();
  if (confirming) showConfirm();
}
function liveCalc() {                                       // until you type an entry price yourself, it follows the live price
  const box = root.querySelector("#sporder"), inp = box.querySelector("#spentry");
  if (engine?.live || !inp || !ltp || F.entryTouched || confirming) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const e = snap(ltp); if (e === F.entry) return;
  F.entry = e; fromEntry();
  inp.value = F.entry; box.querySelector("#sptgt").value = F.target ?? ""; box.querySelector("#sptrig").value = F.trig ?? ""; box.querySelector("#spsl").value = F.sl ?? "";
  calc();
}
function showConfirm() {
  const c = root.querySelector("#spconfirm"); if (!c) return;
  const p = plan();
  c.innerHTML = `<div class="sp-confirm"><b>Confirm kariye</b><div>BUY <b>${p.qty}</b> (${F.lots} lot) <b>${esc(target.name)}</b> @ <b>${f2(F.entry)}</b> LIMIT · ${F.product}</div>
    <div>${F.target ? `Bharne par Target SELL <b>${f2(F.target)}</b>` : "Target nahi"} · ${F.trig ? `Daam <b>${f2(F.trig)}</b> chhuye to SL SELL <b>${f2(F.sl)}</b>, ${F.chase}s mein na bhare to abhi ke daam par` : "SL nahi"}</div>
    <div class="sp-cb"><button class="btn btn-buy sm" id="spyes">Haan, order bhejo</button><button class="btn2 sm" id="spno">Wapas</button></div></div>`;
  c.querySelector("#spyes").onclick = () => { confirming = false; c.innerHTML = ""; startBracket(); };
  c.querySelector("#spno").onclick = () => { confirming = false; c.innerHTML = ""; };
}
function go() {
  if (F.oneClick) return startBracket();
  confirming = true; showConfirm();
}

// ---------- the bracket ----------
function actionsFor(c) {
  const quiet = (e) => /khula nahi/.test(e.message);       // order already finished: not an error, polling shows the final state
  return {
    place: async ({ side, price, qty }) => {
      const lots = qty / c.lot;
      if (!Number.isInteger(lots) || lots < 1) throw new Error(`Qty ${qty} lot size ${c.lot} ka poora guna nahi`);
      const d = await H.adminPost("order", { symbol: c.symbol, side, lots, order_type: "LIMIT", price, product: c.product, confirm: true });
      setTimeout(pollOrders, 400);
      return d.order_id;
    },
    cancel: async (id) => { try { await H.adminPost("order-change", { op: "cancel", order_id: id }); } catch (e) { if (!quiet(e)) throw e; } setTimeout(pollOrders, 400); },
    modify: async (id, { price }) => { try { await H.adminPost("order-change", { op: "modify", order_id: id, price }); } catch (e) { if (!quiet(e)) throw e; } setTimeout(pollOrders, 400); },
  };
}
function makeEngine(c, json) {
  let was = null;
  const opts = { onChange: (e) => { save(); renderBracket(); drawLines(); lockSearch(); if (e.live !== was) { was = e.live; orderPanel(); } } };
  return json ? Bracket.restore(json, actionsFor(c), opts) : new Bracket(plan(), actionsFor(c), opts);
}
async function startBracket() {
  const err = checkPlan(plan()) || why(); if (err) return H.toast(err.replace(/<[^>]+>/g, ""));
  ctx = { symbol: target.symbol, name: target.name, lot: target.lot, token: target.token, product: F.product };
  try { engine = makeEngine(ctx); } catch (e) { return H.toast(e.message); }
  orderPanel(); renderBracket(); startPolling();
  await engine.start();
  if (ltp) engine.onTick(ltp);
}
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(() => { pollN++; if (!wsLive || pollN % 2 === 0) pollOrders(); }, 2000); }
async function pollOrders() {
  if (!engine?.live) { if (engine && !engine.live) { clearInterval(pollTimer); orderPanel(); } return; }
  if (polling) return; polling = true;
  try {
    for (const id of engine.openOrderIds()) {
      try { const d = await H.adminGet(`order-status?id=${encodeURIComponent(id)}`); if (d.order) await engine.onOrder(d.order); } catch {}
    }
    if (ltp) await engine.onTick(ltp);                      // timers (chase) also move without a new tick
  } finally { polling = false; }
  if (!engine.live) { clearInterval(pollTimer); orderPanel(); }
}
function lockSearch() {
  const live = !!engine?.live, l = root.querySelector("#splock");
  root.querySelector("#q4").disabled = live; l.hidden = !live;
  l.innerHTML = live ? `🔒 Bracket chal raha hai (${esc(ctx?.name)}), isliye search band hai.` : "";
}
function save() {
  try { if (!engine) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify({ ctx, b: engine.toJSON(), at: Date.now() })); } catch {}
}
function saveForm() { try { localStorage.setItem(KEY + "-form", JSON.stringify({ off: F.off, chase: F.chase, product: F.product })); } catch {} }
async function resume() {
  let s = null; try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  if (!s?.ctx || !s.b) return;
  if (Date.now() - (s.at || 0) > 18 * 36e5) { try { localStorage.removeItem(KEY); } catch {} return; }   // yesterday's trade: forget it
  ctx = s.ctx;
  try { engine = makeEngine(ctx, s.b); } catch { engine = null; return; }
  root.querySelector("#q4").value = ctx.name;
  await choose({ symbol: ctx.symbol, name: ctx.name, lot_size: ctx.lot, token: ctx.token }, true);
  if (engine.live) { engine.log("Page dobara khula: bracket resume, Zerodha se orders check kar rahe hain"); H.toast("Pichhla bracket resume kiya. Orders Zerodha se check ho rahe hain."); startPolling(); pollOrders(); }
  renderBracket(); lockSearch();
}

function renderBracket() {
  const box = root.querySelector("#spbr");
  if (!engine) { box.hidden = true; return; }
  box.hidden = false;
  const e = engine, st = e.state, tone = st === "done" ? "pos" : st === "error" ? "neg" : st === "stopped" ? "neu" : "live";
  const row = (label, o) => o ? `<tr><td>${label}</td><td class="r">${f2(o.price ?? e.p.entry)}</td><td class="r">${o.qty ?? e.p.qty}</td><td><span class="sp-ost ${/COMPLETE/.test(o.status) ? "pos" : /CANCEL|REJECT/.test(o.status) ? "neg" : ""}">${esc(o.status)}</span>${o.filled ? ` <small>${o.filled} bhara</small>` : ""}</td><td class="id">${esc(o.id)}</td></tr>` : "";
  box.innerHTML = `<div class="panel-h"><h2>Bracket</h2><span class="right"><span class="sp-badge ${tone}">${esc(STATE_TXT[st] || st)}</span></span></div>
    <div class="panel-b">
      <div class="sp-bsum tnum"><span>${esc(ctx?.name || "")}</span><span>Qty <b>${e.p.qty}</b></span><span>Entry <b>${f2(e.p.entry)}</b></span>${e.p.target != null ? `<span>T <b class="up">${f2(e.p.target)}</b></span>` : ""}${e.p.slTrigger != null ? `<span>Trig <b>${f2(e.p.slTrigger)}</b> → SL <b class="down">${f2(e.p.slLimit)}</b></span>` : ""}<span>Chase <b>${e.p.chaseSec}s</b></span><span id="sppnl"></span></div>
      ${e.reason && !e.live ? `<div class="${st === "error" ? "sp-err" : "sp-ok"}">${esc(e.reason)}${st === "error" ? ". Kite app mein turant orders/positions dekhiye." : ""}</div>` : ""}
      <table class="tbl sp-ot tnum"><thead><tr><th>Order</th><th class="r">Daam</th><th class="r">Qty</th><th>Status</th><th>ID</th></tr></thead><tbody>${row("Entry BUY", e.o.entry ? { ...e.o.entry, price: e.p.entry } : null)}${row("Target SELL", e.o.target)}${row(e.o.sl?.exit ? "Exit SELL" : "SL SELL", e.o.sl)}</tbody></table>
      <div class="sp-btns">
        ${st === "entry_open" ? `<button class="btn2 sm" id="spcx">Entry cancel</button>` : ""}
        ${["active", "sl_armed", "sl_open"].includes(st) ? `<button class="btn btn-sell sm" id="spexit">Exit now (abhi ke daam par)</button>` : ""}
        ${e.live ? `<button class="btn2 sm danger" id="spstop" title="Zerodha par lage orders waise hi rahenge">Managing band</button>` : `<button class="btn2 sm" id="spnew">Naya trade</button>`}
      </div>
      <div class="label" style="margin-top:12px">Kya hua</div>
      <div class="sp-log">${e.events.slice().reverse().map((x) => `<div><time>${hhmmss(x.at)}</time>${esc(x.msg)}</div>`).join("")}</div>
    </div>`;
  pnlTick();
  const b = (id, fn) => { const el = box.querySelector("#" + id); if (el) el.onclick = fn; };
  b("spcx", () => e.cancelEntry());
  b("spexit", () => { if (F.oneClick || confirm("Poori position abhi ke daam par bechein?")) e.exitNow(); });
  b("spstop", () => { if (confirm("Managing band karein? Zerodha par jo orders lage hain wo waise hi rahenge, lekin SL/chase ab nahi chalega.")) { e.stop(); clearInterval(pollTimer); orderPanel(); } });
  b("spnew", () => { engine = null; ctx = null; F.entryTouched = false; F.entry = null; save(); renderBracket(); lockSearch(); orderPanel(); drawLines(); });
}

function pnlTick() {                                       // running P&L on the open qty, updated every tick
  const el = root.querySelector("#sppnl"); if (!el) return;
  const e = engine, pnl = e?.filled && ltp && e.live ? (ltp - (e.avg ?? e.p.entry)) * e.remaining() : null;
  el.innerHTML = pnl == null ? "" : `P&amp;L ≈ <b class="${pnl >= 0 ? "up" : "down"}">${inr(pnl)}</b>`;
}

const CSS = `
.sp-status{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2)}
.sp-status .dot.warn{background:var(--warn)}
.sp-grid{display:grid;gap:14px;grid-template-columns:minmax(0,1fr);margin-top:14px}
@media(min-width:1100px){.sp-grid{grid-template-columns:minmax(0,1fr) 380px}}
.sp-left,.sp-right{display:grid;gap:14px;align-content:start;min-width:0}
#spchart{height:440px;position:relative}
@media(max-width:760px){#spchart{height:300px}}
.sp-empty{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:var(--muted)}
.sp-ba{display:flex;gap:16px;flex-wrap:wrap;padding:8px 14px 0;font-size:12px;color:var(--muted)}.sp-ba b{color:var(--ink);font-weight:600}
.sp-form{display:grid;gap:10px}
.sp-row{display:grid;grid-template-columns:118px minmax(0,1fr);align-items:center;gap:8px}
.sp-in{display:flex;gap:6px;align-items:center;min-width:0}
.sp-in .field{text-align:right;font-variant-numeric:tabular-nums;min-width:0}
.sp-off{font-size:12px;color:var(--muted);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
.sp-sum{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 10px;font-size:12px;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2)}
.sp-sum span{color:var(--muted)}.sp-sum b{font-weight:600}
.sp-follow{display:block;text-transform:none;letter-spacing:0;font-weight:500;color:var(--accent);font-size:10.5px;margin-top:2px}
.sp-go{width:100%;height:46px;font-size:15px}
.sp-warn{background:var(--warn-bg);color:var(--warn-ink);border-radius:var(--r-sm);padding:9px 11px;font-size:12px;line-height:1.45}
.sp-warn a{color:inherit}
.sp-confirm{border:1px solid var(--pos);border-radius:var(--r-sm);padding:10px 12px;font-size:12.5px;display:grid;gap:6px;background:var(--pos-soft)}
.sp-cb{display:flex;gap:8px;margin-top:4px}
.sp-badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:11px;font-size:11.5px;font-weight:600;background:var(--accent-soft);color:var(--accent)}
.sp-badge.pos{background:var(--pos-soft);color:var(--pos)}.sp-badge.neg{background:var(--neg-soft);color:var(--neg)}.sp-badge.neu{background:var(--hover);color:var(--text-2)}
.sp-badge.live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:6px;animation:sppulse 1.2s infinite}
@keyframes sppulse{50%{opacity:.3}}
.sp-bsum{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin-bottom:10px}.sp-bsum b{color:var(--ink);font-weight:600}
.sp-err{background:var(--neg-soft);color:var(--neg);border-radius:var(--r-sm);padding:9px 11px;font-size:13px;font-weight:600;margin-bottom:10px}
.sp-ok{background:var(--pos-soft);color:var(--pos);border-radius:var(--r-sm);padding:9px 11px;font-size:13px;font-weight:600;margin-bottom:10px}
.sp-ot td,.sp-ot th{padding:7px 8px;font-size:12px}.sp-ot td.id{color:var(--muted);font-size:11px}
.sp-ost{font-weight:600;font-size:11.5px}.sp-ost.pos{color:var(--pos)}.sp-ost.neg{color:var(--neg)}
.sp-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.sp-log{max-height:220px;overflow:auto;font-size:12px;margin-top:6px;display:grid;gap:4px}
.sp-log div{display:flex;gap:8px;color:var(--text-2)}.sp-log time{color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.sp-dt{width:100%;border-collapse:collapse;font-size:12px}
.sp-dt th{font-size:10.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:4px 6px;text-align:right}
.sp-dt td{padding:4px 6px;text-align:right;position:relative}
.sp-dt td.q i{position:absolute;top:3px;bottom:3px;z-index:0;opacity:.18;border-radius:2px}
.sp-dt td.q{z-index:1}.sp-dt .bb{right:0;background:var(--pos)}.sp-dt .sb{left:0;background:var(--neg)}
.sp-dt td.o{color:var(--muted)}
@media(max-width:600px){.sp-row{grid-template-columns:96px minmax(0,1fr)}.sp-in .btn2.sm{padding:0 8px}.sp-sum{grid-template-columns:auto 1fr}}
`;
