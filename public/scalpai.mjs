// "AI trader" on the Scalping page (BANK NIFTY / NIFTY). Three modes:
//   Band       - nothing runs (you can still press "Abhi scan karo" for one look)
//   Signal     - the AI looks every N seconds and only TELLS you (🔔 on a new signal)
//   Auto trade - the AI looks every N seconds and, on a strong enough signal, opens the strike and starts the
//                BUY + target + stop-loss bracket itself (Paper = pretend money, Asli = real orders), within the
//                limits you set (lots, trades / day, max loss / day, minimum confidence). One trade at a time.
// Each look = ONE Claude (Haiku) call with the whole picture (index price action, the full option chain with OI / volume /
// IV / delta, PCR, max pain, support / resistance, news, and the lessons from your past trades). Page closed = AI stops.
import { contractGreeks, indicatorSummary, resample, compact } from "./optanalytics.mjs";
import { IST } from "./kiteticks.mjs";
import { optName } from "./scalpchain.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const inr = (v) => (v == null || !Number.isFinite(+v) ? "–" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const hhmm = (ms) => new Date(ms + IST * 1000).toISOString().slice(11, 16);
const HKEY = "sb-scalp-ai";
const EVERY = [0, 30, 60, 120, 300];                              // 0 = smart: only when the index breaks the AI's level
const ANYTIME = location.hostname === "localhost" && /[?&]anytime=1/.test(location.search);      // test hook: ignore market hours
const SPEED = ANYTIME ? 10 : 1;                                                                     // tests: 30 s -> 3 s
const everyTxt = (s) => (s === 0 ? "level tootne par (smart)" : s < 60 ? `${s} sec` : `${s / 60} min`);
// NSE F&O hours: Mon-Fri 9:15 to 15:30 India time (exchange holidays are not known here)
export function marketOpen(now = Date.now()) {
  if (ANYTIME) return true;
  const d = new Date(now + IST * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  return wd >= 1 && wd <= 5 && m >= 555 && m < 930;
}
const MODES = { off: "Band", signal: "Signal", trade: "Auto trade" };

// api: {H, market, state(), applyPick(sig), autoTrade(result) -> {ok, msg, stop}, tradeMode() -> "paper"|"real", today() -> {trades, net}}
export function mountAI(el, api) {
  const H = api.H, M = api.market;
  let usage = null, auto = { lots: 1, maxTrades: 5, maxLoss: 1000, minConf: 65 }, busy = false, last = null, scanBase = null, scanAt = 0;
  let mode = "off", timer = null, nextAt = 0, fails = 0, every = 60, showSet = false, draft = {}, lastScanAt = 0, prevSpot = null;
  const pending = new Map();                                 // AI signals being checked on the live price (report card)
  setInterval(checkSignals, 1000);
  try { const e = +localStorage.getItem(HKEY + "-every"); if (EVERY.includes(e)) every = e; } catch {}
  let history = []; try { history = JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch {}
  setInterval(() => { const n = el.querySelector("#ainext"); if (n) n.innerHTML = statusTxt(); }, 1000);

  el.innerHTML = `<div class="panel-h"><h2>AI trader</h2><span class="right"><span class="ai-use" id="aiuse"></span>
      <button type="button" class="btn2 sm" id="aiset" aria-expanded="false" title="Settings">⚙ Settings</button></span></div><div class="panel-b ai-b"></div>`;
  el.querySelector("#aiset").onclick = () => { showSet = !showSet; el.querySelector("#aiset").setAttribute("aria-expanded", String(showSet)); draw(); };

  function help() {
    const pm = api.tradeMode() === "real" ? "<b class='down'>ASLI paise</b>" : "<b>Paper (nakli paise)</b>";
    if (mode === "trade") return `AI khud strike chunkar trade karega: ${pm} · ${auto.lots} lot · din mein max ${auto.maxTrades} trade · max nuksan ₹${auto.maxLoss} · sirf ${auto.minConf}%+ bharosa.`;
    if (mode === "signal") return `AI har ${everyTxt(every)} market dekhkar sirf batayega (🔔). Order aap khud lagayenge.`;
    return "AI band hai. <b>Signal</b> = AI batata rahe · <b>Auto trade</b> = AI khud trade kare.";
  }
  function draw() {
    const box = el.querySelector(".ai-b"), oq = box.querySelector("#aiq");
    if (oq) draft.q = oq.value;
    const refocus = oq && document.activeElement === oq ? [oq.selectionStart, oq.selectionEnd] : null;   // keep typing while scans redraw
    const ok = H.isAdmin();
    box.innerHTML = `
      <div class="ai-top2">
        <div class="seg ai-modes" id="aimodes" role="radiogroup" aria-label="AI mode">${Object.entries(MODES).map(([k, l]) => `<button type="button" data-m="${k}" class="${k === mode ? "on" : ""}${k === "trade" ? " ai-trade" : ""}" ${ok ? "" : "disabled"} role="radio" aria-checked="${k === mode}">${l}</button>`).join("")}</div>
        <button type="button" class="btn sm" id="aigo" ${!ok || busy ? "disabled" : ""}>${busy ? "AI dekh raha hai…" : "Abhi scan karo"}</button>
      </div>
      <div class="ai-help">${ok ? help() : `AI ke liye <a href="#/keys">API Keys</a> mein login kariye.`}</div>
      <div class="ai-status ${mode !== "off" ? "on" : ""} ${mode === "trade" ? "ai-st-trade" : ""}" id="ainext">${statusTxt()}</div>
      ${showSet ? settingsHtml() : ""}
      <div id="aires">${last ? resultHtml(last) : `<div class="note" style="margin:0">Abhi koi signal nahi. "Abhi scan karo" dabaiye ya mode chuniye.</div>`}</div>
      ${history.length ? `<details class="ai-histd"><summary>Pichhle signals (${history.length})</summary><div class="ai-hist tnum">${history.slice(0, 10).map((h) => `<div><time>${hhmm(h.at)}</time><b class="${h.signal === "WAIT" ? "" : h.signal === "BUY_CE" ? "up" : "down"}">${h.signal.replace("_", " ")}</b><span>${esc(h.name || "")}</span>${h.entry ? `<span>@ ${f2(h.entry)}</span>` : ""}<span class="note" style="margin:0">${h.confidence}%${h.act ? " · " + esc(h.act) : ""}</span></div>`).join("")}</div></details>` : ""}`;
    const q = (id) => box.querySelector("#" + id);
    q("aigo").onclick = () => scan("manual");
    q("aimodes").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.m !== mode) setMode(b.dataset.m); };
    if (showSet) wireSettings(box);
    if (refocus && q("aiq")) { const t = q("aiq"); t.focus(); t.setSelectionRange(refocus[0], refocus[1]); }
    const fill = q("aifill");
    if (fill) fill.onclick = async () => {
      if (Date.now() - Date.parse(last.at) > last.validMinutes * 60000 && !confirm("Ye signal purana ho gaya hai. Phir bhi kholein aur form bharein?")) return;
      if (await api.applyPick(pickOf(last))) H.toast("Strike khul gaya aur Smart order form bhar diya. Check karke BUY dabaiye.");
    };
    useChip();
  }
  function settingsHtml() {
    const v = (k) => draft[k] ?? auto[k];
    return `<div class="ai-set">
      <label><span>Kitni der mein dekhe</span><select class="sel" id="aievery">${EVERY.map((x) => `<option value="${x}" ${x === every ? "selected" : ""}>${x === 0 ? "" : "har "}${everyTxt(x)}</option>`).join("")}</select></label>
      <label><span>Roz ki AI call limit</span><input class="field" id="ailim" type="number" min="1" max="2000" value="${draft.limit ?? usage?.limit ?? ""}"></label>
      <label><span>Auto trade: lot</span><input class="field" id="a-lots" type="number" min="1" max="50" value="${v("lots")}"></label>
      <label><span>Din mein max trade</span><input class="field" id="a-maxTrades" type="number" min="1" max="50" value="${v("maxTrades")}"></label>
      <label><span>Din ka max nuksan ₹</span><input class="field" id="a-maxLoss" type="number" min="100" step="100" value="${v("maxLoss")}"></label>
      <label><span>Kam se kam bharosa %</span><input class="field" id="a-minConf" type="number" min="30" max="95" value="${v("minConf")}"></label>
      <label class="wide"><span>AI se kuch khaas kehna (optional)</span><textarea class="field ai-q" id="aiq" rows="2" maxlength="400" placeholder="jaise: 'Sirf PE side dekho' ya 'expiry ke din saavdhaan'">${esc(draft.q || "")}</textarea></label>
      <div class="wide ai-setb"><button type="button" class="btn sm" id="aisave">Save</button><span class="note" style="margin:0">Limit poori ya nuksan hone par AI apne aap ruk jaata hai.</span></div>
    </div>`;
  }
  function wireSettings(box) {
    const q = (id) => box.querySelector("#" + id);
    q("aievery").onchange = (e) => { every = +e.target.value; try { localStorage.setItem(HKEY + "-every", String(every)); } catch {} if (mode !== "off" && !busy) go((every * 1000) / SPEED); };
    ["ailim", "a-lots", "a-maxTrades", "a-maxLoss", "a-minConf"].forEach((id) => (q(id).oninput = (e) => (draft[id === "ailim" ? "limit" : id.slice(2)] = e.target.value)));
    q("aiq").oninput = (e) => (draft.q = e.target.value);
    q("aisave").onclick = async () => {
      try {
        useSeq++;
        const [a, b] = await Promise.all([H.adminPost("ai-limit", { limit: +q("ailim").value }), H.adminPost("ai-auto", { auto: { lots: +q("a-lots").value, maxTrades: +q("a-maxTrades").value, maxLoss: +q("a-maxLoss").value, minConf: +q("a-minConf").value } })]);
        useSeq++; usage = a.usage; auto = b.auto; const keepQ = draft.q; draft = { q: keepQ };
        H.toast(`Save ho gaya: roz ${usage.limit} AI call · ${auto.lots} lot · max ${auto.maxTrades} trade · max nuksan ₹${auto.maxLoss} · ${auto.minConf}%+ bharosa.`); draw();
      } catch (e) { H.toast(e.message); }
    };
  }
  let useSeq = 0;                                            // newer usage info wins (a slow old reply must not undo a Save)
  async function loadUsage() { const my = ++useSeq; try { const d = await H.adminGet("ai-usage"); if (my === useSeq) { usage = d.usage; auto = d.auto || auto; } } catch {} draw(); }
  function useChip() { const u = el.querySelector("#aiuse"); if (u) u.textContent = usage ? `Aaj ${usage.used}/${usage.limit} AI call` : ""; }
  function statusTxt() {
    if (mode === "off") return busy ? "AI dekh raha hai…" : "";
    const st = api.state(), t = api.today(), P = last?.plan;
    const when = busy ? "AI dekh raha hai…" : st.bracketLive && mode === "trade" ? "Trade chal raha hai: AI naya trade nahi lega, target / SL sambhal rahe hain"
      : every === 0 ? (P ? `level ka intezaar: ${P.above} ke upar CE · ${P.below} ke neeche PE` : "pehla scan…") : `agla scan ${Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))}s mein`;
    const tr = mode === "trade" ? ` · aaj ${t.trades}/${auto.maxTrades} trade · P&L <b class="${t.net >= 0 ? "up" : "down"}">${inr(t.net)}</b>` : "";
    return `<b>● ${MODES[mode]}${mode === "trade" ? ` (${api.tradeMode() === "real" ? "ASLI" : "Paper"})` : ""}</b> · ${when}${tr}`;
  }

  // ---------- modes ----------
  function setMode(m) {
    if (m === "off") return stop(mode === "off" ? "" : "AI band: ab AI apne aap kuch nahi karega.");
    if (!M.ready()) { H.toast("Option chain abhi aa rahi hai. Thoda ruk kar try kariye."); return draw(); }
    if (!marketOpen()) { H.toast("Market band hai (Mon-Fri 9:15 se 3:30). AI market time mein hi chalega."); return draw(); }
    if (usage && usage.used >= usage.limit) { H.toast(`Aaj ki AI limit (${usage.limit}) poori ho gayi. ⚙ Settings mein badhaiye.`); return draw(); }
    if (m === "trade") {
      const real = api.tradeMode() === "real";
      const msg = `AI ab KHUD trade karega (${real ? "ASLI PAISE SE, asli orders" : "Paper: nakli paise, koi asli order nahi"}).\n\n` +
        `• Har trade: ${auto.lots} lot, BUY + target + stop-loss\n• Din mein max ${auto.maxTrades} trade\n• Din ka nuksan ₹${auto.maxLoss} hote hi AI ruk jaayega\n` +
        `• Sirf ${auto.minConf}% ya zyada bharose wale signal par\n• Ek waqt mein ek hi trade · 3:00 baje ke baad naya trade nahi\n• Ye page khula rakhiye, band hua to AI ruk jaayega\n\n` +
        `${real ? "AI galat bhi ho sakta hai aur asli nuksan ho sakta hai. " : ""}Shuru karein?`;
      if (!confirm(msg)) return draw();
    }
    mode = m; fails = 0;
    H.toast(m === "trade" ? `Auto trade ON (${api.tradeMode() === "real" ? "ASLI" : "Paper"}). Band karne ke liye "Band" dabaiye.` : `Signal mode ON: AI har ${everyTxt(every)} batayega.`);
    go(0);
  }
  function stop(msg) { mode = "off"; clearTimeout(timer); timer = null; nextAt = 0; if (msg) H.toast(msg); draw(); }
  function go(ms) { clearTimeout(timer); nextAt = Date.now() + ms; timer = setTimeout(tick, ms); draw(); }
  async function tick() {
    if (mode === "off") return;
    if (!marketOpen()) return stop("Market band ho gaya: AI band.");
    if (usage && usage.used >= usage.limit) return stop(`Aaj ki AI limit (${usage.limit}) poori: AI band.`);
    if (busy || (mode === "trade" && api.state().bracketLive)) { nextAt = Date.now() + 2000; timer = setTimeout(tick, 2000); return; }   // a trade is running: no new look (saves calls)
    if (every === 0) {                                       // smart: look again only when the index breaks the AI's level (or after 10 min)
      const P = last?.plan, spot = M.under.spot, since = Date.now() - lastScanAt;
      const crossed = P && prevSpot != null && spot != null && ((prevSpot <= P.above && spot > P.above) || (prevSpot >= P.below && spot < P.below));
      prevSpot = spot;
      if (P && !(crossed && since > 60000) && since < 10 * 60000) { nextAt = Date.now() + 2000; timer = setTimeout(tick, 2000); return; }
      if (crossed) H.toast(`📍 Index ne AI ka level ${spot > P.above ? P.above + " upar" : P.below + " neeche"} toda: AI dobara dekh raha hai`);
    }
    const r = await scan(mode);
    if (mode === "off") return;
    fails = r ? 0 : fails + 1;
    if (fails >= 3) return stop("AI 3 baar lagataar fail hua: AI band. Thodi der baad dobara chalaiye.");
    go(every === 0 ? 2000 : (every * 1000) / SPEED);
  }

  // ---------- AI report card: did the target or the stop come first on the live price? ----------
  function track(r, taken) {
    if (r.signal === "WAIT" || !r.entry || !r.symbol) return;
    pending.set(r.at + r.symbol, { id: `${Date.parse(r.at)}-${r.symbol}`, at: r.at, index: M.idx.key, symbol: r.symbol, name: r.name, type: r.signal === "BUY_PE" ? "PE" : "CE",
      confidence: r.confidence, entry: r.entry, target: r.target, stopLoss: r.stopLoss, until: Date.parse(r.at) + Math.max(5, r.validMinutes || 10) * 60000, hi: r.entry, lo: r.entry, taken });
  }
  function checkSignals() {
    if (!pending.size || !M.chain) return;
    const px = new Map(M.chain.rows.flatMap((r) => [r.ce, r.pe]).filter(Boolean).map((c) => [c.symbol, c.ltp]));
    for (const [k, x] of pending) {
      const p = px.get(x.symbol); if (p == null && Date.now() < x.until) continue;
      if (p != null) { x.hi = Math.max(x.hi, p); x.lo = Math.min(x.lo, p); }
      const out = p != null && p >= x.target ? "target" : p != null && p <= x.stopLoss ? "sl" : Date.now() >= x.until ? "none" : null;
      if (!out) continue;
      pending.delete(k);
      H.adminPost("signals", { op: "add", signal: { ...x, outcome: out, minutes: Math.round((Date.now() - Date.parse(x.at)) / 60000), mfe: Math.round((x.hi - x.entry) * 100) / 100, mae: Math.round((x.entry - x.lo) * 100) / 100 } }).catch(() => {});
    }
  }

  // ---------- one look ----------
  async function bars1m(sym) {
    try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(sym)}&interval=minute`, { cache: "no-store" }); const d = await r.json(); if (!r.ok) return [];
      return d.candles.map(([t, o, h, l, c, v]) => ({ time: t + IST, open: o, high: h, low: l, close: c, volume: v || 0 })); } catch { return []; }
  }
  async function payload() {
    const st = api.state(), now = Date.now(), U = M.under, ch = M.chain;
    const [ub, ob] = await Promise.all([bars1m(U.symbol), st.target ? bars1m(st.target.symbol) : []]);
    if (!st.wsLive) await M.reload();                         // no live ticks: get fresh OI first
    const s = M.summary(scanBase || M.base0());
    const opt = st.meta?.option;
    const g = opt && U.spot && st.ltp ? contractGreeks({ ltp: st.ltp, spot: U.spot, strike: opt.strike, expiry: opt.expiry, type: opt.type }) : null;
    const closeIn = Math.round((Date.parse(new Date(now + IST * 1000).toISOString().slice(0, 10) + "T15:30:00+05:30") - now) / 60000);
    const u5 = resample(ub, 300);
    return {
      time: hhmm(now) + " IST", minutesToMarketClose: closeIn, tradeMode: mode === "trade" ? `auto (${api.tradeMode()})` : "advice", market: api.context?.() || null,
      index: { underlying: M.idx.key, name: U.name, spot: U.spot, prevClose: U.prevClose, changePct: U.spot && U.prevClose ? +(((U.spot - U.prevClose) / U.prevClose) * 100).toFixed(2) : null,
        ind1m: indicatorSummary(ub), ind5m: indicatorSummary(u5), last30x1m: compact(ub, 30), last20x5m: compact(u5, 20) },
      chain: { expiry: ch.expiry, lotSize: ch.lot_size, atm: s.atm, pcr: s.pcr, pcrBefore: s.pcrBase, maxPain: s.maxPain, support: s.support, resistance: s.resistance, atmIv: s.atmIv,
        changesSince: scanBase ? `last scan ${Math.round((now - scanAt) / 60000)} min ago` : `page opened ${Math.round((now - M.baseAt()) / 60000)} min ago`,
        columns: ["strike", "CE symbol", "CE ltp", "CE OI", "CE OI chg", "PE symbol", "PE ltp", "PE OI", "PE OI chg", "CE IV%", "PE IV%", "CE volume", "PE volume", "CE delta", "PE delta"],
        rows: s.rows.map((r) => [r.strike, r.ce?.symbol ?? null, r.ce?.ltp ?? null, r.ce?.oi ?? null, r.ce?.dOi ?? null, r.pe?.symbol ?? null, r.pe?.ltp ?? null, r.pe?.oi ?? null, r.pe?.dOi ?? null,
          r.ce?.iv ?? null, r.pe?.iv ?? null, r.ce?.volume ?? null, r.pe?.volume ?? null, r.ce?.delta ?? null, r.pe?.delta ?? null]),
        topOiChanges: s.topChanges },
      openContract: st.target ? { symbol: st.target.symbol, name: st.target.name, type: opt?.type, strike: opt?.strike, ltp: st.ltp, bid: st.bid, ask: st.ask,
        spread: st.bid && st.ask ? +(st.ask - st.bid).toFixed(2) : null, greeks: g, ind1m: indicatorSummary(ob), last20x1m: compact(ob, 20),
        depth: st.depth ? { buyQty: st.depth.buy.reduce((a, x) => a + x.qty, 0), sellQty: st.depth.sell.reduce((a, x) => a + x.qty, 0) } : null } : null,
    };
  }
  const pickOf = (r) => ({ symbol: r.symbol, name: r.name, lot: M.chain?.lot_size, entry: r.entry, target: r.target, stopLoss: r.stopLoss });
  async function scan(kind) {                                // kind: "manual" | "signal" | "trade"
    if (busy) return false;
    if (!M.ready()) { if (kind === "manual") H.toast("Option chain / index ka daam abhi aa raha hai. Thoda ruk kar try kariye."); return false; }
    busy = true; draw();
    let ok = false;
    try {
      const p = await payload();
      const d = await H.adminPost("ai", { mode: "trade", payload: p, question: draft.q || "" });
      if (d.usage) { useSeq++; usage = d.usage; }
      last = { ...d.result, name: nameFor(d.result.symbol), fresh: kind !== "manual", act: null };
      scanBase = M.snapshot(); scanAt = Date.now(); lastScanAt = Date.now(); prevSpot = M.under.spot; ok = true; api.onPlan?.();
      const prev = history[0], name = last.signal === "WAIT" ? M.idx.label : last.name;
      busy = false; draw();                                   // show the answer at once, then act on it
      if (kind === "trade") {
        const res = await api.autoTrade(last);
        last.act = res.msg; last.acted = !!res.ok; track(last, !!res.ok);
        if (res.ok) H.toast(`🤖 AI ne trade shuru kiya: ${last.name} @ ${f2(last.entry)}`);
        if (res.stop) stop(`AI band: ${res.msg}`);
      } else if (kind === "signal" && last.signal !== "WAIT" && (!prev || prev.signal !== last.signal || prev.name !== name))
        H.toast(`🔔 Naya AI signal: ${last.signal.replace("_", " ")} ${name} @ ${f2(last.entry)}`);
      if (kind !== "trade") track(last, false);
      if (kind === "manual" && last.signal !== "WAIT" && last.entry) {   // button: open that strike + fill the form (no order)
        if (await api.applyPick(pickOf(last))) H.toast(`AI ne ${last.name} chuna: strike khul gaya aur form bhar diya. Check karke BUY dabaiye.`);
      }
      history.unshift({ at: Date.now(), signal: last.signal, name, entry: last.entry, confidence: last.confidence, act: kind === "trade" ? (last.acted ? "AI trade" : "") : kind === "signal" ? "signal" : "" });
      history = history.slice(0, 20); try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch {}
      M.draw();                                               // mark the AI's strike in the chain
    } catch (e) {
      if (/limit/.test(e.message)) { loadUsage(); if (mode !== "off") stop(); }
      H.toast((kind !== "manual" ? "AI: " : "") + e.message);
    }
    finally { busy = false; draw(); }
    return ok;
  }
  function nameFor(sym) {
    if (!sym) return "";
    for (const r of M.chain?.rows || []) for (const [c, t] of [[r.ce, "CE"], [r.pe, "PE"]]) if (c?.symbol === sym) return optName(M.idx.key, M.chain.expiry, r.strike, t);
    return api.state().target?.symbol === sym ? api.state().target.name : sym.replace(/\.NFO$/, "");
  }
  function resultHtml(r) {
    const tone = r.signal === "BUY_CE" ? "up" : r.signal === "BUY_PE" ? "down" : "wait";
    const rr = r.entry && r.target && r.stopLoss ? ((r.target - r.entry) / (r.entry - r.stopLoss)).toFixed(1) : null;
    const open = r.symbol && api.state().target?.symbol === r.symbol;
    return `<div class="ai-res ${tone}${r.fresh ? " fresh" : ""}">
      <div class="ai-top"><span class="ai-sig">${r.signal === "WAIT" ? "WAIT" : r.signal.replace("_", " ")}</span>${r.symbol ? `<b class="ai-strike">${esc(r.name)}</b>` : `<span class="note" style="margin:0">abhi trade nahi</span>`}
        <span class="ai-pill" title="AI ka bharosa">${r.confidence}%</span><span class="note" style="margin:0">${hhmm(Date.parse(r.at))} · ${hhmm(Date.parse(r.at) + r.validMinutes * 60000)} tak</span></div>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}
      ${r.note ? `<div class="kres bad">${esc(r.note)}</div>` : ""}
      ${r.entry ? `<div class="ai-nums tnum"><span>Entry <b>${f2(r.entry)}</b></span><span>Target <b class="up">${f2(r.target)}</b></span><span>SL <b class="down">${f2(r.stopLoss)}</b></span>${rr ? `<span>R:R <b>${rr}</b></span>` : ""}</div>` : ""}
      ${r.plan ? `<div class="ai-plan tnum">🧭 Plan: <b class="up">${r.plan.above.toLocaleString("en-IN")} ke upar CE</b> · <b class="down">${r.plan.below.toLocaleString("en-IN")} ke neeche PE</b> · beech mein no-trade${r.plan.note ? ` · ${esc(r.plan.note)}` : ""}</div>` : ""}
      ${r.act ? `<div class="ai-act ${r.acted ? "ok" : ""}">${r.acted ? "🤖 " : "⏸ "}${esc(r.act)}</div>` : ""}
      ${r.reasons.length || r.risks.length ? `<details class="ai-why"><summary>Kyon? (${r.reasons.length} kaaran${r.risks.length ? `, ${r.risks.length} risk` : ""})</summary>
        <div class="rcols">${r.reasons.length ? `<div><div class="label">Kaaran</div><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}${r.risks.length ? `<div><div class="label">Risk</div><ul>${r.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}</div>
        <div class="note">AI ne dekha: ${esc((r.indicatorsUsed || []).join(", ") || "chain, price action")} · news ${r.newsCount ?? 0}${r.learnedFrom ? ` · pichhle ${r.learnedFrom} trade se seekh` : ""}</div></details>` : ""}
      ${r.entry && !r.acted ? `<div class="sp-cb"><button class="btn sm ${tone === "up" ? "btn-buy" : "btn-sell"}" id="aifill">${open ? "Form dobara bharo" : "Ye strike kholo + form bharo"}</button></div>` : ""}
      <div class="note" style="margin:0">AI ki salah hai, guarantee nahi. Ye investment advice nahi hai.</div></div>`;
  }
  return {
    draw, plan: () => last?.plan || null, isAuto: () => mode === "trade", mode: () => mode, autoSettings: () => auto, pick: () => (last && last.signal !== "WAIT" ? last.symbol : null),
    indexChanged: () => { last = null; scanBase = null; if (mode !== "off") stop("Index badla: AI band."); else draw(); },
    stop: (msg) => stop(msg), refresh: () => { if (H.isAdmin() && !usage) loadUsage(); else draw(); }, reloadUsage: loadUsage,
  };
}

export const AI_CSS = `
.ai-use{font-size:11.5px;font-weight:600;color:var(--text-2);background:var(--hover);border-radius:10px;padding:2px 8px}
.ai-chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px}
.ai-chip{border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 8px;background:var(--surface-2);min-width:0}
.ai-chip span{display:block;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ai-chip b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.ai-chip small{font-size:11px}
.ai-b{display:grid;gap:10px}
.ai-top2{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ai-top2 .btn{margin-left:auto}
.ai-modes button{height:32px;padding:0 16px;font-size:13px}.ai-modes button.ai-trade.on{background:var(--pos);color:#fff;box-shadow:none}
.ai-help{font-size:12.5px;color:var(--text-2);line-height:1.45}
.ai-status{font-size:12.5px;color:var(--muted);min-height:18px}.ai-status:empty{display:none}
.ai-status.on{border:1px solid var(--accent);background:var(--accent-soft);color:var(--ink);border-radius:var(--r-sm);padding:7px 10px}
.ai-status.ai-st-trade{border-color:var(--pos);background:var(--pos-soft)}
.ai-set{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;border:1px solid var(--line);border-radius:var(--r-sm);padding:12px;background:var(--surface-2)}
.ai-set label{display:grid;gap:4px;font-size:11.5px;color:var(--muted)}.ai-set .field{height:32px}.ai-set .wide{grid-column:1/-1}
.ai-setb{display:flex;gap:10px;align-items:center}
.ai-q{height:auto;padding:8px 10px;resize:vertical;line-height:1.4}
.ai-res.fresh{animation:aiflash 1.2s ease-out}@keyframes aiflash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 0 transparent}}
.ai-res{border:1px solid var(--line-2);border-radius:var(--r);padding:12px 14px;display:grid;gap:8px}
.ai-res.up{border-color:var(--pos);background:color-mix(in srgb,var(--pos) 6%,transparent)}.ai-res.down{border-color:var(--neg);background:color-mix(in srgb,var(--neg) 6%,transparent)}
.ai-res p{margin:0;font-size:13.5px;line-height:1.5}.ai-res ul{margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5}
.ai-top{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.ai-strike{font-size:14px}
.ai-sig{font-weight:800;font-size:17px;letter-spacing:.02em}.ai-res.up .ai-sig{color:var(--pos)}.ai-res.down .ai-sig{color:var(--neg)}.ai-res.wait .ai-sig{color:var(--warn-ink)}
.ai-pill{font-size:12px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--accent-soft);color:var(--accent)}
.ai-nums{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted)}.ai-nums b{color:var(--ink)}
.ai-plan{font-size:12.5px;padding:6px 10px;border-radius:var(--r-sm);background:var(--surface-2);border:1px dashed var(--line-2)}
.ai-act{font-size:12.5px;padding:6px 10px;border-radius:var(--r-sm);background:var(--hover);color:var(--text-2)}.ai-act.ok{background:var(--pos-soft);color:var(--pos);font-weight:600}
.ai-why summary,.ai-histd summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--accent)}
.ai-why[open] summary{margin-bottom:6px}
.ai-hist{display:grid;gap:4px;font-size:12px;margin-top:6px}.ai-hist div{display:flex;gap:10px;align-items:baseline;color:var(--text-2)}.ai-hist time{color:var(--muted)}
@media(max-width:600px){.ai-top2 .btn{margin-left:0;width:100%}.ai-modes{width:100%}.ai-modes button{flex:1;padding:0 6px}}
`;
