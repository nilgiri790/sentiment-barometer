// Scalping terminal for BANK NIFTY / NIFTY: index chart + option chart, the whole option chain (live OI / IV / delta),
// an AI that picks one strike, market depth and BUY with automatic target / stop-loss.
// Loaded only when the page is opened. The bracket logic is ./scalpengine.mjs and runs IN THIS BROWSER TAB:
// orders go through /api/admin/order (+ order-change for cancel / price change), order status comes from
// Zerodha's WebSocket order updates and /api/admin/order-status polling. Page closed = no stop-loss management.
import { createChart, CrosshairMode, LineStyle } from "./vendor/lightweight-charts-4.2.3.mjs";
import { parseTicks, applyTick, barsFromTicks, IST, orderUpdate } from "./kiteticks.mjs";
import { Bracket, checkPlan, tickFloor, LIVE, hardLimit } from "./scalpengine.mjs";
import { mountTrade, tradingState } from "./trade.mjs";
import { mountAI, AI_CSS } from "./scalpai.mjs";
import { optionCharges } from "./charges.mjs";
import { mountChain, CHAIN_CSS, INDICES, indexOfSymbol, optName } from "./scalpchain.mjs";
import { contractGreeks } from "./optanalytics.mjs";
import { PaperBroker } from "./paperbroker.mjs";
import { bracketResult } from "./tradestats.mjs";
import { mountJournal, JOURNAL_CSS } from "./scalpjournal.mjs";
import { mountRisk, RISK_CSS } from "./scalprisk.mjs";
import { mountContext, CONTEXT_CSS } from "./scalpctx.mjs";

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
const EMPTY_OPT = `<div class="empty sp-empty">Neeche <b>option chain</b> mein kisi strike ka <b>CE</b> ya <b>PE</b> daam dabaiye, ya AI se <b>Scan trade</b> karwaiye. Option ka chart, depth aur order yahan khulenge.</div>`;

let H, root, chart = null, main = null, vol = null, plines = [];
let target = null, tf = TFS[3], bars = [], ticks = [], ltp = null, bid = null, ask = null, depth = null, prevClose = null, lastCum = null;
let ws = null, wsLive = false, retry = 0, subSet = new Set(), extraToks = [], ltpTimer = null, candleTimer = null, pollTimer = null, polling = false, pollN = 0;
let ai = null, market = null, journal = null, risk = null, ctxbar = null, paper = null, engine = null, ctx = null, limits = null, trading = null, confirming = false;
// index (BANK NIFTY / NIFTY) chart
let IDX = "BANKNIFTY", ich = null, imain = null, ibars = [], iticks = [], ilines = [], ilineKey = "";
try { const k = localStorage.getItem(KEY + "-index"); if (INDICES[k]) IDX = k; } catch {}
// Paper (pretend money) or Asli (real orders): one switch for your trades and the AI's. Paper is the safe default.
let TMODE = "paper";
try { if (localStorage.getItem(KEY + "-mode") === "real") TMODE = "real"; } catch {}
const ANYTIME = location.hostname === "localhost" && /[?&]anytime=1/.test(location.search);   // test hook
// form: offsets are kept when the entry price changes (user's example: +10 target, -7 trigger, -6 SL limit)
const F = { lots: 1, entry: null, target: null, trig: null, sl: null, chase: 30, product: "MIS", oneClick: false, off: { target: 10, trig: 7, sl: 6 }, offPct: { target: 10, trig: 7, sl: 6 }, unit: "pt", entryTouched: false };
const CK = {};                                             // pre-trade checklist ticks (reset after each trade)
// protection: hardSl = stop-loss waits on Zerodha (works even if this page closes); beAt / trailBy in points; maxHoldMin
Object.assign(F, { hardSl: true, beAt: 0, trailBy: 0, maxHoldMin: 0, lotMode: "fixed", setup: "", mood: "planned" });
try { const s = JSON.parse(localStorage.getItem(KEY + "-form") || "null"); if (s) { F.hardSl = s.hardSl !== false; F.beAt = +s.beAt || 0; F.trailBy = +s.trailBy || 0; F.maxHoldMin = +s.maxHoldMin || 0; F.lotMode = s.lotMode === "risk" ? "risk" : "fixed"; Object.assign(F.off, s.off || {}); Object.assign(F.offPct, s.offPct || {}); F.unit = s.unit === "pct" ? "pct" : "pt"; F.chase = s.chase || 30; F.product = s.product === "NRML" ? "NRML" : "MIS"; } } catch {}

export function mountScalp(el, helpers) {
  H = helpers; root = el;
  if (!document.getElementById("sp-css")) document.head.insertAdjacentHTML("beforeend", `<style id="sp-css">${CSS}${AI_CSS}${CHAIN_CSS}${JOURNAL_CSS}${RISK_CSS}${CONTEXT_CSS}</style>`);
  root.innerHTML = `
    <div class="page-head"><div><h1>Scalping</h1><p class="sub">BANK NIFTY / NIFTY: index aur option ka live chart, poori option chain, AI ka strike pick, aur ek click mein BUY + target + stop-loss.</p></div></div>
    <div class="seg sp-tabs" id="sptabs"><button type="button" data-t="trade" class="on">📈 Trading</button><button type="button" data-t="sum">📒 Trade summary</button></div>
    <div id="sptj" hidden></div>
    <div id="sptrade">
    <section class="panel"><div class="panel-b">
      <div class="btbar">
        <div class="seg sp-idx" id="spidx">${Object.values(INDICES).map((x) => `<button type="button" data-i="${x.key}" class="${x.key === IDX ? "on" : ""}">${x.label}</button>`).join("")}</div>
        <label class="sp-exp"><span class="label">Expiry</span><select class="sel" id="spexp" aria-label="Expiry"></select></label>
        <div class="seg" id="sptf">${TFS.map((t) => `<button type="button" data-k="${t.k}" class="${t.k === tf.k ? "on" : ""}">${t.k}</button>`).join("")}</div>
        <div class="seg sp-mode" id="spmode" title="Paper = nakli paise, Asli = asli orders"><button type="button" data-m="paper" class="${TMODE === "paper" ? "on" : ""}">📝 Paper</button><button type="button" data-m="real" class="${TMODE === "real" ? "on" : ""}">₹ Asli</button></div>
        <span class="sp-status"><span class="dot" id="spdot"></span><span id="spstat">Shuru ho raha hai…</span></span>
      </div>
      <div class="note" id="splock" hidden></div>
    </div></section>
    <section class="panel sp-ctx" id="spctx"></section>
    <div class="sp-grid">
      <div class="sp-left">
        <section class="panel">
          <div class="panel-h"><h2 id="spiname">–</h2><span class="label">INDEX</span><span class="right"><span class="ltp tnum" id="spiltp"></span><span class="chg tnum" id="spichg"></span></span></div>
          <div class="panel-b sp-chipsb"><div class="ai-chips" id="spchips"></div></div>
          <div id="spichart"></div>
        </section>
        <section class="panel">
          <div class="sp-quick" id="spquick"><span class="label">Jaldi kholo</span>
            ${["CE", "PE"].map((t) => `<span class="sp-qg ${t === "CE" ? "up" : "down"}">${t}</span>${[["itm", "ITM"], ["atm", "ATM"], ["otm", "OTM"]].map(([k, l]) => `<button type="button" class="btn2 sm" data-q="${t}-${k}">${l}</button>`).join("")}`).join("")}
            <span class="sp-keys" title="Keyboard shortcuts">⌨ Shift+C ATM CE · Shift+P ATM PE · Shift+B BUY · Shift+X Exit</span></div>
          <div class="panel-h"><h2 id="spname">Koi option nahi khula</h2><span class="right"><span class="ltp tnum" id="spltp"></span><span class="chg tnum" id="spchg"></span></span></div>
          <div class="sp-ba tnum" id="spba"></div>
          <div class="sp-ba tnum" id="spgk"></div>
          <div id="spchart">${EMPTY_OPT}</div>
        </section>
        <section class="panel"><div class="panel-h"><h2>Option chain</h2><span class="right note" style="margin:0">CE / PE daam dabaiye = wo option khulega · OI Δ = page khulne se badlav</span></div>
          <div class="ch-box" id="spchain"></div></section>
        <section class="panel" id="spai"></section>
        <section class="panel" id="spdepthp" hidden><div class="panel-h"><h2>Market depth</h2><span class="right label" id="spdq"></span></div><div class="panel-b" id="spdepth"></div></section>
      </div>
      <div class="sp-right">
        <section class="panel" id="sprisk"></section>
        <section class="panel" id="spbr" hidden></section>
        <section class="panel" id="sporder"><div class="panel-h"><h2>Smart order</h2></div><div class="panel-b"><div class="note">Option chain se strike chuniye.</div></div></section>
        <section class="panel" id="spplain" hidden><div class="panel-h"><h2>Simple order</h2><span class="right label">bina target/SL</span></div><div class="panel-b" id="spplainb"></div></section>
      </div>
    </div>
    </div>
    <footer>Scalping mein nuksan jaldi ho sakta hai. "Zerodha par" SL Zerodha par laga rehta hai; "Page par" SL, trailing / time exit, auto square-off aur AI is page se chalte hain: page band = wo band. Ye investment advice nahi hai.</footer>`;
  market = mountChain(root.querySelector("#spchain"), root.querySelector("#spchips"), {
    H, setTokens: (list) => setToks("chain", list), current: () => target?.symbol, aiPick: () => ai?.pick(),
    onPick: (o) => pick(o), onLoaded: expiries, onSummary: indexLines });
  journal = mountJournal(root.querySelector("#sptj"), { H, onChange: () => { ai?.draw(); risk?.draw(); calc(); } });
  ctxbar = mountContext(root.querySelector("#spctx"), { H, setTokens: (list) => setToks("ctx", list), spot: () => market.under.spot, summary: () => market.summary(),
    expiry: () => market.chain?.expiry, onLevels: () => { ilineKey = ""; indexLines(market.summary()); } });
  risk = mountRisk(root.querySelector("#sprisk"), { H, mode: () => TMODE, trades: () => journal.list(), live: () => !!engine?.live, onPanic: panic, onChange: () => calc() });
  risk.load();
  root.querySelector("#spquick").onclick = (e) => { const b = e.target.closest("[data-q]"); if (b) quickOpen(...b.dataset.q.split("-")); };
  document.addEventListener("keydown", hotkey);
  ai = mountAI(root.querySelector("#spai"), { H, market, applyPick, autoTrade, context: () => ctxSnapshot(), onPlan: () => { ilineKey = ""; indexLines(market.summary()); }, tradeMode: () => TMODE, today: () => journal.today(TMODE),
    state: () => ({ target, meta: metaP, ltp, bid, ask, depth, wsLive, bracketLive: !!engine?.live }) });
  journal.load();
  root.querySelector("#sptabs").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; const sum = b.dataset.t === "sum";
    root.querySelectorAll("#sptabs button").forEach((x) => x.classList.toggle("on", x === b)); root.querySelector("#sptj").hidden = !sum; root.querySelector("#sptrade").hidden = sum;
    if (sum) journal.load(); };
  root.querySelector("#spmode").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.m !== TMODE) setTradeMode(b.dataset.m); };
  setInterval(watchdog, 1000);
  root.querySelector("#spidx").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.i !== IDX) setIndex(b.dataset.i); };
  root.querySelector("#spexp").onchange = (e) => market.setExpiry(e.target.value);
  root.querySelector("#sptf").onclick = (e) => { const b = e.target.closest("button"); if (!b || b.dataset.k === tf.k) return; tf = TFS.find((t) => t.k === b.dataset.k);
    root.querySelectorAll("#sptf button").forEach((x) => x.classList.toggle("on", x === b)); loadIndexBars(); if (target) loadBars(); };
  window.addEventListener("beforeunload", (e) => { if (engine?.live) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("hashchange", () => { if (engine?.live && !location.hash.startsWith("#/scalp")) H.toast("Scalping bracket chal raha hai. Is tab ko band mat kariye, SL isi se chalta hai."); });
  ai.refresh();
  resume().then((resumed) => { if (!resumed) setIndex(IDX, true); });
  setInterval(() => {                                      // no live ticks: refresh the chain + index chart now and then
    if (wsLive || document.hidden || root.closest("[hidden]") || !market.idx) return;
    market.reload(); if (!tf.live) loadIndexBars(true);
  }, 30000);
}
export function onShowScalp() { ai?.refresh(); market?.draw(); journal?.load(); risk?.load(); if (target) { orderPanel(); renderBracket(); plain(); } }

// compact market context for the AI (VIX, future, heavyweights, day type, levels)
function ctxSnapshot() {
  const C = ctxbar?.data(); if (!C || C.error) return null;
  const pc = (a, b) => (a != null && b ? Math.round(((a - b) / b) * 10000) / 100 : null), L = ctxbar.levels() || {};
  return { indiaVix: C.vix?.last ?? null, vixChangePct: pc(C.vix?.last, C.vix?.prevClose), dayType: ctxbar.dayType(),
    future: C.fut ? { last: C.fut.last, vwap: C.fut.avg, premium: C.fut.last && market.under.spot ? Math.round(C.fut.last - market.under.spot) : null, oi: C.fut.oi } : null,
    heavyweights: (C.heavy || []).map((h) => [h.sym, pc(h.last, h.prevClose)]),
    levels: { prevHigh: L.pdh, prevLow: L.pdl, prevClose: L.pdc, cpr: L.cpr, r1: L.r1, s1: L.s1, openingRangeHigh: L.orh, openingRangeLow: L.orl, expectedMoveHigh: L.expHi, expectedMoveLow: L.expLo } };
}

// ---------- Paper / Asli ----------
function setTradeMode(m) {
  if (engine?.live) { H.toast("Trade chal raha hai. Paper / Asli uske baad badaliye."); return; }
  if (ai?.isAuto()) { H.toast("Pehle AI Auto trade band kariye, phir Paper / Asli badaliye."); return; }
  if (m === "real" && !confirm("ASLI mode: ab BUY + Target / SL se Zerodha par asli orders lagenge (aapke aur AI ke).\n\nPehle Paper mein kuch din practice behtar hai. Asli mode chalu karein?")) return;
  TMODE = m; try { localStorage.setItem(KEY + "-mode", m); } catch {}
  root.querySelectorAll("#spmode button").forEach((x) => x.classList.toggle("on", x.dataset.m === m));
  H.toast(m === "real" ? "Asli mode: orders Zerodha par jaayenge." : "Paper mode: koi asli order nahi, nakli paise se practice.");
  orderPanel(); plain(); ai?.draw(); risk?.draw();
}

// ---------- AI auto trade: the AI opens its strike and starts the bracket itself, within your limits ----------
function tradeWindow(now = Date.now()) {                     // no NEW AI trade after 15:00 (and not in the first 5 minutes)
  if (ANYTIME) return true;
  const d = new Date(now + IST * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 560 && m < 900;
}
const aiStarts = {};                                      // AI trades started today per mode (counts before the summary row is saved)
const aiKey = () => `${TMODE}|${new Date(Date.now() + IST * 1000).toISOString().slice(0, 10)}`;
async function autoTrade(r) {
  const A = ai.autoSettings(), t = { ...journal.today(TMODE) };
  t.trades = Math.max(t.trades, aiStarts[aiKey()] || 0);
  if (r.signal === "WAIT" || !r.entry) return { ok: false, msg: "AI ne WAIT kaha: trade nahi kiya" };
  const lock = risk?.blocked(); if (lock) return { ok: false, msg: `Kill switch: ${lock}`, stop: true };
  if (engine?.live) return { ok: false, msg: "Pehla trade abhi chal raha hai" };
  if (!tradeWindow()) { const d = new Date(Date.now() + IST * 1000), late = d.getUTCHours() >= 15;
    return { ok: false, msg: late ? "3:00 baje ke baad naya AI trade nahi" : "9:20 se pehle naya AI trade nahi", stop: late }; }
  if (t.trades >= A.maxTrades) return { ok: false, msg: `Aaj ki AI trade limit (${A.maxTrades}) poori`, stop: true };
  if (t.net <= -A.maxLoss) return { ok: false, msg: `Aaj ka max nuksan ₹${A.maxLoss} pahunch gaya`, stop: true };
  if (t.lastLossAt && Date.now() - t.lastLossAt < 5 * 60000) return { ok: false, msg: "Pichhla AI trade nuksan mein tha: 5 min ruk rahe hain" };
  if (r.confidence < A.minConf) return { ok: false, msg: `Bharosa ${r.confidence}% hai, aapki shart ${A.minConf}%+: trade nahi kiya` };
  if (A.minScore && !(r.score?.agree >= A.minScore)) return { ok: false, msg: `Score ${r.score?.agree ?? "–"}/${r.score?.n ?? "–"} hai, aapki shart ${A.minScore}+: trade nahi kiya` };
  if (TMODE === "real") { const w = why(); if (w) return { ok: false, msg: w.replace(/<[^>]+>/g, ""), stop: true }; }
  const okPick = await applyPick({ symbol: r.symbol, name: r.name, lot: market.chain?.lot_size, entry: r.entry, target: r.target, stopLoss: r.stopLoss });
  if (!okPick) return { ok: false, msg: "Strike nahi khula" };
  // the AI saw prices a few seconds old: wait for a live tick, then move entry / target / SL by the same points to the live price
  for (let i = 0; i < 30 && !gotTick; i++) await new Promise((r) => setTimeout(r, 100));
  if (!gotTick || !(ltp > 0)) return { ok: false, msg: "Is strike ka live daam nahi mila: trade nahi kiya" };
  const live = snap(ltp), shift = live - F.entry;
  if (Math.abs(shift) / F.entry > 0.005) {
    F.entry = live; F.target = F.target ? snap(F.target + shift) : F.target; F.trig = F.trig ? snap(F.trig + shift) : F.trig; F.sl = F.sl ? snap(F.sl + shift) : F.sl;
    H.toast(`AI ka entry live daam ${f2(live)} par khiskaya (target / SL bhi ${shift > 0 ? "+" : ""}${f2(shift)})`);
  }
  if (F.trig && ltp <= F.trig) return { ok: false, msg: "Daam pehle hi AI ke SL ke neeche hai: trade nahi kiya" };
  F.lots = A.lots; if (F.lotMode === "risk") { const n = riskLots(); if (n != null) F.lots = Math.min(A.lots, n); } orderPanel();
  const err = planError({ manual: false }); if (err) return { ok: false, msg: "Plan theek nahi: " + err, stop: /Kill switch/.test(err) };
  aiStarts[aiKey()] = (aiStarts[aiKey()] || 0) + 1;
  await startBracket({ source: "ai", auto: true, signal: r });
  return engine?.live ? { ok: true, msg: `AI ne ${TMODE === "real" ? "ASLI" : "Paper"} trade shuru kiya: ${A.lots} lot ${r.name} @ ${f2(r.entry)}` } : { ok: false, msg: engine?.reason || "Trade shuru nahi hua" };
}
// PANIC: close the running trade at the current price (or cancel an open entry) and switch the AI off
function panic() {
  ai?.stop("🚨 Panic: AI band.");
  if (!engine?.live) return H.toast("Koi trade chal nahi raha.");
  if (engine.state === "entry_open") { engine.log("🚨 Panic: entry cancel"); engine.cancelEntry(); } else { engine.log("🚨 Panic: abhi ke daam par bahar"); engine.exitNow(); }
  H.toast("🚨 Panic: trade band kiya ja raha hai.");
}
// one-click strike: ATM / 1 ITM / 1 OTM call or put of the loaded chain
function quickOpen(type, k) {
  const s = market.summary(), rows = market.chain?.rows || [];
  if (!s || !rows.length) return H.toast("Option chain abhi aa rahi hai.");
  const i = rows.findIndex((r) => r.strike === s.atm), step = k === "atm" ? 0 : (k === "itm") === (type === "CE") ? -1 : 1;
  const row = rows[i + step], c = row?.[type.toLowerCase()];
  if (!c) return H.toast("Ye strike chain mein nahi hai.");
  pick({ symbol: c.symbol, name: optName(IDX, market.chain.expiry, row.strike, type), lot_size: market.chain.lot_size, token: c.token, option: true });
}
function hotkey(e) {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || root.closest("[hidden]") || root.querySelector("#sptrade").hidden) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
  const k = e.key.toUpperCase();
  if (k === "C") { e.preventDefault(); quickOpen("CE", "atm"); }
  else if (k === "P") { e.preventDefault(); quickOpen("PE", "atm"); }
  else if (k === "B") { e.preventDefault(); const b = root.querySelector("#spgo"); if (b && !b.disabled) b.click(); else H.toast("BUY abhi band hai: form dekhiye."); }
  else if (k === "X") { e.preventDefault(); if (engine?.live) { engine.state === "entry_open" ? engine.cancelEntry() : engine.exitNow(); } }
}
const istHM = (ms = Date.now()) => new Date(ms + IST * 1000).toISOString().slice(11, 16);
// every second: AI entry not filled in 60 s -> cancel it; auto square-off time; remember how far the price went
function watchdog() {
  risk && Date.now() % 15000 < 1000 && risk.draw();
  if (!engine?.live || !ctx) return;
  const sq = risk?.settings().sqoffAt || "15:15";
  if (!ANYTIME && istHM() >= sq && !ctx.sqoff) {
    ctx.sqoff = true; engine.log(`⏰ ${sq}: auto square-off`); H.toast(`⏰ ${sq}: trade apne aap band kiya ja raha hai`);
    if (engine.state === "entry_open") engine.cancelEntry(); else engine.exitNow();
  }
  if (ctx.auto && engine.state === "entry_open" && Date.now() - ctx.startedAt > 60000 && !ctx.cancelAsked) {
    ctx.cancelAsked = true; engine.log("60 sec mein entry nahi bhari: AI ne entry cancel ki"); engine.cancelEntry();
  }
}

// ---------- BANK NIFTY / NIFTY ----------
async function setIndex(key, first = false) {
  if (engine?.live) { H.toast("Ek bracket chal raha hai. Index uske poora hone ke baad badaliye."); return; }
  IDX = key; try { localStorage.setItem(KEY + "-index", key); } catch {}
  root.querySelectorAll("#spidx button").forEach((x) => x.classList.toggle("on", x.dataset.i === key));
  root.querySelector("#spiname").textContent = INDICES[key].index;
  if (!first || target) closeOption();
  ai.indexChanged(); ibars = []; iticks = []; ilineKey = "";
  await Promise.all([market.setIndex(key), loadIndexBars(), ctxbar.setIndex(key)]);
}
function expiries(d) {
  const sel = root.querySelector("#spexp");
  sel.innerHTML = (d.expiries || [d.expiry]).map((e) => `<option value="${e}" ${e === d.expiry ? "selected" : ""}>${new Date(e + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" })}</option>`).join("");
}
function pick(o) {                                          // a CE / PE price was clicked in the chain
  if (engine?.live) { H.toast("Ek bracket chal raha hai. Naya strike uske poora hone ke baad."); return; }
  if (o.symbol === target?.symbol) return;
  choose(o);
}
function closeOption() {
  target = null; metaP = null; ltp = bid = ask = depth = prevClose = null; ticks = []; bars = []; lastCum = null;
  if (chart) { chart.remove(); chart = main = vol = null; plines = []; }
  root.querySelector("#spchart").innerHTML = EMPTY_OPT; root.querySelector("#spname").textContent = "Koi option nahi khula";
  ["#spltp", "#spchg", "#spba", "#spgk"].forEach((s) => (root.querySelector(s).innerHTML = ""));
  root.querySelector("#spdepthp").hidden = true; root.querySelector("#spplain").hidden = true;
  root.querySelector("#sporder").innerHTML = `<div class="panel-h"><h2>Smart order</h2></div><div class="panel-b"><div class="note">Option chain se strike chuniye.</div></div>`;
  if (!engine?.live) { engine = null; ctx = null; save(); renderBracket(); }
  setToks("opt", []);
}

// index chart: candles from /api/candles (index symbol), live from ticks; support / resistance / max pain as lines
function ensureIndexChart() {
  if (ich) return;
  ich = createChart(root.querySelector("#spichart"), chartOpts());
  const up = css("--pos"), dn = css("--neg");
  imain = ich.addCandlestickSeries({ upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn, priceFormat: { type: "price", precision: 2, minMove: 0.05 } });
}
async function loadIndexBars(quiet = false) {
  ensureIndexChart();
  ich.applyOptions({ timeScale: { secondsVisible: tf.sec < 60 } });
  const ix = INDICES[IDX];
  if (tf.live) ibars = barsFromTicks(iticks, tf.sec);
  else {
    try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(ix.sym)}&interval=${tf.api}`, { cache: "no-store" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      if (ix.key !== IDX) return;
      ibars = d.candles.map(([t, o, h, l, c]) => ({ time: t + IST, open: o, high: h, low: l, close: c, volume: 0 }));
      market.setUnder({ token: d.instrument_token, prevClose: d.prevClose, spot: d.last ?? ibars.at(-1)?.close });
      setToks("idx", d.instrument_token ? [d.instrument_token] : []);
    } catch (e) { ibars = []; if (!quiet) H.toast("Index chart nahi aaya: " + e.message); }
  }
  imain.setData(ibars.map(pt)); if (!quiet) ich.timeScale().fitContent();
  indexHeader();
}
function indexHeader() {
  const u = market.under, c = root.querySelector("#spichg");
  root.querySelector("#spiltp").textContent = f2(u.spot);
  if (u.spot && u.prevClose) { const d = u.spot - u.prevClose; c.className = "chg tnum " + (d >= 0 ? "up" : "down"); c.textContent = `${d >= 0 ? "+" : ""}${f2(d)} (${((d / u.prevClose) * 100).toFixed(2)}%)`; }
  else c.textContent = "";
}
// index chart lines: OI levels from the chain (support / resistance / max pain) + price levels from the context bar
// (yesterday's high / low, opening range, expected move from the ATM straddle) + the AI's plan levels
function indexLines(s) {
  if (!imain) return;
  const L = ctxbar?.levels(), show = L?.show || { oi: true, px: true }, P = ai?.plan?.() || null, list = [];
  const push = (p, color, title, style = LineStyle.Dashed) => { if (p > 0) list.push([Math.round(p * 100) / 100, color, title, style]); };
  if (s && show.oi) { push(s.resistance, css("--neg"), "Resistance (OI)"); push(s.support, css("--pos"), "Support (OI)"); push(s.maxPain, css("--muted"), "Max pain", LineStyle.Dotted); }
  if (L && show.px) { push(L.pdh, "#e5a93b", "Kal ka High", LineStyle.Dotted); push(L.pdl, "#e5a93b", "Kal ka Low", LineStyle.Dotted);
    push(L.orh, "#22d3ee", "OR High", LineStyle.SparseDotted); push(L.orl, "#22d3ee", "OR Low", LineStyle.SparseDotted);
    push(L.expHi, "#94a3b8", "Exp move ↑", LineStyle.LargeDashed); push(L.expLo, "#94a3b8", "Exp move ↓", LineStyle.LargeDashed); }
  if (P) { push(P.above, css("--pos"), "AI: CE above", LineStyle.Solid); push(P.below, css("--neg"), "AI: PE below", LineStyle.Solid); }
  const k = JSON.stringify(list.map((x) => [x[0], x[2]])); if (k === ilineKey) return; ilineKey = k;
  ilines.forEach((l) => imain.removePriceLine(l)); ilines = [];
  for (const [price, color, title, lineStyle] of list) ilines.push(imain.createPriceLine({ price, color, lineWidth: 1, lineStyle, axisLabelVisible: true, title }));
}
function onIndexTick(t) {
  const ms = Date.now();
  iticks.push({ ms, price: t.ltp, dv: 0 }); if (iticks.length > 100000) iticks.splice(0, 20000);
  if (imain) { const before = ibars.length, bar = applyTick(ibars, ms, t.ltp, 0, tf.sec); if (bar) { if (!before) imain.setData(ibars.map(pt)); else imain.update(pt(bar)); } }
  indexHeader(); greeksRow();
}

// AI -> open its strike + fill entry / target / SL trigger / SL limit. It never sends an order: the user presses BUY.
async function applyPick(sig) {
  if (engine?.live) { H.toast("Ek bracket chal raha hai. AI ka strike uske poora hone ke baad."); return false; }
  if (sig.symbol !== target?.symbol) {
    await choose({ symbol: sig.symbol, name: sig.name, lot_size: sig.lot, option: true });
    if (target?.symbol !== sig.symbol) return false;
  }
  const gap = F.sl > 0 && F.trig > 0 ? r2(F.sl - F.trig) : 0;          // keep your usual trigger -> limit gap (e.g. 93 -> 94)
  F.entry = snap(sig.entry); F.entryTouched = true; F.target = snap(sig.target); F.trig = snap(sig.stopLoss);
  F.sl = snap(Math.max(TICK, Math.min(sig.stopLoss + gap, F.entry - TICK)));
  confirming = false; orderPanel(); market.draw();
  root.querySelector("#sporder").scrollIntoView({ behavior: "smooth", block: "nearest" });
  return true;
}

// ---------- open an option ----------
async function choose(o, keepEngine = false) {
  if (engine?.live && !keepEngine) { H.toast("Ek bracket abhi chal raha hai. Pehle use poora hone dijiye ya 'Managing band' kariye."); return; }
  target = { symbol: o.symbol, name: o.name || o.symbol, kind: "option", lot: +o.lot_size || +o.lot || null, token: o.token || null };
  ltp = null; bid = ask = null; depth = null; prevClose = null; ticks = []; lastCum = null; F.entry = null; F.entryTouched = false; confirming = false; gotTick = false;
  if (!keepEngine) { engine = null; ctx = null; save(); }
  root.querySelector("#spname").textContent = target.name;
  root.querySelector("#spdepthp").hidden = true;
  ["#spltp", "#spchg", "#spba", "#spgk"].forEach((q) => (root.querySelector(q).innerHTML = ""));          // no old prices under the new name
  if (!keepEngine) root.querySelector("#sporder").innerHTML = `<div class="panel-h"><h2>Smart order</h2></div><div class="panel-b"><div class="note">${esc(target.name)} aa raha hai…</div></div>`;
  if (target.token) setToks("opt", [target.token]);
  market.draw();
  [trading] = await Promise.all([tradingState(true), loadMeta()]);
  limits = trading?.trading?.limits || null;
  await loadBars();
  orderPanel(); renderBracket(); plain(); market.draw(); ai.draw();
  connect();
}
let metaP = null, gotTick = false;
async function loadMeta() {                                 // lot size + price snapshot from Zerodha (also used by the simple Buy/Sell)
  try { const r = await fetch(`/api/price?sym=${encodeURIComponent(target.symbol)}&range=1d`, { cache: "no-store" }); const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    metaP = d; target.lot = +d.option?.lot_size || target.lot; prevClose = d.prevClose ?? prevClose; if (ltp == null && d.last && !gotTick) ltp = d.last;
  } catch (e) { metaP = null; H.toast("Option ki jaankari nahi aayi: " + e.message); }
}
function plain() {
  const box = root.querySelector("#spplainb"); box.innerHTML = ""; root.querySelector("#spplain").hidden = !metaP || TMODE !== "real";
  if (metaP) mountTrade(box, { ...metaP, last: ltp ?? metaP.last });
}

// ---------- option chart ----------
function chartOpts() {
  return { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
    grid: { vertLines: { color: "rgba(125,135,153,.08)" }, horzLines: { color: "rgba(125,135,153,.08)" } }, crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: true, rightOffset: 6 },
    localization: { priceFormatter: (p) => f2(p) } };
}
function ensureChart() {
  if (chart) return;
  const el = root.querySelector("#spchart"); el.innerHTML = "";
  chart = createChart(el, chartOpts());
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
  const sym = target.symbol;
  if (tf.live) { bars = barsFromTicks(ticks, tf.sec); }
  else {
    try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(sym)}&interval=${tf.api}`, { cache: "no-store" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      if (target?.symbol !== sym) return;
      target.token ??= d.instrument_token; prevClose = d.prevClose ?? prevClose;
      bars = d.candles.map(([t, o, h, l, c, v]) => ({ time: t + IST, open: o, high: h, low: l, close: c, volume: v || 0 }));
      if (ltp == null && bars.length) ltp = bars[bars.length - 1].close;
    } catch (e) { bars = []; H.toast("Chart data nahi aaya: " + e.message); }
    if (!H.isAdmin()) candleTimer = setInterval(() => { if (!document.hidden && target) loadBars(); }, 20000);    // no live ticks: refresh
  }
  if (!main) return;
  main.setData(bars.map(pt)); vol.setData(bars.map(vpt)); chart.timeScale().fitContent();
  setToks("opt", target.token ? [target.token] : []);
  header(); greeksRow(); drawLines();
}
function header() {
  root.querySelector("#spltp").textContent = f2(ltp);
  const c = root.querySelector("#spchg");
  if (prevClose && ltp != null) { const d = ltp - prevClose; c.className = "chg tnum " + (d >= 0 ? "up" : "down"); c.textContent = `${d >= 0 ? "+" : ""}${f2(d)} (${((d / prevClose) * 100).toFixed(2)}%)`; }
  else c.textContent = "";
  root.querySelector("#spba").innerHTML = bid || ask ? `<span>Bid <b class="up">${f2(bid)}</b></span><span>Ask <b class="down">${f2(ask)}</b></span><span>Spread <b>${bid && ask ? f2(ask - bid) : "–"}</b></span>${target?.lot ? `<span>Lot <b>${target.lot}</b></span>` : ""}`
    : target?.lot ? `<span>Lot <b>${target.lot}</b></span><span class="note" style="margin:0">Bid/Ask live ticks se aata hai</span>` : "";
}
let gkT = 0;
function greeksRow() {                                      // IV and Greeks of the open option (our Black-Scholes estimate)
  const el = root.querySelector("#spgk"), o = metaP?.option, spot = market.under.spot;
  if (!el || !target || !o || !spot || !ltp) { if (el && !target) el.innerHTML = ""; return; }
  if (Date.now() - gkT < 1000) return; gkT = Date.now();
  const g = contractGreeks({ ltp, spot, strike: o.strike, expiry: o.expiry, type: o.type });
  el.innerHTML = `<span>IV <b>${g.iv ? g.iv + "%" : "–"}</b></span><span>Delta <b>${g.delta ?? "–"}</b></span><span>Gamma <b>${g.gamma ?? "–"}</b></span><span>Theta/din <b class="down">${g.theta != null ? f2(g.theta) : "–"}</b></span><span>Vega <b>${g.vega != null ? f2(g.vega) : "–"}</b></span>`;
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
// live token sources: the open option first, then the index and the option chain
const tokSrc = {};
function setToks(src, list) {
  tokSrc[src] = list; extraToks = [...new Set(Object.values(tokSrc).flat())];
  if (ws) subscribe(); else if (extraToks.length) connect();
}
let connecting = false;
async function connect() {
  if (!target && !extraToks.length) return;
  if (ws && ws.readyState <= 1) { subscribe(); return; }
  if (!H.isAdmin()) { setStatus("", "Delayed · login ke bina live nahi (30s refresh)"); return; }
  if (connecting) return; connecting = true;
  let auth;
  try { auth = await H.adminGet("ticker"); }
  catch (e) { connecting = false; wsLive = false; setStatus("warn", "Live ticks nahi: " + e.message.slice(0, 60)); startLtpPoll(); return; }
  connecting = false;
  ws = new WebSocket(`${WSBASE}?api_key=${encodeURIComponent(auth.api_key)}&access_token=${encodeURIComponent(auth.access_token)}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { retry = 0; wsLive = true; subSet = new Set(); subscribe(); stopLtpPoll(); setStatus("live", "Live · Zerodha ticks"); };
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
  if (!ws || ws.readyState !== 1) return;
  // open option, index and chain, all in "full" mode (OI + depth); the open option goes first
  const want = new Set([target?.token, ...(tokSrc.opt || []), ...extraToks].filter(Boolean));
  const add = [...want].filter((t) => !subSet.has(t)), del = [...subSet].filter((t) => !want.has(t));
  if (del.length) ws.send(JSON.stringify({ a: "unsubscribe", v: del }));
  if (add.length) { ws.send(JSON.stringify({ a: "subscribe", v: add })); ws.send(JSON.stringify({ a: "mode", v: ["full", add] })); }
  subSet = want;
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
  if (!polled) { market?.onTick(t); ctxbar?.onTick(t); if (t.token && t.token === market?.under.token) { onIndexTick(t); ctxbar?.onSpot(t.ltp); } }
  if (!target || (t.token !== target.token && !polled)) return;
  const ms = Date.now(), dv = t.volume != null && lastCum != null ? Math.max(0, t.volume - lastCum) : 0;
  if (t.volume != null) lastCum = t.volume;
  ltp = t.ltp; gotTick = true; if (t.bid !== undefined) { bid = t.bid; ask = t.ask; depth = t.depth; }
  if (!prevClose && t.close) prevClose = t.close;
  ticks.push({ ms, price: ltp, dv }); if (ticks.length > 100000) ticks.splice(0, 20000);
  if (main) { const before = bars.length, bar = applyTick(bars, ms, ltp, dv, tf.sec);
    if (bar) { if (!before) { main.setData(bars.map(pt)); vol.setData(bars.map(vpt)); } else { main.update(pt(bar)); vol.update(vpt(bar)); } } }
  header(); greeksRow(); drawDepth(); liveCalc(); pnlTick();
  if (engine?.live && engine.filled && ctx) { ctx.hi = Math.max(ctx.hi ?? ltp, ltp); ctx.lo = Math.min(ctx.lo ?? ltp, ltp); }
  paper?.tick(ltp);
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
  F.target = priceOf("target", 1); F.trig = priceOf("trig", -1); F.sl = priceOf("sl", -1);
}
// the +/- boxes are points (+10 = 10 rupees) or percent of the entry (+10 = 10%), as chosen in "Target/SL mein"
const offs = () => (F.unit === "pct" ? F.offPct : F.off);
function priceOf(key, sign, v = offs()[key]) { return F.entry > 0 && v >= 0 ? snap(F.unit === "pct" ? F.entry * (1 + (sign * v) / 100) : F.entry + sign * v) : null; }
function offsetOf(price, sign) { if (!(price > 0 && F.entry > 0)) return null; const d = sign * (price - F.entry); return r2(F.unit === "pct" ? (d / F.entry) * 100 : d); }
function keepOffsets() {                                     // remember the current prices as offsets in the chosen unit
  for (const [k, sg] of [["target", 1], ["trig", -1], ["sl", -1]]) { const o = offsetOf(F[k], sg); if (o != null) offs()[k] = o; }
}
function plan() {
  return { qty: (F.lots || 0) * (target?.lot || 0), entry: F.entry, target: F.target ?? "", slTrigger: F.trig ?? "", slLimit: F.sl ?? "", chaseSec: F.chase, tick: TICK,
    hardSl: !!F.hardSl, beAt: F.beAt || 0, trailBy: F.trailBy || 0, maxHoldSec: (F.maxHoldMin || 0) * 60 };
}
function why() {
  if (!H.isAdmin()) return `Order ke liye <a href="#/keys">API Keys</a> mein login kariye.`;
  if (TMODE === "paper") return target?.lot ? null : "Is option ka lot size nahi mila.";
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
  // points box next to each price: type the profit / loss in points, the price fills itself (and the other way round)
  const pts = (id, sign, tone, title) => `<span class="sp-pts ${tone}" title="${title}"><i>${sign}</i><input class="field" id="${id}" type="number" inputmode="decimal" step="${F.unit === "pct" ? 0.5 : 0.05}" min="0" aria-label="${title}"><b class="sp-u">${F.unit === "pct" ? "%" : ""}</b></span>`;
  const num = (id, v, step = TICK) => `<input class="field" id="${id}" type="number" inputmode="decimal" step="${step}" min="0" value="${v ?? ""}">`;
  box.innerHTML = `<div class="panel-h"><h2>Smart order</h2><span class="right"><span class="pill p-opt">BUY</span></span></div>
    <div class="panel-b sp-form">
      ${block ? `<div class="sp-warn">${block}</div>` : ""}
      <div class="sp-row"><label class="label" for="splots">Lots</label><div class="sp-in"><button type="button" class="btn2 sm" data-lot="-1" aria-label="Kam">−</button>${num("splots", F.lots, 1)}<button type="button" class="btn2 sm" data-lot="1" aria-label="Zyada">+</button><span class="sp-off" id="spqty"></span></div></div>
      <div class="sp-row"><span class="label">Lot kaise</span><div class="sp-in"><div class="seg" id="splm"><button type="button" data-l="fixed" class="${F.lotMode !== "risk" ? "on" : ""}">Khud</button><button type="button" data-l="risk" class="${F.lotMode === "risk" ? "on" : ""}" title="SL tak ka nuksan per-trade risk se zyada na ho">Risk se</button></div><span class="sp-off" id="splmn" style="text-align:left;min-width:0"></span></div></div>
      <div class="sp-row"><label class="label" for="spentry">Entry (Buy limit)<small class="sp-follow" id="spfollow"></small></label><div class="sp-in">${num("spentry", F.entry)}<button type="button" class="btn2 sm" id="spuseltp" title="Abhi ka daam">LTP</button><button type="button" class="btn2 sm" id="spuseask" title="Sabse sasta seller">Ask</button></div></div>
      <div class="sp-row"><span class="label">Target/SL mein</span><div class="seg" id="spunit"><button type="button" data-u="pt" class="${F.unit === "pt" ? "on" : ""}">Points (₹)</button><button type="button" data-u="pct" class="${F.unit === "pct" ? "on" : ""}">Percent (%)</button></div></div>
      <div class="sp-row"><label class="label" for="sptgt">Target</label><div class="sp-in">${num("sptgt", F.target)}${pts("offt", "+", "up", "Target: entry se kitne point upar")}</div></div>
      <div class="sp-row"><label class="label" for="sptrig">SL trigger</label><div class="sp-in">${num("sptrig", F.trig)}${pts("offg", "−", "", "SL trigger: entry se kitne point neeche")}</div></div>
      <div class="sp-row"><label class="label" for="spsl">SL limit</label><div class="sp-in">${num("spsl", F.sl)}${pts("offs", "−", "down", "SL limit: entry se kitne point neeche")}</div></div>
      <div class="sp-row"><label class="label" for="spchase">SL na bhare to</label><div class="sp-in">${num("spchase", F.chase, 1)}<span class="sp-off" style="min-width:120px;text-align:left">sec baad abhi ke daam par</span></div></div>
      <div class="sp-row"><span class="label">SL kahan</span><div class="seg" id="sphard"><button type="button" data-h="1" class="${F.hardSl ? "on" : ""}" title="Stop-loss Zerodha par rahega: page / laptop band ho tab bhi kaam karega">🛡 Zerodha par</button><button type="button" data-h="0" class="${F.hardSl ? "" : "on"}" title="Stop-loss sirf page khula rehne tak">Page par</button></div></div>
      <div class="sp-note" id="sphardn"></div>
      <div class="sp-adv"><label><span>Breakeven</span><input class="field" id="spbe" type="number" min="0" step="0.5" value="${F.beAt || ""}" placeholder="0"><small>+pt par SL = entry</small></label>
        <label><span>Trailing SL</span><input class="field" id="sptrail" type="number" min="0" step="0.5" value="${F.trailBy || ""}" placeholder="0"><small>pt peeche chale</small></label>
        <label><span>Time exit</span><input class="field" id="sptime" type="number" min="0" step="1" value="${F.maxHoldMin || ""}" placeholder="0"><small>min baad bahar</small></label></div>
      <div class="sp-row"><span class="label">Product</span><div class="seg" id="spprod"><button type="button" data-p="MIS" class="${F.product === "MIS" ? "on" : ""}">MIS (intraday)</button><button type="button" data-p="NRML" class="${F.product === "NRML" ? "on" : ""}">NRML</button></div></div>
      <div class="sp-sum tnum" id="spsum"></div>
      <div class="sp-tags"><label><span>Setup</span><select class="sel" id="spsetup">${[["", "– chuniye –"], ["breakout", "Breakout"], ["vwap", "VWAP"], ["oi", "OI shift"], ["reversal", "Reversal"], ["range", "Range"], ["other", "Doosra"]].map(([v, l]) => `<option value="${v}" ${F.setup === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label><span>Mann</span><select class="sel" id="spmood">${[["planned", "Planned"], ["fomo", "FOMO (chhoot na jaaye)"], ["revenge", "Revenge (loss wapas)"], ["bored", "Bas aise hi"]].map(([v, l]) => `<option value="${v}" ${F.mood === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      ${risk?.settings().checklist ? `<div class="sp-check" id="spcheck"><span class="label">Trade se pehle (teeno zaroori)</span>
        ${[["c1", "Trend / direction mere saath hai"], ["c2", "Level / setup saaf hai (support, resistance, VWAP)"], ["c3", "R:R 1.5+ hai aur SL tay hai"]].map(([k, l]) => `<label class="sp-ck"><input type="checkbox" data-c="${k}" ${CK[k] ? "checked" : ""}> ${l}</label>`).join("")}</div>` : ""}
      <label class="switch" title="On karne par confirm nahi poochha jaayega"><input type="checkbox" id="sp1c" ${F.oneClick ? "checked" : ""}><span></span>One-click (bina confirm)</label>
      <div id="spconfirm"></div>
      <button class="btn btn-buy sp-go" id="spgo" ${block ? "disabled" : ""}>BUY + Target / SL <small class="sp-gm">${TMODE === "real" ? "ASLI ORDER" : "PAPER"}</small></button>
      <div class="kres bad" id="sperr" hidden></div>
      <div class="sp-warn"><b>Dhyan dijiye:</b> ${F.hardSl ? `SL Zerodha par rahega, lekin <b>target, breakeven / trailing, time exit aur auto exit is page se chalte hain</b>.` : `Target Zerodha par laga rehta hai, lekin <b>SL trigger aur ${F.chase}s chase is page se chalte hain</b>.`} Trade ke dauraan ye tab khula rakhiye aur internet chalu rakhiye.</div>
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
  const offIn = (id, key, sign) => ($(id).oninput = () => { const v = val(id); F[key] = v; const o = offsetOf(v, sign); if (o != null) offs()[key] = o; calc(); });
  offIn("sptgt", "target", 1); offIn("sptrig", "trig", -1); offIn("spsl", "sl", -1);
  const ptsIn = (id, key, priceId, sign) => ($(id).oninput = () => {       // points typed -> price
    const v = val(id); if (v == null || v < 0) return;
    offs()[key] = v; if (F.entry > 0) { F[key] = priceOf(key, sign, v); $(priceId).value = F[key] ?? ""; } calc();
  });
  ptsIn("offt", "target", "sptgt", 1); ptsIn("offg", "trig", "sptrig", -1); ptsIn("offs", "sl", "spsl", -1);
  $("spchase").oninput = () => { F.chase = Math.round(val("spchase") || 0); calc(); };
  $("sphard").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; F.hardSl = b.dataset.h === "1"; $("sphard").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); calc(); };
  $("spbe").oninput = () => { F.beAt = Math.max(0, val("spbe") || 0); calc(); };
  $("sptrail").oninput = () => { F.trailBy = Math.max(0, val("sptrail") || 0); calc(); };
  $("sptime").oninput = () => { F.maxHoldMin = Math.max(0, Math.round(val("sptime") || 0)); calc(); };
  $("spunit").onclick = (e) => { const b = e.target.closest("button"); if (!b || b.dataset.u === F.unit) return; F.unit = b.dataset.u; keepOffsets(); saveForm(); orderPanel(); };
  $("spprod").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; F.product = b.dataset.p; $("spprod").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); saveForm(); };
  $("sp1c").onchange = (e) => { F.oneClick = e.target.checked; confirming = false; $("spconfirm").innerHTML = ""; H.toast(F.oneClick ? "One-click ON: button dabate hi order chala jaayega." : "One-click OFF: har order se pehle confirm."); };
  $("spgo").onclick = go;
  $("splm").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; F.lotMode = b.dataset.l; $("splm").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); calc(); };
  $("spsetup").onchange = (e) => (F.setup = e.target.value); $("spmood").onchange = (e) => (F.mood = e.target.value);
  box.querySelectorAll("[data-c]").forEach((c) => (c.onchange = () => { CK[c.dataset.c] = c.checked; calc(); }));
  calc();
}
function calc() {
  const box = root.querySelector("#sporder"), $ = (id) => box.querySelector("#" + id);
  if (!$("spsum")) return;
  const p = plan(), q = p.qty, off = (v, s) => (v > 0 && F.entry > 0 ? `${s > 0 ? "+" : "−"}${f2(Math.abs(v - F.entry))}` : "");
  $("spqty").textContent = target?.lot ? `= ${q} qty` : "";
  $("spfollow").textContent = F.entryTouched ? "" : "live daam ke saath";
  const hn = $("sphardn");
  if (hn) hn.innerHTML = F.hardSl ? (F.trig > 0 ? `🛡 Zerodha par SL order rahega: daam <b>${f2(F.trig)}</b> chhute hi <b>${f2(hardLimit(F.trig))}</b> tak bik jaayega (page band ho tab bhi). Target ${F.target ? f2(F.target) : "–"} page dekhega.` : "")
    : `⚠ SL sirf is page se chalega: page / internet band = SL band.`;
  const setPts = (id, v, s) => { const el = $(id); if (el && document.activeElement !== el) el.value = offsetOf(v, s) ?? ""; };
  setPts("offt", F.target, 1); setPts("offg", F.trig, -1); setPts("offs", F.sl, -1);
  const err = planError();
  const ln = $("splmn"); if (ln) ln.textContent = F.lotMode === "risk" ? (riskLots() != null ? `₹${risk?.settings().riskPerTrade} risk → ${F.lots} lot` : "SL do") : tradeRisk() != null ? `SL nuksan ≈ ₹${Math.round(tradeRisk())}` : "";
  if (F.lotMode === "risk" && $("splots") && document.activeElement !== $("splots")) $("splots").value = F.lots;
  const val = F.entry * q, risk = F.sl > 0 ? (F.entry - F.sl) * q : null, rew = F.target > 0 ? (F.target - F.entry) * q : null;
  // Zerodha charges for the BUY + the SELL (at target; at the SL the sell is smaller, so STT a bit less)
  const exitPx = F.target > 0 ? F.target : F.sl > 0 ? F.sl : F.entry;
  const ch = q && F.entry > 0 ? optionCharges({ buy: val, sell: exitPx * q }) : null, chSl = q && F.sl > 0 ? optionCharges({ buy: val, sell: F.sl * q }) : null;
  const rs = (v) => (v == null ? "–" : "₹" + f2(v));
  const be = ch && q ? F.entry + optionCharges({ buy: val, sell: val }).total / q : null;
  $("spsum").innerHTML = `<span>Qty</span><b>${q || "–"}</b><span>Rakam</span><b>${inr(val)}</b>
    <span>Brokerage + charges</span><b title="BUY + SELL dono orders ka">${rs(ch?.total)}</b><span>Break-even ≈</span><b>${be ? f2(snap(be + TICK / 2)) : "–"}</b>
    <div class="sp-ch">${ch ? `BUY + SELL: Brokerage ₹${f2(ch.brokerage)} · STT ₹${f2(ch.stt)} · Exchange ₹${f2(ch.txn)} · GST ₹${f2(ch.gst)} · Stamp + SEBI ₹${f2(ch.stamp + ch.sebi)}` : ""}</div>
    <span>Max nuksan ≈</span><b class="down">${risk == null ? "–" : inr(risk + (chSl?.total || 0))}</b><span>Target munafa ≈</span><b class="up">${rew == null ? "–" : inr(rew - (ch?.total || 0))}</b>
    <div class="sp-ch">${risk != null || rew != null ? "Nuksan / munafa charges jodkar / ghatakar (andaaza)." : ""}</div>`;
  const e = $("sperr"); e.hidden = !err; e.textContent = err ? "✗ " + err : "";
  $("spgo").disabled = !!err || !!why();
  saveForm(); drawLines();
  if (confirming) showConfirm();
}
// money lost if the stop-loss is hit (per unit): Zerodha SL sells at most down to its limit
const slExitPx = () => (F.trig > 0 ? (F.hardSl ? hardLimit(F.trig) : Math.min(F.sl || F.trig, F.trig)) : null);
const tradeRisk = (lots = F.lots) => { const x = slExitPx(); return x && F.entry > 0 && target?.lot ? Math.max(0, (F.entry - x) * lots * target.lot) : null; };
function riskLots() {                                       // biggest lot count whose SL loss fits the per-trade risk
  const one = tradeRisk(1), R = risk?.settings().riskPerTrade || 0;
  return one > 0 ? Math.floor(R / one) : null;
}
function planError({ manual = true } = {}) {
  if (F.lotMode === "risk") { const n = riskLots(); if (n != null) F.lots = Math.max(0, n); }
  const p = plan(), q = p.qty, R = risk?.settings();
  const lock = risk?.blocked(); if (lock) return `🔒 Kill switch: ${lock}`;
  let err = checkPlan(p);
  if (!err && F.lotMode === "risk" && F.lots < 1) err = `1 lot ka SL nuksan ₹${Math.round(tradeRisk(1))} hai, aapki per-trade limit ₹${R.riskPerTrade} se zyada: SL paas rakhiye ya limit badhaiye`;
  if (!err && R && tradeRisk() > R.riskPerTrade) err = `Is trade ka SL nuksan ₹${Math.round(tradeRisk())} hai, per-trade limit ₹${R.riskPerTrade}: lot kam kariye ya "Risk se" chuniye`;
  if (!err && R && bid > 0 && ask > 0 && ltp && ((ask - bid) / ltp) * 100 > R.spreadPct) err = `Spread zyada hai (${f2(ask - bid)} = ${(((ask - bid) / ltp) * 100).toFixed(1)}%, limit ${R.spreadPct}%): abhi entry mehengi padegi`;
  if (!err && manual && R?.checklist && !(CK.c1 && CK.c2 && CK.c3)) err = "Checklist ke teeno box tick kariye";
  if (!err && TMODE === "real" && limits && F.lots > limits.max_lots) err = `Ek order ki limit ${limits.max_lots} lot hai (API Keys mein badal sakte hain)`;
  if (!err && TMODE === "real" && limits && F.entry * q > limits.max_value) err = `Rakam ₹${Math.round(F.entry * q).toLocaleString("en-IN")} limit ₹${limits.max_value.toLocaleString("en-IN")} se zyada hai`;
  if (!err && ltp && F.entry > ltp * 1.02) err = `Entry ${f2(F.entry)} abhi ke daam ${f2(ltp)} se kaafi upar hai. Turant mehenga bhar jaayega.`;
  return err;
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
  c.innerHTML = `<div class="sp-confirm"><b>Confirm kariye · ${TMODE === "real" ? "ASLI ORDER (Zerodha)" : "PAPER TRADE (nakli paise)"}</b><div>BUY <b>${p.qty}</b> (${F.lots} lot) <b>${esc(target.name)}</b> @ <b>${f2(F.entry)}</b> LIMIT · ${F.product}</div>
    <div>${F.target ? `Target <b>${f2(F.target)}</b>` : "Target nahi"} · ${F.trig ? (F.hardSl ? `🛡 Zerodha SL: trigger <b>${f2(F.trig)}</b> → <b>${f2(hardLimit(F.trig))}</b> tak` : `Daam <b>${f2(F.trig)}</b> chhuye to SL SELL <b>${f2(F.sl)}</b> (page se)`) + `, ${F.chase}s mein na bhare to abhi ke daam par` : "SL nahi"}</div>
    ${F.beAt || F.trailBy || F.maxHoldMin ? `<div>${F.beAt ? `+${F.beAt} pt par SL entry par · ` : ""}${F.trailBy ? `trailing ${F.trailBy} pt · ` : ""}${F.maxHoldMin ? `${F.maxHoldMin} min baad bahar` : ""}</div>` : ""}
    <div class="sp-cb"><button class="btn btn-buy sm" id="spyes">Haan, order bhejo</button><button class="btn2 sm" id="spno">Wapas</button></div></div>`;
  c.querySelector("#spyes").onclick = () => { confirming = false; c.innerHTML = ""; startBracket(); };
  c.querySelector("#spno").onclick = () => { confirming = false; c.innerHTML = ""; };
}
function go() {
  const t = risk?.today();
  if (t?.lastNet < 0 && Date.now() - t.lastAt < 2 * 60000 && F.mood !== "revenge") {
    if (!confirm(`Abhi ${Math.max(1, Math.round((Date.now() - t.lastAt) / 1000))} sec pehle loss hua hai. Kahin ye "revenge trade" (loss wapas lene ki jaldi) to nahi?\n\nOK = phir bhi trade (Revenge tag lagega) · Cancel = ruk jaaiye`)) return;
    F.mood = "revenge"; const m = root.querySelector("#spmood"); if (m) m.value = "revenge";
  }
  if (F.oneClick) return startBracket();
  confirming = true; showConfirm();
}

// ---------- the bracket ----------
function actionsFor(c) {
  const quiet = (e) => /khula nahi/.test(e.message);       // order already finished: not an error, polling shows the final state
  if (c.mode === "paper") {                                 // pretend broker: fills on live ticks, no order leaves this page
    paper = new PaperBroker({ ltp: () => ltp, onUpdate: (u) => engine?.onOrder(u) });
    return { place: (o) => paper.place(o), cancel: async (id) => { try { await paper.cancel(id); } catch (e) { if (!quiet(e)) throw e; } }, modify: async (id, ch) => { try { await paper.modify(id, ch); } catch (e) { if (!quiet(e)) throw e; } },
      placeSL: (o) => paper.placeSL(o), modifySL: (id, ch) => paper.modifySL(id, ch) };
  }
  paper = null;
  return {
    place: async ({ side, price, qty }) => {
      const lots = qty / c.lot;
      if (!Number.isInteger(lots) || lots < 1) throw new Error(`Qty ${qty} lot size ${c.lot} ka poora guna nahi`);
      const d = await H.adminPost("order", { symbol: c.symbol, side, lots, order_type: "LIMIT", price, product: c.product, confirm: true, ...(side === "BUY" ? { scalp: true } : {}), ...(c.auto && side === "BUY" ? { auto: true } : {}) });
      setTimeout(pollOrders, 400);
      return d.order_id;
    },
    cancel: async (id) => { try { await H.adminPost("order-change", { op: "cancel", order_id: id }); } catch (e) { if (!quiet(e)) throw e; } setTimeout(pollOrders, 400); },
    modify: async (id, { price }) => { try { await H.adminPost("order-change", { op: "modify", order_id: id, price }); } catch (e) { if (!quiet(e)) throw e; } setTimeout(pollOrders, 400); },
    placeSL: async ({ side, trigger, price, qty }) => {                 // Zerodha stop-loss order (needs the updated relay)
      const d = await H.adminPost("order", { symbol: c.symbol, side, lots: qty / c.lot, order_type: "SL", price, trigger_price: trigger, product: c.product, confirm: true });
      setTimeout(pollOrders, 400); return d.order_id;
    },
    modifySL: async (id, { trigger, price }) => { await H.adminPost("order-change", { op: "modify", order_id: id, price, trigger_price: trigger }); setTimeout(pollOrders, 400); },
  };
}
function makeEngine(c, json) {
  let was = null;
  const opts = { onChange: (e) => {
    if (e.filled && !c.filledAt) c.filledAt = Date.now();
    if (!e.live && e.state !== "idle" && !c.journaled && engine === e) { c.journaled = true; journalTrade(e, c); }
    save(); renderBracket(); drawLines(); lockSearch(); if (e.live !== was) { was = e.live; orderPanel(); }
  } };
  return json ? Bracket.restore(json, actionsFor(c), opts) : new Bracket(plan(), actionsFor(c), opts);
}
async function startBracket({ source = "manual", auto = false, signal = null } = {}) {
  const err = checkPlan(plan()) || why(); if (err) return H.toast(err.replace(/<[^>]+>/g, ""));
  const s = market.summary();
  ctx = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, symbol: target.symbol, name: target.name, lot: target.lot, token: target.token, product: F.product,
    mode: TMODE, source, auto, startedAt: Date.now(), index: IDX, type: /PE(\.NFO)?$/.test(target.symbol) ? "PE" : "CE", lots: F.lots,
    setup: source === "ai" ? "ai" : F.setup || null, mood: source === "ai" ? null : F.mood || "planned", plannedEntry: F.entry, riskAmt: tradeRisk(), hardSl: !!F.hardSl,
    expiryDay: market.chain?.expiry === new Date(Date.now() + IST * 1000).toISOString().slice(0, 10),
    signal: signal ? { confidence: signal.confidence, summary: signal.summary, reasons: (signal.reasons || []).slice(0, 5) } : null,
    mkt: { spot: market.under.spot, pcr: s?.pcr ?? null, atmIv: s?.atmIv ?? null, maxPain: s?.maxPain ?? null, support: s?.support ?? null, resistance: s?.resistance ?? null } };
  try { engine = makeEngine(ctx); } catch (e) { return H.toast(e.message); }
  Object.keys(CK).forEach((k) => (CK[k] = false)); if (source !== "ai") { F.mood = "planned"; }
  orderPanel(); renderBracket(); if (ctx.mode !== "paper") startPolling();
  await engine.start();
  if (ltp) engine.onTick(ltp);
}
// a finished bracket -> one row in the Trade summary (the server works out charges, net P&L and the AI review)
async function journalTrade(e, c) {
  const r = bracketResult(e.toJSON());
  if (!r) return;                                           // nothing was bought (entry cancelled / rejected)
  const t = { id: c.id, at: new Date(c.filledAt || c.startedAt).toISOString(), closedAt: new Date().toISOString(), mode: c.mode, source: c.source, index: c.index,
    symbol: c.symbol, name: c.name, type: c.type, qty: r.qty, lots: c.lots, entry: r.entry, exit: r.exit, exitReason: r.exitReason, chases: r.chases,
    durationSec: c.filledAt ? Math.round((Date.now() - c.filledAt) / 1000) : 0,
    mfe: c.hi != null ? Math.max(0, Math.round((c.hi - r.entry) * 100) / 100) : null, mae: c.lo != null ? Math.max(0, Math.round((r.entry - c.lo) * 100) / 100) : null,
    plan: { target: e.p.target, slTrigger: e.p.slTrigger, slLimit: e.p.slLimit, chaseSec: e.p.chaseSec }, signal: c.signal, ctx: c.mkt,
    setup: c.setup, mood: c.mood, plannedEntry: c.plannedEntry, riskAmt: c.riskAmt, hardSl: c.hardSl, expiryDay: c.expiryDay };
  const saved = await journal.add(t);
  if (saved?.net != null) H.toast(`${saved.net >= 0 ? "✅ Munafa" : "❌ Nuksan"} ${saved.net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(saved.net))} (charges ke baad) · Trade summary mein wajah dekhiye`);
  if (e.state === "error" && c.auto) ai?.stop("AI trade mein gadbad hui: AI band. Kite mein position check kariye.");
}
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(() => { pollN++; if (!wsLive || pollN % 2 === 0) pollOrders(); }, 2000); }
async function pollOrders() {
  if (ctx?.mode === "paper") return;
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
function lockSearch() {                                    // while a bracket is live: no index / expiry / strike change
  const live = !!engine?.live, l = root.querySelector("#splock");
  root.querySelectorAll("#spidx button, #spmode button").forEach((b) => (b.disabled = live)); root.querySelector("#spexp").disabled = live;
  l.hidden = !live;
  l.innerHTML = live ? `🔒 Bracket chal raha hai (${esc(ctx?.name)}), isliye index / expiry / strike badalna band hai.` : "";
}
function save() {
  try { if (!engine) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify({ ctx, b: engine.toJSON(), at: Date.now() })); } catch {}
}
function saveForm() { try { localStorage.setItem(KEY + "-form", JSON.stringify({ off: F.off, offPct: F.offPct, unit: F.unit, chase: F.chase, product: F.product, hardSl: F.hardSl, beAt: F.beAt, trailBy: F.trailBy, maxHoldMin: F.maxHoldMin, lotMode: F.lotMode })); } catch {} }
async function resume() {
  let s = null; try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  if (!s?.ctx || !s.b) return false;
  if (Date.now() - (s.at || 0) > 18 * 36e5) { try { localStorage.removeItem(KEY); } catch {} return false; }   // yesterday's trade: forget it
  ctx = s.ctx;
  try { engine = makeEngine(ctx, s.b); } catch { engine = null; return false; }
  if (ctx.mode === "paper" && paper) {                      // the pretend broker forgets on reload: give it the bracket's open orders
    const o = s.b.o || {}, open = (x) => x && /OPEN|PENDING|RECEIVED|MODIFIED/.test(x.status || "");
    paper.adopt([open(o.entry) && { id: o.entry.id, side: "BUY", price: s.b.p.entry, qty: s.b.p.qty }, open(o.target) && { id: o.target.id, side: "SELL", price: o.target.price, qty: o.target.qty },
      open(o.sl) && { id: o.sl.id, side: "SELL", price: o.sl.price, qty: o.sl.qty },
      open(o.hard) && { id: o.hard.id, side: "SELL", price: o.hard.price, trigger: o.hard.trigger, qty: o.hard.qty, status: o.hard.status }].filter(Boolean));
  }
  const key = indexOfSymbol(ctx.symbol) || IDX;             // setIndex refuses while a bracket is live, so set the index here
  IDX = key; root.querySelectorAll("#spidx button").forEach((x) => x.classList.toggle("on", x.dataset.i === key));
  root.querySelector("#spiname").textContent = INDICES[key].index;
  market.setIndex(key); loadIndexBars(); ctxbar.setIndex(key);
  await choose({ symbol: ctx.symbol, name: ctx.name, lot_size: ctx.lot, token: ctx.token, option: true }, true);
  if (engine.live) { engine.log(ctx.mode === "paper" ? "Page dobara khula: paper trade resume" : "Page dobara khula: bracket resume, Zerodha se orders check kar rahe hain"); H.toast("Pichhla trade resume kiya."); if (ctx.mode !== "paper") { startPolling(); pollOrders(); } }
  else if (!ctx.journaled && engine.state !== "idle") { ctx.journaled = true; journalTrade(engine, ctx); }
  renderBracket(); lockSearch();
  return true;
}

function renderBracket() {
  const box = root.querySelector("#spbr");
  if (!engine) { box.hidden = true; return; }
  box.hidden = false;
  const e = engine, st = e.state, tone = st === "done" ? "pos" : st === "error" ? "neg" : st === "stopped" ? "neu" : "live";
  const row = (label, o) => o ? `<tr><td>${label}</td><td class="r">${f2(o.price ?? e.p.entry)}</td><td class="r">${o.qty ?? e.p.qty}</td><td><span class="sp-ost ${/COMPLETE/.test(o.status) ? "pos" : /CANCEL|REJECT/.test(o.status) ? "neg" : ""}">${esc(o.status)}</span>${o.filled ? ` <small>${o.filled} bhara</small>` : ""}</td><td class="id">${esc(o.id)}</td></tr>` : "";
  box.innerHTML = `<div class="panel-h"><h2>Bracket</h2><span class="pill ${ctx?.mode === "real" ? "p-pos" : "p-soon"}">${ctx?.mode === "real" ? "ASLI" : "PAPER"}</span>${ctx?.source === "ai" ? `<span class="pill p-opt">🤖 AI</span>` : ""}<span class="right"><span class="sp-badge ${tone}">${esc(STATE_TXT[st] || st)}</span></span></div>
    <div class="panel-b">
      <div class="sp-bsum tnum"><span>${esc(ctx?.name || "")}</span><span>Qty <b>${e.p.qty}</b></span><span>Entry <b>${f2(e.p.entry)}</b></span>${e.p.target != null ? `<span>T <b class="up">${f2(e.p.target)}</b></span>` : ""}${e.p.slTrigger != null ? `<span>Trig <b>${f2(e.p.slTrigger)}</b> → SL <b class="down">${f2(e.p.slLimit)}</b></span>` : ""}<span>Chase <b>${e.p.chaseSec}s</b></span><span id="sppnl"></span></div>
      ${e.reason && !e.live ? `<div class="${st === "error" ? "sp-err" : "sp-ok"}">${esc(e.reason)}${st === "error" ? ". Kite app mein turant orders/positions dekhiye." : ""}</div>` : ""}
      <table class="tbl sp-ot tnum"><thead><tr><th>Order</th><th class="r">Daam</th><th class="r">Qty</th><th>Status</th><th>ID</th></tr></thead><tbody>${row("Entry BUY", e.o.entry ? { ...e.o.entry, price: e.p.entry } : null)}${row("Target SELL", e.o.target)}${row(`🛡 Zerodha SL ${e.o.hard ? "(trig " + f2(e.o.hard.trigger) + ")" : ""}`, e.o.hard)}${row(e.o.sl?.exit ? "Exit SELL" : "SL SELL", e.o.sl)}</tbody></table>
      ${e.p.hardSl === false && e.hardFailed ? `<div class="sp-warn">⚠ Zerodha SL nahi laga (relay purana?). Ab SL is page se chal raha hai: page khula rakhiye.</div>` : ""}
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
  b("spnew", () => { engine = null; ctx = null; paper = null; F.entryTouched = false; F.entry = null; save(); renderBracket(); lockSearch(); orderPanel(); drawLines(); market.draw(); });
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
#spchart{height:360px;position:relative}#spichart{height:250px;position:relative}
@media(max-width:760px){#spchart{height:280px}#spichart{height:200px}}
.sp-idx button{font-weight:700;padding:0 14px}.sp-mode button{font-weight:700}.sp-mode button[data-m=real].on{background:var(--neg);color:#fff;box-shadow:none}
.sp-quick{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--line)}.sp-quick .btn2.sm{height:26px;padding:0 9px}
.sp-qg{font-weight:800;font-size:12px;margin-left:6px}.sp-keys{margin-left:auto;font-size:11px;color:var(--muted)}
.sp-tags{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sp-tags label{display:grid;gap:3px;font-size:11px;color:var(--muted)}.sp-tags .sel{height:32px}
.sp-check{display:grid;gap:5px;border:1px dashed var(--line-2);border-radius:var(--r-sm);padding:8px 10px}.sp-ck{display:flex;gap:8px;align-items:center;font-size:12.5px;cursor:pointer}
@media(max-width:760px){.sp-keys{display:none}}
.sp-adv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.sp-adv label{display:grid;gap:3px;font-size:11px;color:var(--muted)}.sp-adv .field{height:32px;text-align:right}.sp-adv small{font-size:10.5px}
.sp-note{font-size:11.5px;color:var(--text-2);line-height:1.45;margin-top:-4px}.sp-note:empty{display:none}
.sp-gm{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;opacity:.85}.sp-go{flex-direction:column;gap:0}.sp-exp{display:inline-flex;align-items:center;gap:6px}.sp-exp .sel{height:30px;width:auto}
.sp-chipsb{padding:10px 14px 4px}
.sp-empty{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:var(--muted)}
.sp-ba{display:flex;gap:16px;flex-wrap:wrap;padding:8px 14px 0;font-size:12px;color:var(--muted)}.sp-ba b{color:var(--ink);font-weight:600}
.sp-form{display:grid;gap:10px}
.sp-row{display:grid;grid-template-columns:118px minmax(0,1fr);align-items:center;gap:8px}
.sp-in{display:flex;gap:6px;align-items:center;min-width:0}
.sp-in .field{text-align:right;font-variant-numeric:tabular-nums;min-width:0}
.sp-pts{display:flex;align-items:center;gap:3px;flex:none;width:96px}
.sp-pts i{font-style:normal;font-weight:700;font-size:13px;color:var(--muted);width:9px;text-align:center}
.sp-pts.up i{color:var(--pos)}.sp-pts.down i{color:var(--neg)}
.sp-pts .sp-u{font-size:12px;color:var(--muted);width:10px;font-weight:600}
.sp-pts .field{height:32px;padding:0 6px;font-size:12.5px;text-align:right}
.sp-off{font-size:12px;color:var(--muted);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
.sp-sum{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 10px;font-size:12px;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2)}
.sp-sum span{color:var(--muted)}.sp-ch{grid-column:1/-1;font-size:11px;color:var(--muted);margin:-2px 0 2px}.sp-ch:empty{display:none}.sp-sum b{font-weight:600}
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
