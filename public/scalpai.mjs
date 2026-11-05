// "AI trade assistant" panel under the Scalping chart.
// Free, live in the browser: option chain (±10 strikes, CE/PE) over the same Zerodha WebSocket -> OI, OI change, PCR,
// max pain, support/resistance, IV and Greeks. Paid, only on the "Scan trade" button: ONE Claude (Haiku) call with the
// whole picture -> BUY CE / BUY PE / WAIT + entry/target/SL + reasons. The AI never places an order; "Smart order mein
// bharo" only fills the order form, and you press BUY yourself.
import { chainSummary, contractGreeks, indicatorSummary, resample, compact } from "./optanalytics.mjs";
import { IST } from "./kiteticks.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fk = (v) => (v == null ? "–" : Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(2) + "Cr" : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + "L" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v)));
const sgn = (v) => (v == null ? "" : v > 0 ? "+" : v < 0 ? "−" : "");
const hhmm = (ms) => new Date(ms + IST * 1000).toISOString().slice(11, 16);
const INDEX_OF = { BANKNIFTY: "NIFTY BANK", NIFTY: "NIFTY 50", FINNIFTY: "NIFTY FIN SERVICE", MIDCPNIFTY: "NIFTY MID SELECT" };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const nameOf = (u, exp, k, t) => { const [y, m, d] = exp.split("-"); return `${u} ${+d} ${MONTHS[+m - 1]} ${y.slice(2)} ${k} ${t}`; };
const HKEY = "sb-scalp-ai";
const EVERY = [30, 60, 120, 300];
const ANYTIME = location.hostname === "localhost" && /[?&]anytime=1/.test(location.search);      // test hook: ignore market hours
const SPEED = ANYTIME ? 10 : 1;                                                                     // tests: 30 s -> 3 s
const everyTxt = (s) => (s < 60 ? `${s} sec` : `${s / 60} min`);
// NSE cash/F&O hours: Mon-Fri 9:15 to 15:30 India time (exchange holidays are not known here)
function marketOpen(now = Date.now()) {
  if (ANYTIME) return true;
  const d = new Date(now + IST * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  return wd >= 1 && wd <= 5 && m >= 555 && m < 930;
}

export function mountAI(el, api) {
  const H = api.H;
  let opt = null, chain = null, byToken = new Map(), under = null, base0 = new Map(), baseAt = 0, scanBase = null, scanAt = 0;
  let usage = null, busy = false, last = null, drawT = 0, chainLoading = false, reloadAt = 0;
  // AI Scan ON/OFF: while ON, one scan every `every` seconds (next one starts only after the previous answer)
  let auto = false, autoT = null, nextAt = 0, fails = 0, every = 60;
  try { const e = +localStorage.getItem(HKEY + "-every"); if (EVERY.includes(e)) every = e; } catch {}
  setInterval(() => { const n = el.querySelector("#ainext"); if (n) n.innerHTML = nextTxt(); }, 1000);
  let history = []; try { history = JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch {}

  el.innerHTML = `<div class="panel-h"><h2>AI trade assistant</h2><span class="right"><span class="label">Haiku</span><span class="ai-use" id="aiuse"></span></span></div>
    <div class="panel-b"><div class="note">Option kholiye: option chain, OI aur Greeks yahan live dikhenge.</div></div>`;

  // ---------- contract + chain ----------
  async function setContract(target, meta) {
    const next = meta?.option ? { ...meta.option, symbol: target.symbol, lot: target.lot } : null;
    if (next && opt && chain && next.underlying === opt.underlying && next.expiry === opt.expiry) { opt = next; draw(); return; }   // same chain: keep it (and the last signal)
    opt = next;
    if (!opt && auto) stopAuto("Ye option nahi hai: AI Scan OFF.");
    chain = null; byToken = new Map(); under = null; base0 = new Map(); scanBase = null; last = null;
    if (!opt) { draw(); return; }
    const idx = INDEX_OF[opt.underlying];
    under = { symbol: idx + ".NS", name: idx, token: null, spot: null, prevClose: null };
    draw();
    await Promise.all([loadChain(true), loadUnder()]);
    if (H.isAdmin()) loadUsage();
  }
  async function loadUnder() {
    try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(under.symbol)}&interval=minute`, { cache: "no-store" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      under.token = d.instrument_token || null; under.prevClose = d.prevClose ?? null; under.spot ??= d.last ?? d.candles.at(-1)?.[4] ?? null;
      api.setTokens(tokens());
    } catch {}
  }
  async function loadChain(first = false) {
    if (chainLoading) return; chainLoading = true;
    try {
      const r = await fetch(`/api/chain?u=${encodeURIComponent(opt.underlying)}&expiry=${encodeURIComponent(opt.expiry)}`, { cache: "no-store" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      const old = chain; chain = d; byToken = new Map();
      for (const row of d.rows) for (const c of [row.ce, row.pe]) if (c) {
        const o = old?.rows.flatMap((x) => [x.ce, x.pe]).find((x) => x?.symbol === c.symbol);
        if (o && (c.oi == null || c.ltp == null)) { c.oi ??= o.oi; c.ltp ??= o.ltp; }
        if (c.token) byToken.set(c.token, c);
        if (!base0.has(c.symbol)) base0.set(c.symbol, { ltp: c.ltp, oi: c.oi });
      }
      if (first || !baseAt) baseAt = Date.now();
      if (under && d.spot) under.spot ??= d.spot;
      api.setTokens(tokens());
    } catch (e) { if (first) H.toast("Option chain nahi aayi: " + e.message); }
    finally { chainLoading = false; draw(); }
  }
  const tokens = () => [under?.token, ...byToken.keys()].filter(Boolean);
  const snapshot = () => new Map(chain ? chain.rows.flatMap((r) => [r.ce, r.pe]).filter(Boolean).map((c) => [c.symbol, { ltp: c.ltp, oi: c.oi }]) : []);

  function onTick(t) {
    const c = byToken.get(t.token);
    if (c) { c.ltp = t.ltp; if (t.oi != null) c.oi = t.oi; }
    else if (under && t.token === under.token) {
      under.spot = t.ltp; if (!under.prevClose && t.close) under.prevClose = t.close;
      // spot walked away from the loaded strikes: load the chain around the new ATM (at most once a minute)
      if (chain?.rows.length > 6 && Date.now() - reloadAt > 60000) {
        const ks = chain.rows.map((r) => r.strike), step = ks[1] - ks[0], mid = ks[Math.floor(ks.length / 2)];
        if (Math.abs(under.spot - mid) > 4 * step) { reloadAt = Date.now(); loadChain(); }
      }
    } else if (!(opt && t.token === api.state().target?.token)) return;
    if (Date.now() - drawT > 1000) drawLive();
  }

  // ---------- live view ----------
  function sum(base) { return chain && under?.spot ? chainSummary(chain.rows, under.spot, chain.expiry, base) : null; }
  function cg() { const st = api.state(); return opt && under?.spot && st.ltp ? contractGreeks({ ltp: st.ltp, spot: under.spot, strike: opt.strike, expiry: opt.expiry, type: opt.type }) : null; }
  const chipFn = (l, v, cls = "") => `<div class="ai-chip"><span>${l}</span><b class="${cls}">${v}</b></div>`;
  const oiCellFn = (c) => (c?.dOi ? `<small class="${c.dOi > 0 ? "up" : "down"}">${sgn(c.dOi)}${fk(Math.abs(c.dOi))}</small>` : "");
  const nearRows = (s) => (s ? s.rows.filter((r) => Math.abs(r.strike - s.atm) <= 4 * ((chain.rows[1]?.strike - chain.rows[0]?.strike) || 100)) : []);
  function drawLive() {                                     // every tick (max 1/s): only the numbers, never the buttons or the text box
    drawT = Date.now();
    if (!opt || !el.querySelector("#aichips")) return draw();
    const s = sum(base0);
    live(s, cg(), api.state(), 0, chipFn, nearRows(s), oiCellFn);
    const m = el.querySelector("#aimins"); if (m) m.textContent = Math.round((Date.now() - baseAt) / 60000);
  }
  function draw() {
    drawT = Date.now();
    if (!opt) { el.querySelector(".panel-b").innerHTML = `<div class="note">${api.state().target ? "Is contract ki option jaankari nahi mili." : "Option kholiye: option chain, OI aur Greeks yahan live dikhenge."}</div>`; useChip(); return; }
    const s = sum(base0), g = cg(), st = api.state();
    const mins = Math.round((Date.now() - baseAt) / 60000);
    const chip = (l, v, cls = "") => `<div class="ai-chip"><span>${l}</span><b class="${cls}">${v}</b></div>`;
    const near = s ? s.rows.filter((r) => Math.abs(r.strike - s.atm) <= 4 * ((chain.rows[1]?.strike - chain.rows[0]?.strike) || 100)) : [];
    const oiCell = (c) => (c?.dOi ? `<small class="${c.dOi > 0 ? "up" : "down"}">${sgn(c.dOi)}${fk(Math.abs(c.dOi))}</small>` : "");
    const box = el.querySelector(".panel-b");
    const keepQ = box.querySelector("#aiq")?.value ?? "", oq = box.querySelector("#aiq");
    const refocus = oq && document.activeElement === oq ? [oq.selectionStart, oq.selectionEnd] : null;   // keep typing while auto scans redraw
    box.innerHTML = `
      <div class="ai-chips" id="aichips"></div>
      <div class="ai-grid">
        <div><div class="label">Option chain live <small class="note" style="margin:0">(OI badlav: page khulne se, <span id="aimins">${mins}</span> min)</small></div>
          <div class="scroll"><table class="ai-ch tnum" id="aich"></table></div></div>
        <div class="ai-act">
          <textarea class="field ai-q" id="aiq" rows="2" maxlength="400" placeholder="Kuch khaas poochhna hai? (optional) jaise: 'Expiry se pehle PE lena theek hai?'">${esc(keepQ)}</textarea>
          <button class="btn sp-go ai-go" id="aigo" ${!H.isAdmin() || busy ? "disabled" : ""}>${busy ? "AI dekh raha hai…" : "Scan trade (1 AI call)"}</button>
          <div class="ai-auto ${auto ? "on" : ""}"><label class="switch"><input type="checkbox" id="aiauto" ${auto ? "checked" : ""} ${H.isAdmin() ? "" : "disabled"}><span></span>AI Scan ${auto ? "ON" : "OFF"}</label>
            <select class="sel ai-every" id="aievery" aria-label="Kitni der mein scan">${EVERY.map((x) => `<option value="${x}" ${x === every ? "selected" : ""}>har ${everyTxt(x)}</option>`).join("")}</select></div>
          <div class="note ai-next" id="ainext" style="margin:0">${nextTxt()}</div>
          <div class="note" style="margin:0">${H.isAdmin() ? `ON = AI har ${everyTxt(every)} khud naya signal dega (≈ ${Math.round(3600 / every)} call/ghanta). OFF = sirf button par. Chain/OI ka live hisaab muft hai.` : `AI ke liye <a href="#/keys">API Keys</a> mein login kariye.`}</div>
          <div class="ai-lim">${H.isAdmin() ? `<label class="label" for="ailim">Roz ki limit</label><input class="field" id="ailim" type="number" min="1" max="2000" step="1" value="${usage?.limit ?? ""}"><button class="btn2 sm" id="ailims">Save</button>` : ""}</div>
        </div>
      </div>
      <div id="aires">${last ? resultHtml(last) : ""}</div>
      ${history.length ? `<div class="label" style="margin-top:12px">Pichhle signals</div><div class="ai-hist tnum">${history.slice(0, 8).map((h) => `<div><time>${hhmm(h.at)}</time><b class="${h.signal === "WAIT" ? "" : h.signal === "BUY_CE" ? "up" : "down"}">${h.signal.replace("_", " ")}</b><span>${esc(h.name || "")}</span>${h.entry ? `<span>@ ${f2(h.entry)}</span>` : ""}<span class="note" style="margin:0">${h.confidence}%${h.auto ? " · auto" : ""}</span></div>`).join("")}</div>` : ""}`;
    live(s, g, st, mins, chip, near, oiCell);
    const q = (id) => box.querySelector("#" + id);
    q("aigo").onclick = () => scan(false);
    q("aiauto").onchange = (e) => (e.target.checked ? startAuto() : stopAuto("AI Scan OFF: ab AI apne aap scan nahi karega."));
    q("aievery").onchange = (e) => { every = +e.target.value; try { localStorage.setItem(HKEY + "-every", String(every)); } catch {} if (auto && !busy) go((every * 1000) / SPEED); draw(); };
    if (refocus) { const t = q("aiq"); t.focus(); t.setSelectionRange(refocus[0], refocus[1]); }
    if (q("ailims")) q("ailims").onclick = async () => { try { const d = await H.adminPost("ai-limit", { limit: +q("ailim").value }); usage = d.usage; useChip(); H.toast(`Roz ki AI limit ${usage.limit} scan ho gayi.`); } catch (e) { H.toast(e.message); } };
    wireResult();
    useChip();
  }
  function live(s, g, st, mins, chip, near, oiCell) {
    const c = el.querySelector("#aichips"); if (!c) return;
    const sc = under?.spot && under.prevClose ? under.spot - under.prevClose : null;
    c.innerHTML = [chip(esc(under?.name || "Spot"), f2(under?.spot) + (sc != null ? ` <small class="${sc >= 0 ? "up" : "down"}">${sgn(sc)}${f2(Math.abs(sc))}</small>` : "")),
      chip("PCR", s?.pcr ?? "–", s?.pcr > 1 ? "up" : s?.pcr < 0.8 ? "down" : ""), chip("Max pain", s?.maxPain ?? "–"),
      chip("Support (PE OI)", s?.support ?? "–", "up"), chip("Resistance (CE OI)", s?.resistance ?? "–", "down"), chip("ATM IV", s?.atmIv ? s.atmIv + "%" : "–"),
      chip("IV", g?.iv ? g.iv + "%" : "–"), chip("Delta", g?.delta ?? "–"), chip("Gamma", g?.gamma ?? "–"), chip("Theta/din", g?.theta != null ? f2(g.theta) : "–", "down"), chip("Vega", g?.vega != null ? f2(g.vega) : "–"),
      chip("Expiry", g ? `${g.daysToExpiry} din` : "–")].join("");
    const t = el.querySelector("#aich"); if (!t) return;
    const cur = st.target?.symbol;
    t.innerHTML = s ? `<thead><tr><th>OI Δ</th><th>CE OI</th><th>CE</th><th class="k">Strike</th><th>PE</th><th>PE OI</th><th>OI Δ</th></tr></thead><tbody>${near.map((r) => `<tr class="${r.strike === s.atm ? "atm" : ""}">
      <td>${oiCell(r.ce)}</td><td>${fk(r.ce?.oi)}</td><td class="${r.ce?.symbol === cur ? "me" : ""}">${f2(r.ce?.ltp)}</td><td class="k">${r.strike}</td>
      <td class="${r.pe?.symbol === cur ? "me" : ""}">${f2(r.pe?.ltp)}</td><td>${fk(r.pe?.oi)}</td><td>${oiCell(r.pe)}</td></tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="note">${chain ? "Spot ka daam aa raha hai…" : "Chain aa rahi hai…"}</td></tr></tbody>`;
  }
  async function loadUsage() { try { usage = (await H.adminGet("ai-usage")).usage; } catch {} draw(); }
  function useChip() { const u = el.querySelector("#aiuse"); if (u) u.textContent = usage ? `Aaj ${usage.used}/${usage.limit}` : ""; }

  // ---------- scan ----------
  async function payload() {
    const st = api.state(), now = Date.now();
    const [ob, ub] = await Promise.all([bars1m(opt.symbol), bars1m(under.symbol)]);
    if (!st.wsLive) await loadChain();                       // no live ticks: get fresh OI first
    const base = scanBase || base0, s = sum(base), g = cg();
    const cRow = s?.rows.flatMap((r) => [r.ce, r.pe]).find((c) => c?.symbol === opt.symbol);
    const closeIn = Math.round((Date.parse(new Date(now + IST * 1000).toISOString().slice(0, 10) + "T15:30:00+05:30") - now) / 60000);
    const depthQ = st.depth ? { buyQty: st.depth.buy.reduce((a, x) => a + x.qty, 0), sellQty: st.depth.sell.reduce((a, x) => a + x.qty, 0) } : null;
    return {
      time: hhmm(now) + " IST", minutesToMarketClose: closeIn,
      contract: { symbol: opt.symbol, name: opt.name, underlying: opt.underlying, type: opt.type, strike: opt.strike, expiry: opt.expiry, lot: opt.lot,
        ltp: st.ltp, bid: st.bid, ask: st.ask, spread: st.bid && st.ask ? +(st.ask - st.bid).toFixed(2) : null, oi: cRow?.oi ?? null, oiChange: cRow?.dOi ?? null,
        depth: depthQ, greeks: g, ind1m: indicatorSummary(ob), last30x1m: compact(ob, 30) },
      underlying: { name: under.name, spot: under.spot, prevClose: under.prevClose, ind1m: indicatorSummary(ub), ind5m: indicatorSummary(resample(ub, 300)), last20x5m: compact(resample(ub, 300), 20) },
      chain: s ? { expiry: chain.expiry, atm: s.atm, pcr: s.pcr, pcrBefore: s.pcrBase, maxPain: s.maxPain, support: s.support, resistance: s.resistance, atmIv: s.atmIv,
        changesSince: scanBase ? `last scan ${Math.round((now - scanAt) / 60000)} min ago` : `page opened ${Math.round((now - baseAt) / 60000)} min ago`,
        columns: ["strike", "CE symbol", "CE ltp", "CE OI", "CE OI chg", "PE symbol", "PE ltp", "PE OI", "PE OI chg", "CE IV%", "PE IV%"],
        rows: s.rows.map((r) => [r.strike, r.ce?.symbol ?? null, r.ce?.ltp ?? null, r.ce?.oi ?? null, r.ce?.dOi ?? null, r.pe?.symbol ?? null, r.pe?.ltp ?? null, r.pe?.oi ?? null, r.pe?.dOi ?? null, r.ce?.iv ?? null, r.pe?.iv ?? null]),
        topOiChanges: s.topChanges } : null,
    };
  }
  async function bars1m(sym) {
    try { const r = await fetch(`/api/candles?sym=${encodeURIComponent(sym)}&interval=minute`, { cache: "no-store" }); const d = await r.json(); if (!r.ok) return [];
      return d.candles.map(([t, o, h, l, c, v]) => ({ time: t + IST, open: o, high: h, low: l, close: c, volume: v || 0 })); } catch { return []; }
  }
  function nextTxt() {
    if (!auto) return "";
    if (busy) return `<b class="up">● AI Scan ON</b> · AI dekh raha hai…`;
    const s = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    return `<b class="up">● AI Scan ON</b> · agla scan ${s}s mein${usage ? ` · aaj ${usage.used}/${usage.limit}` : ""}`;
  }
  function startAuto() {
    if (!opt) { H.toast("Pehle option kholiye."); return draw(); }
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
  async function scan(isAuto = false) {
    if (busy || !opt) return false;
    if (!api.state().ltp) { if (!isAuto) H.toast("Abhi daam nahi aaya. Thoda ruk kar try kariye."); return false; }
    busy = true; draw();
    let ok = false;
    try {
      const p = await payload();
      const d = await H.adminPost("ai", { mode: "trade", payload: p, question: el.querySelector("#aiq")?.value || "" });
      usage = d.usage || usage; last = { ...d.result, ltpAt: p.contract.ltp, name: nameFor(d.result.symbol) };
      scanBase = snapshot(); scanAt = Date.now();
      const prev = history[0], name = last.signal === "WAIT" ? opt.name : last.name;
      if (isAuto && last.signal !== "WAIT" && (!prev || prev.signal !== last.signal || prev.name !== name))      // something new: tell the user
        H.toast(`🔔 Naya AI signal: ${last.signal.replace("_", " ")} ${name} @ ${f2(last.entry)}`);
      last.fresh = isAuto;
      history.unshift({ at: Date.now(), signal: last.signal, name, entry: last.entry, confidence: last.confidence, auto: isAuto });
      history = history.slice(0, 15); try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch {}
      ok = true;
    } catch (e) {
      if (/limit/.test(e.message)) { loadUsage(); if (auto) stopAuto(); }
      H.toast((isAuto ? "AI Scan: " : "") + e.message);
    }
    finally { busy = false; draw(); }
    return ok;
  }
  function nameFor(sym) {
    if (!sym) return "";
    for (const r of chain?.rows || []) for (const [c, t] of [[r.ce, "CE"], [r.pe, "PE"]]) if (c?.symbol === sym) return nameOf(opt.underlying, chain.expiry, r.strike, t);
    return sym === opt.symbol ? opt.name : sym.replace(/\.NFO$/, "");
  }
  function resultHtml(r) {
    const tone = r.signal === "BUY_CE" ? "up" : r.signal === "BUY_PE" ? "down" : "wait";
    const until = hhmm(Date.parse(r.at) + r.validMinutes * 60000);
    const rr = r.entry && r.target && r.stopLoss ? ((r.target - r.entry) / (r.entry - r.stopLoss)).toFixed(1) : null;
    return `<div class="ai-res ${tone}${r.fresh ? " fresh" : ""}">
      <div class="ai-top"><span class="ai-sig">${r.signal === "WAIT" ? "WAIT · abhi trade nahi" : r.signal.replace("_", " ")}</span>${r.symbol ? `<b>${esc(r.name)}</b>` : ""}
        <span class="ai-conf"><i style="width:${r.confidence}%"></i></span><span class="note" style="margin:0">${r.confidence}% bharosa · ${hhmm(Date.parse(r.at))} · ${until} tak</span></div>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}
      ${r.note ? `<div class="kres bad">${esc(r.note)}</div>` : ""}
      ${r.entry ? `<div class="ai-nums tnum"><span>Entry <b>${f2(r.entry)}</b></span><span>Target <b class="up">${f2(r.target)}</b></span><span>Stop-loss <b class="down">${f2(r.stopLoss)}</b></span>${rr ? `<span>Reward:Risk <b>${rr}</b></span>` : ""}<span>Scan ke waqt LTP <b>${f2(r.ltpAt)}</b></span></div>` : ""}
      <div class="rcols">${r.reasons.length ? `<div><div class="label">Kyon</div><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}${r.risks.length ? `<div><div class="label">Risk</div><ul>${r.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}</div>
      ${r.indicatorsUsed.length ? `<div class="note">AI ne dekha: ${esc(r.indicatorsUsed.join(", "))} · news ${r.newsCount}</div>` : ""}
      ${r.entry ? `<div class="sp-cb"><button class="btn sm ${tone === "up" ? "btn-buy" : "btn-sell"}" id="aifill">Smart order mein bharo</button><span class="note" style="margin:0">Order aap khud BUY dabakar lagayenge.</span></div>` : ""}
      <div class="note">AI ki salah hai, guarantee nahi. Ye investment advice nahi hai.</div></div>`;
  }
  function wireResult() {
    const b = el.querySelector("#aifill"); if (!b || !last?.entry) return;
    b.onclick = async () => {
      if (Date.now() - Date.parse(last.at) > last.validMinutes * 60000 && !confirm("Ye signal purana ho gaya hai. Phir bhi form mein bharein?")) return;
      const ok = await api.applySignal({ symbol: last.symbol, name: last.name, lot: opt.lot, entry: last.entry, target: last.target, stopLoss: last.stopLoss });
      if (ok) H.toast("Smart order form bhar diya. Check karke BUY dabaiye.");
    };
  }
  return { setContract, onTick, isAuto: () => auto, refresh: () => { if (H.isAdmin() && opt && !usage) loadUsage(); else draw(); }, tokens };
}

export const AI_CSS = `
.ai-use{font-size:11.5px;font-weight:600;color:var(--text-2);background:var(--hover);border-radius:10px;padding:2px 8px}
.ai-chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:6px;margin-bottom:12px}
.ai-chip{border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 8px;background:var(--surface-2);min-width:0}
.ai-chip span{display:block;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ai-chip b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.ai-chip small{font-size:11px}
.ai-grid{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}@media(min-width:900px){.ai-grid{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}}
.ai-ch{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
.ai-ch th{font-size:10.5px;color:var(--muted);font-weight:600;text-transform:uppercase;padding:4px 6px;text-align:right}
.ai-ch td{padding:4px 6px;text-align:right;border-top:1px solid var(--line)}.ai-ch .k{text-align:center;font-weight:700}
.ai-ch tr.atm td{background:var(--accent-soft)}.ai-ch td.me{outline:1px solid var(--accent);outline-offset:-2px;font-weight:700}
.ai-act{display:grid;gap:8px;align-content:start}.ai-q{height:auto;padding:8px 10px;resize:vertical;line-height:1.4}
.ai-auto{display:flex;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--line-2);border-radius:var(--r-sm);padding:7px 10px}
.ai-auto.on{border-color:var(--pos);background:var(--pos-soft)}.ai-every{width:auto;height:30px}
.ai-res.fresh{animation:aiflash 1.2s ease-out}@keyframes aiflash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 0 transparent}}
.ai-lim{display:flex;gap:6px;align-items:center}.ai-lim .field{width:90px;height:30px}.ai-lim label{flex:1}
.ai-res{margin-top:14px;border:1px solid var(--line-2);border-radius:var(--r);padding:12px 14px;display:grid;gap:8px}
.ai-res.up{border-color:var(--pos);background:color-mix(in srgb,var(--pos) 6%,transparent)}.ai-res.down{border-color:var(--neg);background:color-mix(in srgb,var(--neg) 6%,transparent)}
.ai-res p{margin:0;font-size:13.5px;line-height:1.5}.ai-res ul{margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5}
.ai-top{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.ai-sig{font-weight:800;font-size:16px;letter-spacing:.02em}.ai-res.up .ai-sig{color:var(--pos)}.ai-res.down .ai-sig{color:var(--neg)}.ai-res.wait .ai-sig{color:var(--warn-ink)}
.ai-conf{width:80px;height:6px;border-radius:3px;background:var(--line-2);overflow:hidden}.ai-conf i{display:block;height:100%;background:var(--accent)}
.ai-nums{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted)}.ai-nums b{color:var(--ink)}
.ai-hist{display:grid;gap:4px;font-size:12px;margin-top:6px}.ai-hist div{display:flex;gap:10px;align-items:baseline;color:var(--text-2)}.ai-hist time{color:var(--muted)}
`;
