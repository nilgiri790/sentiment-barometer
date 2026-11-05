// Backtest page: search -> chart + past data -> create strategy (template or AI) -> backtest results -> ask AI about the data.
// Loaded only when the page is opened. Data: /api/candles. AI: /api/admin/ai (admin only). Engine: ./btengine.mjs.
import { createChart, CrosshairMode } from "./vendor/lightweight-charts-4.2.3.mjs";
import { backtest, TEMPLATES, describeRule, sma, ema, bands, validateStrategy } from "./btengine.mjs";
import { IST } from "./kiteticks.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fr = (v) => (v == null || !Number.isFinite(v) ? "–" : "₹" + Math.round(v).toLocaleString("en-IN"));
const pc = (v) => (v == null || !Number.isFinite(v) ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const fv = (v) => (v >= 1e7 ? (v / 1e7).toFixed(2) + " Cr" : v >= 1e5 ? (v / 1e5).toFixed(2) + " L" : Math.round(v).toLocaleString("en-IN"));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const TFS = [{ k: "1D", api: "day", sec: 86400 }, { k: "1h", api: "60minute", sec: 3600 }, { k: "15m", api: "15minute", sec: 900 }, { k: "5m", api: "5minute", sec: 300 }, { k: "1m", api: "minute", sec: 60 }];
const PROMPTS = ["Trend kya hai aur kitna strong hai?", "Support aur resistance levels batao", "Volatility aur risk samjhao", "Pichhle 1 mahine mein kya hua?", "Volume mein koi khaas baat?", "Is strategy ke results samjhao"];
const dstr = (t, day) => { const d = new Date(t * 1000).toISOString(); return day ? d.slice(0, 10) : d.slice(0, 16).replace("T", " "); };   // t already IST-shifted

let H, root, chart, main, vol, overlays = [], eqChart = null;
let target = null, tf = TFS[0], bars = [], raw = [], meta = {}, strategy = null, mode = "template", result = null;
try { const s = JSON.parse(localStorage.getItem("sb-bt-strategy") || "null"); if (s && !validateStrategy(s).error) strategy = s; } catch {}

export function mountBacktest(el, helpers) {
  H = helpers; root = el;
  root.innerHTML = `
    <div class="page-head"><div><h1>Backtest</h1><p class="sub">Kisi bhi share, index ya option ka purana data dekhiye, strategy banakar test kariye, aur AI se data samjhiye.</p></div></div>
    <section class="panel"><div class="panel-b">
      <div class="btbar">
        <form class="search" id="bform"><div class="in"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q3" placeholder="Search: ITC, Bank Nifty, banknifty 52000 ce" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="ac3" aria-expanded="false"><div class="ac" id="ac3" role="listbox" hidden></div></div><button>Search</button></form>
        <div class="seg" id="btf">${TFS.map((t) => `<button type="button" data-k="${t.k}" class="${t.k === tf.k ? "on" : ""}">${t.k}</button>`).join("")}</div>
      </div>
      <div class="note" id="bthint">1D = lagbhag 2 saal, 1h = 4 mahine, 15m = 45 din, 5m = 15 din, 1m = 4 din ka data (Zerodha ki seema).</div>
    </div></section>
    <section class="panel" id="btchartp" hidden>
      <div class="panel-h"><h2 id="btname">–</h2><span class="right"><span class="ltp tnum" id="btlast"></span><span class="chg tnum" id="btchg"></span><span class="label" id="btsrc"></span></span></div>
      <div class="btlegend tnum" id="btleg"></div><div id="btchart"></div>
    </section>
    <div class="grid2 bt2" id="btmid" hidden>
      <section class="panel" id="btsum"></section>
      <section class="panel" id="btstrat"></section>
    </div>
    <section class="panel" id="btres" hidden></section>
    <section class="panel" id="btai" hidden></section>
    <footer>Backtest purane data par hai. Purane nateeje aage ki guarantee nahi hain. Ye investment advice nahi hai.</footer>`;
  const qIn = root.querySelector("#q3");
  const ac = H.makeAC(qIn, root.querySelector("#ac3"), { onChoose: (o) => { qIn.value = o.option ? o.name : o.symbol.replace(/\.(NS|BO)$/i, ""); choose(o); } });
  root.querySelector("#bform").onsubmit = async (e) => {
    e.preventDefault(); if (ac.openWithSel()) return ac.pickSel();
    const q = qIn.value.trim(); if (!q) return; ac.cancel();
    const list = await H.suggest(q); if (list.length) { qIn.value = list[0].option ? list[0].name : list[0].symbol.replace(/\.(NS|BO)$/i, ""); choose(list[0]); }
    else H.toast(`"${q}" nahi mila.`);
  };
  root.querySelector("#btf").onclick = (e) => { const b = e.target.closest("button"); if (!b || b.dataset.k === tf.k) return; tf = TFS.find((t) => t.k === b.dataset.k);
    root.querySelectorAll("#btf button").forEach((x) => x.classList.toggle("on", x === b)); if (target) load(); };
}
export function onShowBacktest() { if (target) { strategyPanel(); aiPanel(); } }

function choose(o) { target = { symbol: o.symbol, name: o.option ? o.name : o.name || o.symbol, option: !!o.option, index: !!o.index }; result = null; load(); }

async function load() {
  root.querySelector("#btchartp").hidden = false; root.querySelector("#btname").textContent = target.name;
  root.querySelector("#btleg").innerHTML = `<span class="note">Data aa raha hai…</span>`;
  let d;
  try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(target.symbol)}&interval=${tf.api}`, { cache: "no-store" }); d = await r.json(); if (!r.ok) throw new Error(d.error || `Error ${r.status}`); }
  catch (e) { root.querySelector("#btleg").innerHTML = `<span class="kres bad">Data nahi aaya: ${esc(e.message)}</span>`; ["#btmid", "#btres", "#btai"].forEach((s) => (root.querySelector(s).hidden = true)); return; }
  meta = d; raw = d.candles;
  bars = d.candles.map(([t, o, h, l, c, v]) => ({ time: tf.sec === 86400 ? Math.floor((t + IST) / 86400) * 86400 : t + IST, open: o, high: h, low: l, close: c, volume: v || 0 }));
  root.querySelector("#btsrc").textContent = `${d.source}${d.notice ? " · " + d.notice : ""}`;
  const last = bars[bars.length - 1]?.close, chg = d.prevClose && last ? last - d.prevClose : null;
  root.querySelector("#btlast").textContent = f2(last);
  const ce = root.querySelector("#btchg"); ce.className = "chg tnum " + (chg >= 0 ? "up" : "down"); ce.textContent = chg == null ? "" : `${chg >= 0 ? "+" : ""}${f2(chg)} (${pc((chg / d.prevClose) * 100)})`;
  drawChart(); summary();
  root.querySelector("#btmid").hidden = false; root.querySelector("#btai").hidden = false;
  strategyPanel(); aiPanel();
  if (result) runBacktest(); else root.querySelector("#btres").hidden = true;
}

// ---------- chart ----------
function drawChart() {
  const el = root.querySelector("#btchart");
  if (!chart) {
    chart = createChart(el, { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: "rgba(125,135,153,.08)" }, horzLines: { color: "rgba(125,135,153,.08)" } }, crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { priceFormatter: (p) => f2(p) } });
    chart.subscribeCrosshairMove((p) => legend(p.time ? bars.find((b) => b.time === p.time) : bars[bars.length - 1]));
  }
  if (main) chart.removeSeries(main); if (vol) chart.removeSeries(vol); overlays.forEach((s) => chart.removeSeries(s)); overlays = [];
  const up = css("--pos"), dn = css("--neg");
  main = chart.addCandlestickSeries({ upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn, priceFormat: { type: "price", precision: 2, minMove: 0.05 } });
  main.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
  vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  main.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  vol.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? css("--pos-soft") : css("--neg-soft") })));
  chart.applyOptions({ timeScale: { timeVisible: tf.sec < 86400 } });
  chart.timeScale().fitContent();
  legend(bars[bars.length - 1]);
}
function legend(b) {
  if (!b) return;
  const c = b.close >= b.open ? "up" : "down";
  root.querySelector("#btleg").innerHTML = `<span>${esc(dstr(b.time, tf.sec === 86400))}</span><span>O <b class="${c}">${f2(b.open)}</b></span><span>H <b class="${c}">${f2(b.high)}</b></span><span>L <b class="${c}">${f2(b.low)}</b></span><span>C <b class="${c}">${f2(b.close)}</b></span><span>V <b>${fv(b.volume)}</b></span>`;
}
function drawOverlays(s) {                                   // show the strategy's moving averages / bands on the chart
  overlays.forEach((x) => chart.removeSeries(x)); overlays = [];
  const C = bars.map((b) => b.close), seen = new Set(), colors = ["#e5a93b", "#c084fc", "#22d3ee", "#94a3b8"];
  const ops = [...s.entry.all, ...s.exit.any].flatMap((r) => [r.left, r.right]).filter((o) => o.ind && /^(sma|ema|bb_)/.test(o.ind));
  for (const o of ops) {
    const id = `${o.ind.startsWith("bb_") ? "bb" : o.ind}:${o.n}:${o.k || ""}`; if (seen.has(id)) continue; seen.add(id);
    const add = (vals, color, dashed) => { const l = chart.addLineSeries({ color, lineWidth: 1.5, lineStyle: dashed ? 2 : 0, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      l.setData(vals.map((v, i) => (v == null ? null : { time: bars[i].time, value: v })).filter(Boolean)); overlays.push(l); };
    const col = colors[overlays.length % colors.length];
    if (o.ind === "sma") add(sma(C, o.n), col); else if (o.ind === "ema") add(ema(C, o.n), col);
    else { const b = bands(C, o.n, o.k || 2); add(b.up, "#94a3b8", true); add(b.mid, "#94a3b8"); add(b.lo, "#94a3b8", true); }
  }
}

// ---------- data summary ----------
function stats() {
  if (!bars.length) return {};
  const C = bars.map((b) => b.close), rets = C.slice(1).map((c, i) => (c / C[i] - 1) * 100);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1), sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
  let peak = C[0], dd = 0; for (const c of C) { peak = Math.max(peak, c); dd = Math.max(dd, (peak - c) / peak * 100); }
  const hi = bars.reduce((a, b) => (b.high > a.high ? b : a)), lo = bars.reduce((a, b) => (b.low < a.low ? b : a)), day = tf.sec === 86400;
  const s50 = sma(C, 50).at(-1), s200 = sma(C, 200).at(-1);
  return { from: dstr(bars[0].time, day), to: dstr(bars.at(-1).time, day), candles: bars.length, firstClose: C[0], lastClose: C.at(-1),
    changePct: (C.at(-1) / C[0] - 1) * 100, high: hi.high, highOn: dstr(hi.time, day), low: lo.low, lowOn: dstr(lo.time, day),
    avgVolume: bars.reduce((a, b) => a + b.volume, 0) / bars.length, volatilityPctPerCandle: sd, maxDrawdownPct: dd,
    sma50: s50, sma200: s200 };
}
function summary() {
  const s = stats(), day = tf.sec === 86400;
  const recent = bars.slice(-30).reverse();
  root.querySelector("#btsum").innerHTML = `<div class="panel-h"><h2>Purana data</h2><span class="right"><button class="btn2 sm" type="button" id="btcsv">CSV download</button></span></div>
    <div class="panel-b"><div class="kvg">
      <span>Period</span><b>${esc(s.from)} → ${esc(s.to)}</b><span>Candles</span><b>${s.candles} (${tf.k})</b>
      <span>Badlav</span><b class="${s.changePct >= 0 ? "up" : "down"}">${pc(s.changePct)}</b><span>High</span><b>${f2(s.high)} <small>${esc(s.highOn)}</small></b>
      <span>Low</span><b>${f2(s.low)} <small>${esc(s.lowOn)}</small></b><span>Sabse bada girav</span><b class="down">-${s.maxDrawdownPct.toFixed(2)}%</b>
      <span>Volatility</span><b>${s.volatilityPctPerCandle.toFixed(2)}% / candle</b><span>Avg volume</span><b>${fv(s.avgVolume)}</b>
      ${day && s.sma200 ? `<span>SMA 50 / 200</span><b>${f2(s.sma50)} / ${f2(s.sma200)}</b>` : ""}
    </div></div>
    <div class="scroll" style="max-height:280px"><table class="tbl"><thead><tr><th>${day ? "Date" : "Time"}</th><th class="r">Open</th><th class="r">High</th><th class="r">Low</th><th class="r">Close</th><th class="r hide-m">Volume</th></tr></thead><tbody>
      ${recent.map((b) => `<tr><td class="src when">${esc(dstr(b.time, day))}</td><td class="r tnum">${f2(b.open)}</td><td class="r tnum">${f2(b.high)}</td><td class="r tnum">${f2(b.low)}</td><td class="r tnum ${b.close >= b.open ? "up" : "down"}">${f2(b.close)}</td><td class="r tnum hide-m">${fv(b.volume)}</td></tr>`).join("")}
    </tbody></table></div>`;
  root.querySelector("#btcsv").onclick = () => {
    const csv = ["date,open,high,low,close,volume", ...bars.map((b) => `${dstr(b.time, day)},${b.open},${b.high},${b.low},${b.close},${b.volume}`)].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `${target.name.replace(/[^\w-]+/g, "_")}_${tf.k}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

// ---------- create strategy ----------
let tplKey = "sma_cross", tplParams = { ...TEMPLATES.sma_cross.params }, risk = { sl: "", tp: "", hold: "", capital: 100000, cost: 0.05 };
function currentStrategy() {
  const base = mode === "template" ? TEMPLATES[tplKey].build(tplParams) : strategy;
  if (!base) return null;
  return { ...base, stopLossPct: risk.sl === "" ? null : +risk.sl, takeProfitPct: risk.tp === "" ? null : +risk.tp, maxHoldBars: risk.hold === "" ? null : +risk.hold };
}
function strategyPanel() {
  const el = root.querySelector("#btstrat"), admin = H.isAdmin();
  const s = currentStrategy(), v = s ? validateStrategy(s) : { error: "AI se strategy banaiye" };
  const rules = v.strategy ? `<div class="rules"><div><span class="label up">Entry (sab sach hon)</span>${v.strategy.entry.all.map((r) => `<div>• ${esc(describeRule(r))}</div>`).join("")}</div>
      <div><span class="label down">Exit (koi ek)</span>${v.strategy.exit.any.map((r) => `<div>• ${esc(describeRule(r))}</div>`).join("") || "<div>–</div>"}${v.strategy.stopLossPct ? `<div>• Stop-loss ${v.strategy.stopLossPct}%</div>` : ""}${v.strategy.takeProfitPct ? `<div>• Target ${v.strategy.takeProfitPct}%</div>` : ""}${v.strategy.maxHoldBars ? `<div>• Max ${v.strategy.maxHoldBars} candles</div>` : ""}</div></div>` : `<div class="note">${esc(v.error)}</div>`;
  el.innerHTML = `<div class="panel-h"><h2>Create strategy</h2><span class="right"><div class="seg" id="bmode"><button type="button" data-m="template" class="${mode === "template" ? "on" : ""}">Template</button><button type="button" data-m="ai" class="${mode === "ai" ? "on" : ""}">AI se banaiye</button></div></span></div>
    <div class="panel-b">
      ${mode === "template" ? `<label class="lf"><span class="label">Strategy</span><select class="field" id="btpl">${Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}"${k === tplKey ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
        <div class="pgrid">${Object.entries(tplParams).map(([k, val]) => `<label class="lf"><span class="label">${esc(k)}</span><input class="field" type="number" step="any" data-p="${k}" value="${val}"></label>`).join("")}</div>`
      : `<label class="lf"><span class="label">Strategy apne shabdon mein</span><textarea class="field ta" id="btsp" rows="3" placeholder="Jaise: jab RSI 14 30 se neeche jaaye tab khareedo, RSI 60 ke upar ho ya 3% loss ho to becho">${esc(root.querySelector("#btsp")?.value || "")}</textarea></label>
        <div class="kbtns" style="margin-top:8px">${admin ? `<button class="btn2" type="button" id="btmk">AI se strategy banaiye</button>` : `<span class="note" style="margin:0">AI ke liye <a href="#/keys">API Keys</a> mein login kariye.</span>`}<span class="note" id="btmkmsg" style="margin:0"></span></div>`}
      <div class="pgrid" style="margin-top:12px">
        <label class="lf"><span class="label">Stop-loss %</span><input class="field" type="number" step="any" min="0" data-r="sl" value="${risk.sl}" placeholder="–"></label>
        <label class="lf"><span class="label">Target %</span><input class="field" type="number" step="any" min="0" data-r="tp" value="${risk.tp}" placeholder="–"></label>
        <label class="lf"><span class="label">Max hold (candles)</span><input class="field" type="number" step="1" min="1" data-r="hold" value="${risk.hold}" placeholder="–"></label>
        <label class="lf"><span class="label">Capital ₹</span><input class="field" type="number" step="1000" min="1000" data-r="capital" value="${risk.capital}"></label>
        <label class="lf"><span class="label">Kharcha % (har taraf)</span><input class="field" type="number" step="0.01" min="0" data-r="cost" value="${risk.cost}"></label>
      </div>
      ${rules}
      <div class="kbtns"><button class="btn" type="button" id="btrun" ${v.strategy ? "" : "disabled"}>Run backtest</button></div>
    </div>`;
  el.querySelector("#bmode").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; mode = b.dataset.m; strategyPanel(); };
  el.querySelector("#btpl")?.addEventListener("change", (e) => { tplKey = e.target.value; tplParams = { ...TEMPLATES[tplKey].params }; strategyPanel(); });
  el.querySelectorAll("[data-p]").forEach((i) => (i.onchange = () => { tplParams[i.dataset.p] = +i.value; strategyPanel(); }));
  el.querySelectorAll("[data-r]").forEach((i) => (i.onchange = () => { risk[i.dataset.r] = i.dataset.r === "capital" || i.dataset.r === "cost" ? +i.value : i.value; strategyPanel(); }));
  el.querySelector("#btrun").onclick = runBacktest;
  if (el.querySelector("#btmk")) el.querySelector("#btmk").onclick = async () => {
    const b = el.querySelector("#btmk"), prompt = el.querySelector("#btsp").value.trim(); if (!prompt) return H.toast("Pehle strategy likhiye.");
    b.disabled = true; el.querySelector("#btmkmsg").textContent = "AI strategy bana raha hai…";
    try { const d = await H.adminPost("ai", { mode: "strategy", prompt, interval: tf.api }); strategy = d.strategy;
      risk.sl = d.strategy.stopLossPct ?? ""; risk.tp = d.strategy.takeProfitPct ?? ""; risk.hold = d.strategy.maxHoldBars ?? "";
      try { localStorage.setItem("sb-bt-strategy", JSON.stringify(d.strategy)); } catch {}
      strategyPanel(); runBacktest(); }
    catch (e) { el.querySelector("#btmkmsg").textContent = ""; b.disabled = false; H.toast(e.message); }
  };
}

// ---------- results ----------
function runBacktest() {
  const s = currentStrategy(); if (!s || !bars.length) return;
  result = backtest(bars, s, { capital: risk.capital || 100000, costPct: risk.cost ?? 0.05 });
  const el = root.querySelector("#btres"); el.hidden = false;
  if (result.error) { el.innerHTML = `<div class="panel-b"><div class="kres bad">${esc(result.error)}</div></div>`; return; }
  const st = result.stats, day = tf.sec === 86400;
  drawOverlays(result.strategy);
  main.setMarkers(result.trades.flatMap((t) => [
    { time: t.entryTime, position: "belowBar", color: css("--pos"), shape: "arrowUp", text: "B" },
    { time: t.exitTime, position: "aboveBar", color: css("--neg"), shape: "arrowDown", text: t.reason === "stop-loss" ? "SL" : t.reason === "target" ? "T" : "S" }])
    .concat(result.open ? [{ time: result.open.entryTime, position: "belowBar", color: css("--pos"), shape: "arrowUp", text: "B" }] : []).sort((a, b) => a.time - b.time));
  const card = (l, v, c = "") => `<div class="mc"><span>${l}</span><b class="${c}">${v}</b></div>`;
  el.innerHTML = `<div class="panel-h"><h2>Backtest result · ${esc(result.strategy.name)}</h2><span class="right label">${esc(target.name)} · ${tf.k} · ${bars.length} candles</span></div>
    <div class="panel-b">
      <div class="mgrid">${card("Strategy return", pc(st.returnPct), st.returnPct >= 0 ? "up" : "down")}${card("Buy & hold", pc(st.buyHoldPct), st.buyHoldPct >= 0 ? "up" : "down")}
        ${card("Final value", fr(st.endValue))}${card("Trades", st.trades)}${card("Win rate", st.trades ? st.winRate.toFixed(0) + "%" : "–")}
        ${card("Max drawdown", "-" + st.maxDrawdownPct.toFixed(2) + "%", "down")}${card("Profit factor", st.profitFactor === Infinity ? "∞" : st.trades ? st.profitFactor.toFixed(2) : "–")}
        ${card("Avg win / loss", st.trades ? `${pc(st.avgWinPct)} / ${pc(st.avgLossPct)}` : "–")}${card("Market mein samay", st.exposurePct.toFixed(0) + "%")}</div>
      <div class="label" style="margin:14px 0 6px">Equity curve <span style="text-transform:none;letter-spacing:0;font-weight:500">(neela = strategy, dhusar = buy & hold)</span></div>
      <div id="btequity"></div>
      ${result.open ? `<div class="note">Abhi ek trade khula hai: ${esc(dstr(result.open.entryTime, day))} ko ${f2(result.open.entryPrice)} par, abhi ${pc(result.open.pnlPct)}.</div>` : ""}
    </div>
    <div class="scroll" style="max-height:320px"><table class="tbl"><thead><tr><th>#</th><th>Entry</th><th class="r">Buy</th><th>Exit</th><th class="r">Sell</th><th class="r hide-m">Qty</th><th class="r">P&amp;L</th><th class="r">%</th><th class="hide-m">Kyun</th></tr></thead><tbody>
      ${result.trades.map((t, i) => `<tr><td class="src">${i + 1}</td><td class="src when">${esc(dstr(t.entryTime, day))}</td><td class="r tnum">${f2(t.entryPrice)}</td><td class="src when">${esc(dstr(t.exitTime, day))}</td><td class="r tnum">${f2(t.exitPrice)}</td><td class="r tnum hide-m">${t.qty}</td><td class="r tnum ${t.pnl >= 0 ? "up" : "down"}">${fr(t.pnl)}</td><td class="r tnum ${t.pnl >= 0 ? "up" : "down"}">${pc(t.pnlPct)}</td><td class="src hide-m">${esc(t.reason)}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">Is data mein strategy ne koi trade nahi kiya.</td></tr>`}
    </tbody></table></div>
    <div class="panel-b note" style="margin:0;border-top:1px solid var(--line)">Buy/Sell signal candle ke close par, order agli candle ke open par. Stop-loss/target candle ke andar. Purane nateeje aage ki guarantee nahi.</div>`;
  const eqEl = el.querySelector("#btequity");
  eqChart?.remove();
  eqChart = createChart(eqEl, { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--muted"), fontSize: 10 }, grid: { vertLines: { visible: false }, horzLines: { color: "rgba(125,135,153,.08)" } },
    rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: tf.sec < 86400 }, handleScroll: false, handleScale: false, localization: { priceFormatter: (p) => fr(p) } });
  eqChart.addLineSeries({ color: css("--accent"), lineWidth: 2, priceLineVisible: false }).setData(result.equity);
  const c0 = bars[0].close, cap = risk.capital || 100000;
  eqChart.addLineSeries({ color: css("--muted"), lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }).setData(bars.map((b) => ({ time: b.time, value: cap * b.close / c0 })));
  eqChart.timeScale().fitContent();
  aiPanel();
}

// ---------- ask AI about the data ----------
function md(t) {                                            // tiny, safe markdown: ## headings, - bullets, **bold**
  const out = []; let inList = false;
  for (const line of String(t).split("\n")) {
    const l = esc(line).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^\s*[-*•]\s+/.test(line)) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${l.replace(/^\s*[-*•]\s+/, "")}</li>`); continue; }
    if (inList) { out.push("</ul>"); inList = false; }
    if (/^#{1,4}\s/.test(line)) out.push(`<h4>${l.replace(/^#{1,4}\s/, "")}</h4>`); else if (line.trim()) out.push(`<p>${l}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("");
}
function aiPanel() {
  const el = root.querySelector("#btai"), admin = H.isAdmin(), prev = el.querySelector("#btq")?.value || "", ans = el.querySelector("#btans")?.innerHTML || "";
  el.innerHTML = `<div class="panel-h"><h2>AI se poochhiye</h2><span class="right label">${esc(target?.name || "")} · ${tf.k} data${result && !result.error ? " + backtest" : ""}</span></div>
    <div class="panel-b">
      <div class="chips">${PROMPTS.map((p) => `<button type="button" class="btn2 sm" data-q="${esc(p)}">${esc(p)}</button>`).join("")}</div>
      <textarea class="field ta" id="btq" rows="3" placeholder="Is stock ke purane data ke baare mein kuch bhi poochhiye…">${esc(prev)}</textarea>
      <div class="kbtns">${admin ? `<button class="btn" type="button" id="btask">Analyze</button>` : `<span class="note" style="margin:0">AI ke liye <a href="#/keys">API Keys</a> mein login kariye.</span>`}<span class="note" id="btaskmsg" style="margin:0"></span></div>
      <div class="answer" id="btans">${ans}</div>
    </div>`;
  el.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { el.querySelector("#btq").value = b.dataset.q; el.querySelector("#btask")?.click(); }));
  if (el.querySelector("#btask")) el.querySelector("#btask").onclick = ask;
}
async function ask() {
  const el = root.querySelector("#btai"), q = el.querySelector("#btq").value.trim(); if (!q) return H.toast("Pehle sawaal likhiye.");
  const b = el.querySelector("#btask"); b.disabled = true; el.querySelector("#btaskmsg").textContent = "AI data padh raha hai…";
  const bt = result && !result.error ? { strategy: result.strategy.name, entry: result.strategy.entry.all.map(describeRule), exit: result.strategy.exit.any.map(describeRule),
    stopLossPct: result.strategy.stopLossPct, takeProfitPct: result.strategy.takeProfitPct, stats: result.stats,
    lastTrades: result.trades.slice(-10).map((t) => ({ entry: dstr(t.entryTime, tf.sec === 86400), exit: dstr(t.exitTime, tf.sec === 86400), pnlPct: +t.pnlPct.toFixed(2), reason: t.reason })) } : null;
  try {
    const d = await H.adminPost("ai", { mode: "analyze", symbol: target.symbol, name: target.name, interval: tf.api, stats: stats(), candles: raw.slice(-400), backtest: bt, prompt: q });
    el.querySelector("#btans").innerHTML = `<div class="qa"><div class="label">Sawaal</div><p>${esc(q)}</p></div>${md(d.answer)}<div class="note">AI: ${esc(d.engine)} · sirf is data par aadharit · investment advice nahi</div>`;
  } catch (e) { el.querySelector("#btans").innerHTML = `<div class="kres bad">${esc(e.message)}</div>`; }
  b.disabled = false; el.querySelector("#btaskmsg").textContent = "";
}
