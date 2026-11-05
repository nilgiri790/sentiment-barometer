// "AI trade assistant" on the Scalping page (BANK NIFTY / NIFTY). Paid, only on "Scan trade" (or while AI Scan is ON):
// ONE Claude (Haiku) call with the whole picture: the index's price action (1m + 5m candles, VWAP, RSI, EMA, ATR),
// the full loaded option chain (LTP, OI, OI change since the last scan, volume, IV, delta), PCR / max pain / support /
// resistance, the open contract (if any) and recent news. The AI picks ONE strike (CE or PE) or says WAIT.
// It never places an order: a button-scan opens that strike and fills the Smart order form; you press BUY yourself.
import { contractGreeks, indicatorSummary, resample, compact } from "./optanalytics.mjs";
import { IST } from "./kiteticks.mjs";
import { optName } from "./scalpchain.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const hhmm = (ms) => new Date(ms + IST * 1000).toISOString().slice(11, 16);
const HKEY = "sb-scalp-ai";
const EVERY = [30, 60, 120, 300];
const ANYTIME = location.hostname === "localhost" && /[?&]anytime=1/.test(location.search);      // test hook: ignore market hours
const SPEED = ANYTIME ? 10 : 1;                                                                     // tests: 30 s -> 3 s
const everyTxt = (s) => (s < 60 ? `${s} sec` : `${s / 60} min`);
// NSE F&O hours: Mon-Fri 9:15 to 15:30 India time (exchange holidays are not known here)
function marketOpen(now = Date.now()) {
  if (ANYTIME) return true;
  const d = new Date(now + IST * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  return wd >= 1 && wd <= 5 && m >= 555 && m < 930;
}

// api: {H, market (scalpchain), state() -> {target, meta, ltp, bid, ask, depth, wsLive, bracketLive}, applyPick(sig), onPick()}
export function mountAI(el, api) {
  const H = api.H, M = api.market;
  let usage = null, busy = false, last = null, scanBase = null, scanAt = 0;
  let auto = false, autoT = null, nextAt = 0, fails = 0, every = 60, limDraft = null;   // limDraft: typed, not saved yet
  try { const e = +localStorage.getItem(HKEY + "-every"); if (EVERY.includes(e)) every = e; } catch {}
  setInterval(() => { const n = el.querySelector("#ainext"); if (n) n.innerHTML = nextTxt(); }, 1000);
  let history = []; try { history = JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch {}

  el.innerHTML = `<div class="panel-h"><h2>AI trade assistant</h2><span class="right"><span class="label">Haiku</span><span class="ai-use" id="aiuse"></span></span></div><div class="panel-b"></div>`;

  function indexChanged() { last = null; scanBase = null; if (auto) stopAuto("Index badla: AI Scan OFF."); else draw(); }
  function draw() {
    const box = el.querySelector(".panel-b");
    const keepQ = box.querySelector("#aiq")?.value ?? "", oq = box.querySelector("#aiq");
    const refocus = oq && document.activeElement === oq ? [oq.selectionStart, oq.selectionEnd] : null;   // keep typing while auto scans redraw
    const name = M.idx?.label || "index";
    box.innerHTML = `
      <div class="ai-grid">
        <div class="note" style="margin:0;line-height:1.5">AI <b>${esc(name)}</b> ki poori option chain (OI, OI badlav, volume, IV, delta), PCR, max pain, support/resistance, index ka live price action
          (VWAP, RSI, EMA, ATR, candles) aur news dekhkar <b>ek strike ka CE ya PE</b> chunega, ya WAIT bolega. Order kabhi khud nahi lagata.</div>
        <div class="ai-act">
          <textarea class="field ai-q" id="aiq" rows="2" maxlength="400" placeholder="Kuch khaas poochhna hai? (optional) jaise: 'Sirf PE side dekho'">${esc(keepQ)}</textarea>
          <button class="btn sp-go ai-go" id="aigo" ${!H.isAdmin() || busy ? "disabled" : ""}>${busy ? "AI dekh raha hai…" : "Scan trade (1 AI call)"}</button>
          <div class="ai-auto ${auto ? "on" : ""}"><label class="switch"><input type="checkbox" id="aiauto" ${auto ? "checked" : ""} ${H.isAdmin() ? "" : "disabled"}><span></span>AI Scan ${auto ? "ON" : "OFF"}</label>
            <select class="sel ai-every" id="aievery" aria-label="Kitni der mein scan">${EVERY.map((x) => `<option value="${x}" ${x === every ? "selected" : ""}>har ${everyTxt(x)}</option>`).join("")}</select></div>
          <div class="note ai-next" id="ainext" style="margin:0">${nextTxt()}</div>
          <div class="note" style="margin:0">${H.isAdmin() ? `Button = AI ka chuna strike khulega aur form bhar jaayega. ON = har ${everyTxt(every)} naya signal sirf dikhega + 🔔 (≈ ${Math.round(3600 / every)} call/ghanta).` : `AI ke liye <a href="#/keys">API Keys</a> mein login kariye.`}</div>
          <div class="ai-lim">${H.isAdmin() ? `<label class="label" for="ailim">Roz ki limit</label><input class="field" id="ailim" type="number" min="1" max="2000" step="1" value="${limDraft ?? usage?.limit ?? ""}"><button class="btn2 sm" id="ailims">Save</button>` : ""}</div>
        </div>
      </div>
      <div id="aires">${last ? resultHtml(last) : ""}</div>
      ${history.length ? `<div class="label" style="margin-top:12px">Pichhle signals</div><div class="ai-hist tnum">${history.slice(0, 8).map((h) => `<div><time>${hhmm(h.at)}</time><b class="${h.signal === "WAIT" ? "" : h.signal === "BUY_CE" ? "up" : "down"}">${h.signal.replace("_", " ")}</b><span>${esc(h.name || "")}</span>${h.entry ? `<span>@ ${f2(h.entry)}</span>` : ""}<span class="note" style="margin:0">${h.confidence}%${h.auto ? " · auto" : ""}</span></div>`).join("")}</div>` : ""}`;
    const q = (id) => box.querySelector("#" + id);
    q("aigo").onclick = () => scan(false);
    q("aiauto").onchange = (e) => (e.target.checked ? startAuto() : stopAuto("AI Scan OFF: ab AI apne aap scan nahi karega."));
    q("aievery").onchange = (e) => { every = +e.target.value; try { localStorage.setItem(HKEY + "-every", String(every)); } catch {} if (auto && !busy) go((every * 1000) / SPEED); draw(); };
    if (refocus) { const t = q("aiq"); t.focus(); t.setSelectionRange(refocus[0], refocus[1]); }
    if (q("ailim")) q("ailim").oninput = (e) => (limDraft = e.target.value);
    if (q("ailims")) q("ailims").onclick = async () => { try { useSeq++; const d = await H.adminPost("ai-limit", { limit: +q("ailim").value }); useSeq++; usage = d.usage; limDraft = null; useChip(); H.toast(`Roz ki AI limit ${usage.limit} scan ho gayi.`); } catch (e) { H.toast(e.message); } };
    const fill = q("aifill");
    if (fill) fill.onclick = async () => {
      if (Date.now() - Date.parse(last.at) > last.validMinutes * 60000 && !confirm("Ye signal purana ho gaya hai. Phir bhi kholein aur form bharein?")) return;
      if (await api.applyPick(pickOf(last))) H.toast("Strike khul gaya aur Smart order form bhar diya. Check karke BUY dabaiye.");
    };
    useChip();
  }
  let useSeq = 0;                                            // newer usage info wins (a slow old reply must not undo a Save)
  async function loadUsage() { const my = ++useSeq; try { const u = (await H.adminGet("ai-usage")).usage; if (my === useSeq) usage = u; } catch {} draw(); }
  function useChip() { const u = el.querySelector("#aiuse"); if (u) u.textContent = usage ? `Aaj ${usage.used}/${usage.limit}` : ""; }

  // ---------- scan ----------
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
      time: hhmm(now) + " IST", minutesToMarketClose: closeIn,
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
  function nextTxt() {
    if (!auto) return "";
    if (busy) return `<b class="up">● AI Scan ON</b> · AI dekh raha hai…`;
    const s = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    return `<b class="up">● AI Scan ON</b> · agla scan ${s}s mein${usage ? ` · aaj ${usage.used}/${usage.limit}` : ""}`;
  }
  function startAuto() {
    if (!M.ready()) { H.toast("Option chain abhi aa rahi hai. Thoda ruk kar ON kariye."); return draw(); }
    if (!marketOpen()) { H.toast("Market band hai (Mon-Fri 9:15 se 3:30). AI Scan market time mein hi chalega."); return draw(); }
    if (usage && usage.used >= usage.limit) { H.toast(`Aaj ki AI limit (${usage.limit}) poori ho gayi. Limit badha kar ON kariye.`); return draw(); }
    auto = true; fails = 0;
    H.toast(`AI Scan ON: har ${everyTxt(every)} naya signal aayega. Band karne ke liye switch OFF kariye.`);
    go(0);
  }
  function stopAuto(msg) { auto = false; clearTimeout(autoT); autoT = null; nextAt = 0; if (msg) H.toast(msg); draw(); }
  function go(ms) { clearTimeout(autoT); nextAt = Date.now() + ms; autoT = setTimeout(autoTick, ms); draw(); }
  async function autoTick() {
    if (!auto) return;
    if (!marketOpen()) return stopAuto("Market band ho gaya: AI Scan OFF.");
    if (usage && usage.used >= usage.limit) return stopAuto(`Aaj ki AI limit (${usage.limit}) poori: AI Scan OFF.`);
    if (busy) { nextAt = Date.now() + 2000; autoT = setTimeout(autoTick, 2000); return; }
    const ok = await scan(true);
    if (!auto) return;
    fails = ok ? 0 : fails + 1;
    if (fails >= 3) return stopAuto("AI 3 baar lagataar fail hua: AI Scan OFF. Thodi der baad dobara ON kariye.");
    go((every * 1000) / SPEED);
  }
  const pickOf = (r) => ({ symbol: r.symbol, name: r.name, lot: M.chain?.lot_size, entry: r.entry, target: r.target, stopLoss: r.stopLoss });
  async function scan(isAuto = false) {
    if (busy) return false;
    if (!M.ready()) { if (!isAuto) H.toast("Option chain / index ka daam abhi aa raha hai. Thoda ruk kar try kariye."); return false; }
    busy = true; draw();
    let ok = false;
    try {
      const p = await payload();
      const d = await H.adminPost("ai", { mode: "trade", payload: p, question: el.querySelector("#aiq")?.value || "" });
      if (d.usage) { useSeq++; usage = d.usage; }
      last = { ...d.result, name: nameFor(d.result.symbol), fresh: isAuto };
      scanBase = M.snapshot(); scanAt = Date.now();
      const prev = history[0], name = last.signal === "WAIT" ? M.idx.label : last.name;
      if (isAuto && last.signal !== "WAIT" && (!prev || prev.signal !== last.signal || prev.name !== name))      // something new: tell the user
        H.toast(`🔔 Naya AI signal: ${last.signal.replace("_", " ")} ${name} @ ${f2(last.entry)}`);
      history.unshift({ at: Date.now(), signal: last.signal, name, entry: last.entry, confidence: last.confidence, auto: isAuto });
      history = history.slice(0, 15); try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch {}
      ok = true;
      M.draw();                                               // mark the AI's strike in the chain
      if (!isAuto && last.signal !== "WAIT" && last.entry) {     // button scan: open that strike + fill the form (no order)
        busy = false; draw();
        if (await api.applyPick(pickOf(last))) H.toast(`AI ne ${last.name} chuna: strike khul gaya aur form bhar diya. Check karke BUY dabaiye.`);
        return ok;
      }
    } catch (e) {
      if (/limit/.test(e.message)) { loadUsage(); if (auto) stopAuto(); }
      H.toast((isAuto ? "AI Scan: " : "") + e.message);
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
    const until = hhmm(Date.parse(r.at) + r.validMinutes * 60000);
    const rr = r.entry && r.target && r.stopLoss ? ((r.target - r.entry) / (r.entry - r.stopLoss)).toFixed(1) : null;
    const open = r.symbol && api.state().target?.symbol === r.symbol;
    return `<div class="ai-res ${tone}${r.fresh ? " fresh" : ""}">
      <div class="ai-top"><span class="ai-sig">${r.signal === "WAIT" ? "WAIT · abhi trade nahi" : r.signal.replace("_", " ")}</span>${r.symbol ? `<b class="ai-strike">${esc(r.name)}</b>` : ""}
        <span class="ai-conf"><i style="width:${r.confidence}%"></i></span><span class="note" style="margin:0">${r.confidence}% bharosa · ${hhmm(Date.parse(r.at))} · ${until} tak</span></div>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}
      ${r.note ? `<div class="kres bad">${esc(r.note)}</div>` : ""}
      ${r.entry ? `<div class="ai-nums tnum"><span>Entry <b>${f2(r.entry)}</b></span><span>Target <b class="up">${f2(r.target)}</b></span><span>Stop-loss <b class="down">${f2(r.stopLoss)}</b></span>${rr ? `<span>Reward:Risk <b>${rr}</b></span>` : ""}</div>` : ""}
      <div class="rcols">${r.reasons.length ? `<div><div class="label">Kyon</div><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}${r.risks.length ? `<div><div class="label">Risk</div><ul>${r.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}</div>
      ${r.indicatorsUsed.length ? `<div class="note">AI ne dekha: ${esc(r.indicatorsUsed.join(", "))} · news ${r.newsCount}</div>` : ""}
      ${r.entry ? `<div class="sp-cb"><button class="btn sm ${tone === "up" ? "btn-buy" : "btn-sell"}" id="aifill">${open ? "Form dobara bharo" : "Ye strike kholo + form bharo"}</button><span class="note" style="margin:0">Order aap khud BUY dabakar lagayenge.</span></div>` : ""}
      <div class="note">AI ki salah hai, guarantee nahi. Ye investment advice nahi hai.</div></div>`;
  }
  return {
    draw, indexChanged, isAuto: () => auto, pick: () => (last && last.signal !== "WAIT" ? last.symbol : null),
    refresh: () => { if (H.isAdmin() && !usage) loadUsage(); else draw(); },
  };
}

export const AI_CSS = `
.ai-use{font-size:11.5px;font-weight:600;color:var(--text-2);background:var(--hover);border-radius:10px;padding:2px 8px}
.ai-chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px}
.ai-chip{border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 8px;background:var(--surface-2);min-width:0}
.ai-chip span{display:block;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ai-chip b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.ai-chip small{font-size:11px}
.ai-grid{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}@media(min-width:900px){.ai-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.ai-act{display:grid;gap:8px;align-content:start}.ai-q{height:auto;padding:8px 10px;resize:vertical;line-height:1.4}
.ai-auto{display:flex;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--line-2);border-radius:var(--r-sm);padding:7px 10px}
.ai-auto.on{border-color:var(--pos);background:var(--pos-soft)}.ai-every{width:auto;height:30px}
.ai-res.fresh{animation:aiflash 1.2s ease-out}@keyframes aiflash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 0 transparent}}
.ai-lim{display:flex;gap:6px;align-items:center}.ai-lim .field{width:90px;height:30px}.ai-lim label{flex:1}
.ai-res{margin-top:14px;border:1px solid var(--line-2);border-radius:var(--r);padding:12px 14px;display:grid;gap:8px}
.ai-res.up{border-color:var(--pos);background:color-mix(in srgb,var(--pos) 6%,transparent)}.ai-res.down{border-color:var(--neg);background:color-mix(in srgb,var(--neg) 6%,transparent)}
.ai-res p{margin:0;font-size:13.5px;line-height:1.5}.ai-res ul{margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5}
.ai-top{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.ai-strike{font-size:14px}
.ai-sig{font-weight:800;font-size:16px;letter-spacing:.02em}.ai-res.up .ai-sig{color:var(--pos)}.ai-res.down .ai-sig{color:var(--neg)}.ai-res.wait .ai-sig{color:var(--warn-ink)}
.ai-conf{width:80px;height:6px;border-radius:3px;background:var(--line-2);overflow:hidden}.ai-conf i{display:block;height:100%;background:var(--accent)}
.ai-nums{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted)}.ai-nums b{color:var(--ink)}
.ai-hist{display:grid;gap:4px;font-size:12px;margin-top:6px}.ai-hist div{display:flex;gap:10px;align-items:baseline;color:var(--text-2)}.ai-hist time{color:var(--muted)}
`;
