// Full live chart page: chart.html?sym=ITC.NS&name=ITC
// History: GET /api/candles (Zerodha historical, minute..day). Live: Zerodha WebSocket ticks (admin only) build
// the running candle, and the 1s/5s/10s/30s candles (those exist only from when this page was opened).
import { createChart, CrosshairMode, LineStyle } from "./vendor/lightweight-charts-4.2.3.mjs";
import { parseTicks, applyTick, barsFromTicks, IST } from "./kiteticks.mjs";

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const SYM = qs.get("sym") || "", NAME = qs.get("name") || SYM.replace(/\.(NS|BO|NFO)$/i, "");
const WSBASE = (location.hostname === "localhost" && qs.get("wsurl")) || "wss://ws.kite.trade";   // test hook: localhost only
const f2 = (v) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fv = (v) => (v == null ? "–" : v >= 1e7 ? (v / 1e7).toFixed(2) + "Cr" : v >= 1e5 ? (v / 1e5).toFixed(2) + "L" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v)));

const TFS = [
  { k: "1s", sec: 1, live: true }, { k: "5s", sec: 5, live: true }, { k: "10s", sec: 10, live: true }, { k: "30s", sec: 30, live: true },
  { k: "1m", sec: 60, api: "minute" }, { k: "3m", sec: 180, api: "3minute" }, { k: "5m", sec: 300, api: "5minute" }, { k: "10m", sec: 600, api: "10minute" },
  { k: "15m", sec: 900, api: "15minute" }, { k: "30m", sec: 1800, api: "30minute" }, { k: "1h", sec: 3600, api: "60minute" }, { k: "1D", sec: 86400, api: "day" },
];
let tf = TFS.find((t) => t.k === (qs.get("tf") || "5m")) || TFS[6];
let ctype = "candle", bars = [], prevClose = null, token = null, source = "", lastCum = null;
const ticks = [];                                          // live ticks since the page opened: {ms, price, dv}
const ind = { vol: true, sma: false, ema: false, vwap: false, bb: false };
let wsLive = false, pollTimer = null, ws = null, retry = 0;

$("name").textContent = NAME;
document.title = `${NAME} · Live Chart`;

// ---------- chart ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const chart = createChart($("chart"), {
  autoSize: true,
  layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
  grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: css("--line") },
  timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, rightOffset: 6 },
  localization: { priceFormatter: (p) => f2(p) },
});
let main = null, vol = null, lines = {};
function themeChart() {
  chart.applyOptions({ layout: { textColor: css("--muted") }, grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") } });
  buildSeries(); draw();
}
function buildSeries() {
  if (main) chart.removeSeries(main);
  if (vol) { chart.removeSeries(vol); vol = null; }
  for (const s of Object.values(lines).flat()) chart.removeSeries(s);
  lines = {};
  const up = css("--pos"), dn = css("--neg"), pf = { type: "price", precision: 2, minMove: 0.05 };
  if (ctype === "candle") main = chart.addCandlestickSeries({ upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn, priceFormat: pf });
  else if (ctype === "hollow") main = chart.addCandlestickSeries({ upColor: "transparent", downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceFormat: pf });
  else if (ctype === "line") main = chart.addLineSeries({ color: css("--accent"), lineWidth: 2, priceFormat: pf });
  else main = chart.addAreaSeries({ lineColor: css("--accent"), topColor: css("--accent-soft"), bottomColor: "transparent", lineWidth: 2, priceFormat: pf });
  main.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: ind.vol ? 0.22 : 0.06 } });
  if (ind.vol) {
    vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }
  const L = (color, style = LineStyle.Solid) => chart.addLineSeries({ color, lineWidth: 1.5, lineStyle: style, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  if (ind.sma) lines.sma = [L("#e5a93b")];
  if (ind.ema) lines.ema = [L("#c084fc")];
  if (ind.vwap && tf.sec < 86400) lines.vwap = [L("#22d3ee")];
  if (ind.bb) lines.bb = [L("#94a3b8", LineStyle.Dashed), L("#94a3b8"), L("#94a3b8", LineStyle.Dashed)];
}
const point = (b) => (ctype === "candle" || ctype === "hollow" ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close } : { time: b.time, value: b.close });
const volPoint = (b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? css("--pos-soft") : css("--neg-soft") });

// ---------- studies ----------
function sma(n) { const o = []; let s = 0; bars.forEach((b, i) => { s += b.close; if (i >= n) s -= bars[i - n].close; if (i >= n - 1) o.push({ time: b.time, value: s / n }); }); return o; }
function ema(n) { const o = [], k = 2 / (n + 1); let e = null; bars.forEach((b, i) => { e = e == null ? b.close : b.close * k + e * (1 - k); if (i >= n - 1) o.push({ time: b.time, value: e }); }); return o; }
function vwap() { const o = []; let day = null, pv = 0, v = 0;
  for (const b of bars) { const d = Math.floor(b.time / 86400); if (d !== day) { day = d; pv = 0; v = 0; }
    const w = b.volume || 0, tp = (b.high + b.low + b.close) / 3; pv += tp * w; v += w; o.push({ time: b.time, value: v ? pv / v : tp }); } return o; }
function bb(n = 20, m = 2) { const u = [], mid = [], lo = []; for (let i = n - 1; i < bars.length; i++) {
    const w = bars.slice(i - n + 1, i + 1).map((b) => b.close), a = w.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(w.reduce((x, y) => x + (y - a) ** 2, 0) / n);
    u.push({ time: bars[i].time, value: a + m * sd }); mid.push({ time: bars[i].time, value: a }); lo.push({ time: bars[i].time, value: a - m * sd }); } return [u, mid, lo]; }
function studies(full) {
  const set = (s, data) => (full ? s.setData(data) : data.length && s.update(data[data.length - 1]));
  if (lines.sma) set(lines.sma[0], sma(20));
  if (lines.ema) set(lines.ema[0], ema(50));
  if (lines.vwap) set(lines.vwap[0], vwap());
  if (lines.bb) bb().forEach((d, i) => set(lines.bb[i], d));
}

// ---------- drawing ----------
function draw(fit = false) {
  main.setData(bars.map(point));
  if (vol) vol.setData(bars.map(volPoint));
  studies(true);
  if (fit) chart.timeScale().fitContent();
  legend(bars[bars.length - 1]);
  overlay();
}
function legend(b) {
  if (!b) { $("legend").innerHTML = ""; return; }
  const c = b.close >= b.open ? "up" : "down";
  $("legend").innerHTML = `<span>O <b class="${c}">${f2(b.open)}</b></span><span>H <b class="${c}">${f2(b.high)}</b></span><span>L <b class="${c}">${f2(b.low)}</b></span><span>C <b class="${c}">${f2(b.close)}</b></span>${b.volume ? `<span>V <b>${fv(b.volume)}</b></span>` : ""}`;
}
chart.subscribeCrosshairMove((p) => {
  if (!p.time) return legend(bars[bars.length - 1]);
  legend(bars.find((b) => b.time === p.time) || bars[bars.length - 1]);
});
function overlay() {
  let msg = "";
  if (tf.live && !wsLive) msg = `<b>Seconds wale chart ke liye live ticks chahiye</b>Dashboard ke API Keys page par admin login aur aaj ka "Login with Zerodha" kariye, phir ye page dobara kholiye.`;
  else if (tf.live && !bars.length) msg = `<b>Live ticks ka intezaar…</b>${tf.k} candles page khulne ke baad ke ticks se bante hain. Market band ho to ticks nahi aate.`;
  else if (!bars.length && !tf.live) msg = `<b>Is timeframe ka data nahi mila</b>Koi aur timeframe try kariye.`;
  $("overlay").hidden = !msg; $("otext").innerHTML = msg;
}
function header(last) {
  if (last == null) return;
  $("ltp").textContent = f2(last);
  if (prevClose) { const c = last - prevClose; $("chg").className = "chg " + (c >= 0 ? "up" : "down");
    $("chg").textContent = `${c >= 0 ? "+" : ""}${f2(c)} (${c >= 0 ? "+" : ""}${(c / prevClose * 100).toFixed(2)}%)`; }
}
function status(kind, text) { $("sdot").className = "dot " + kind; $("stext").textContent = text; }

// ---------- data ----------
async function loadHistory() {
  const r = await fetch(`/api/candles?sym=${encodeURIComponent(SYM)}&interval=${tf.api}`, { cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  token ??= d.instrument_token; prevClose = d.prevClose ?? prevClose; source = d.source;
  $("foot").textContent = `Prices: ${d.source}${d.notice ? " · " + d.notice : ""} · Not investment advice.`;
  bars = d.candles.map(([t, o, h, l, c, v]) => ({ time: t + IST, open: o, high: h, low: l, close: c, volume: v }));
  if (tf.sec === 86400) bars.forEach((b) => (b.time = Math.floor(b.time / 86400) * 86400));   // day candle = IST date
  header(d.last ?? bars[bars.length - 1]?.close);
  return d;
}
async function select(next) {
  tf = next;
  document.querySelectorAll("#tf button").forEach((b) => b.classList.toggle("on", b.dataset.k === tf.k));
  chart.applyOptions({ timeScale: { secondsVisible: tf.sec < 60 } });
  history.replaceState(null, "", `?sym=${encodeURIComponent(SYM)}&name=${encodeURIComponent(NAME)}&tf=${tf.k}${qs.get("wsurl") ? "&wsurl=" + encodeURIComponent(qs.get("wsurl")) : ""}`);
  clearInterval(pollTimer);
  buildSeries();
  if (tf.live) { bars = barsFromTicks(ticks, tf.sec); draw(true); return; }
  try { await loadHistory(); draw(true); }
  catch (e) { bars = []; draw(); $("overlay").hidden = false; $("otext").innerHTML = `<b>Chart nahi aaya</b>${String(e.message).replace(/</g, "&lt;")}`; }
  if (!wsLive) pollTimer = setInterval(async () => { try { const keep = chart.timeScale().getVisibleLogicalRange(); await loadHistory(); draw(); if (keep) chart.timeScale().setVisibleLogicalRange(keep); } catch {} }, 20000);
}

// ---------- live ticks (Zerodha WebSocket) ----------
function onTick(t) {
  if (t.token !== token) return;
  const ms = Date.now(), dv = t.volume != null && lastCum != null ? Math.max(0, t.volume - lastCum) : 0;
  if (t.volume != null) lastCum = t.volume;
  if (!prevClose && t.close) prevClose = t.close;
  ticks.push({ ms, price: t.ltp, dv }); if (ticks.length > 200000) ticks.splice(0, 50000);
  header(t.ltp);
  const before = bars.length, bar = applyTick(bars, ms, t.ltp, dv, tf.sec);
  if (!bar) return;
  if (before === 0) { draw(true); return; }
  main.update(point(bar)); if (vol) vol.update(volPoint(bar)); studies(false);
  if (!$("overlay").hidden) overlay();
  legend(bar);
}
async function connect() {
  let auth;
  try { const r = await fetch("/api/admin/ticker", { cache: "no-store", credentials: "same-origin" }); auth = await r.json(); if (!r.ok) throw new Error(auth.error || r.status); }
  catch (e) { wsLive = false; status("warn", "Delayed · 20s refresh"); $("status").title = String(e.message); overlay(); return; }
  if (!token) { try { await loadHistory(); } catch {} }
  ws = new WebSocket(`${WSBASE}?api_key=${encodeURIComponent(auth.api_key)}&access_token=${encodeURIComponent(auth.access_token)}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ a: "subscribe", v: [token] })); ws.send(JSON.stringify({ a: "mode", v: ["quote", [token]] }));
    wsLive = true; clearInterval(pollTimer); status("live", "Live · Zerodha ticks"); overlay(); };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") { try { const m = JSON.parse(e.data); if (m.type === "error") status("warn", "Zerodha: " + m.data); } catch {} return; }
    for (const t of parseTicks(e.data)) onTick(t);
  };
  ws.onclose = () => { const was = wsLive; wsLive = false; status("warn", "Reconnecting…");
    if (!tf.live && was) select(tf);                        // fall back to refresh while we reconnect
    setTimeout(connect, Math.min(30000, 2000 * 2 ** retry++)); };
}

// ---------- controls ----------
$("tf").innerHTML = TFS.map((t) => `<button data-k="${t.k}" class="${t.k === tf.k ? "on" : ""}${t.live ? " live" : ""}" title="${t.live ? "Live ticks se" : "Zerodha history + live"}">${t.k}</button>`).join("");
$("tf").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.k !== tf.k) select(TFS.find((t) => t.k === b.dataset.k)); };
$("ctype").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; ctype = b.dataset.t;
  $("ctype").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); buildSeries(); draw(); };
document.querySelectorAll(".ind[data-i]").forEach((b) => (b.onclick = () => { ind[b.dataset.i] = !ind[b.dataset.i]; b.classList.toggle("on", ind[b.dataset.i]); buildSeries(); draw(); }));
$("fit").onclick = () => chart.timeScale().fitContent();
$("fs").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
$("theme").onclick = () => { const t = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t;
  try { localStorage.setItem("sb-theme", t); } catch {} themeChart(); };

if (!SYM) { $("overlay").hidden = false; $("otext").innerHTML = "<b>Koi stock nahi chuna</b>Dashboard par Quote mein stock kholkar \"Launch chart\" dabaiye."; }
else { select(tf).then(connect); }
