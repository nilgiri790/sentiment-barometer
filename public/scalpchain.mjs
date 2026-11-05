// Scalping page market model + option chain panel (BANK NIFTY / NIFTY only).
// Loads /api/chain (±10 strikes of one expiry), keeps it live over the page's Zerodha WebSocket (LTP, OI, volume of every
// CE/PE + the index spot), and works out PCR, max pain, support / resistance by OI, IV, delta and OI change since the page
// opened. Click a CE or PE price to open that contract. All free: no AI call here.
import { chainSummary } from "./optanalytics.mjs";

export const INDICES = {
  BANKNIFTY: { key: "BANKNIFTY", label: "BANK NIFTY", index: "NIFTY BANK", sym: "NIFTY BANK.NS" },
  NIFTY: { key: "NIFTY", label: "NIFTY", index: "NIFTY 50", sym: "NIFTY 50.NS" },
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const optName = (u, exp, k, t) => { const [y, m, d] = exp.split("-"); return `${u} ${+d} ${MONTHS[+m - 1]} ${y.slice(2)} ${k} ${t}`; };
export const indexOfSymbol = (sym) => (/^BANKNIFTY/.test(sym) ? "BANKNIFTY" : /^NIFTY\d/.test(sym) ? "NIFTY" : null);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fk = (v) => (v == null ? "–" : Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(2) + "Cr" : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + "L" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v)));
const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");

// el: the chain table box; chipsEl: the index stat chips; api: {H, setTokens, onPick, onLoaded, current, aiPick, onSummary}
export function mountChain(el, chipsEl, api) {
  let idx = null, expiry = null, chain = null, byToken = new Map(), base0 = new Map(), baseAt = 0, seq = 0, loading = false, reloadAt = 0, drawT = 0, scrolled = false;
  const under = { symbol: null, name: null, token: null, spot: null, prevClose: null };

  async function setIndex(key, exp = null) {
    idx = INDICES[key]; expiry = exp; reset();
    Object.assign(under, { symbol: idx.sym, name: idx.index, token: null, spot: null, prevClose: null });
    draw(); await load(true);
  }
  async function setExpiry(e) { expiry = e; reset(); draw(); await load(true); }
  function reset() { chain = null; byToken = new Map(); base0 = new Map(); baseAt = 0; scrolled = false; api.setTokens([]); }
  function setUnder({ token, prevClose, spot }) {
    if (token) under.token = token; if (prevClose) under.prevClose = prevClose; if (spot && !under.spot) under.spot = spot;
    api.setTokens(tokens()); drawLive();
  }
  async function load(first = false) {
    if (!idx || (loading && !first)) return;
    const my = ++seq; loading = true;
    try {
      const r = await fetch(`/api/chain?u=${encodeURIComponent(idx.key)}${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ""}`, { cache: "no-store" }); const d = await r.json();
      if (my !== seq) return;
      if (!r.ok) throw new Error(d.error || r.status);
      const old = chain; chain = d; expiry = d.expiry; byToken = new Map();
      for (const row of d.rows) for (const c of [row.ce, row.pe]) if (c) {
        const o = old?.rows.flatMap((x) => [x.ce, x.pe]).find((x) => x?.symbol === c.symbol);
        if (o) { c.ltp = o.ltp ?? c.ltp; c.oi = o.oi ?? c.oi; c.volume = o.volume ?? c.volume; }      // keep live values over a fresh snapshot
        if (c.token) byToken.set(c.token, c);
        if (!base0.has(c.symbol)) base0.set(c.symbol, { ltp: c.ltp, oi: c.oi });
      }
      if (!baseAt) baseAt = Date.now();
      if (d.spot && !under.spot) under.spot = d.spot;
      api.setTokens(tokens()); api.onLoaded?.(d);
    } catch (e) { if (first && my === seq) { chain = null; api.H.toast("Option chain nahi aayi: " + e.message); } }
    finally { if (my === seq) { loading = false; draw(); } }
  }
  const tokens = () => [under.token, ...byToken.keys()].filter(Boolean);
  const snapshot = () => new Map(chain ? chain.rows.flatMap((r) => [r.ce, r.pe]).filter(Boolean).map((c) => [c.symbol, { ltp: c.ltp, oi: c.oi }]) : []);
  const summary = (base = base0) => (chain && under.spot ? chainSummary(chain.rows, under.spot, chain.expiry, base) : null);

  function onTick(t) {
    const c = byToken.get(t.token);
    if (c) { c.ltp = t.ltp; if (t.oi != null) c.oi = t.oi; if (t.volume != null) c.volume = t.volume; }
    else if (t.token && t.token === under.token) {
      under.spot = t.ltp; if (!under.prevClose && t.close) under.prevClose = t.close;
      if (chain?.rows.length > 6 && Date.now() - reloadAt > 60000) {          // spot left the loaded strikes: reload around the new ATM
        const ks = chain.rows.map((r) => r.strike), step = ks[1] - ks[0], mid = ks[Math.floor(ks.length / 2)];
        if (Math.abs(under.spot - mid) > 4 * step) { reloadAt = Date.now(); load(); }
      }
    } else return;
    if (Date.now() - drawT > 1000) drawLive();
  }

  function draw() {
    drawT = Date.now();
    if (!chain) { el.innerHTML = `<div class="note" style="padding:14px">${idx ? "Option chain aa rahi hai…" : ""}</div>`; chips(null); return; }
    el.innerHTML = `<table class="ch-t tnum"><thead><tr><th>OI Δ</th><th>OI</th><th>IV</th><th class="ce">CALL (CE)</th><th class="k">Strike</th><th class="pe">PUT (PE)</th><th>IV</th><th>OI</th><th>OI Δ</th></tr></thead><tbody id="chbody"></tbody></table>`;
    el.onclick = (e) => {
      const c = e.target.closest("[data-sym]"); if (!c) return;
      const row = chain.rows.find((r) => r.ce?.symbol === c.dataset.sym || r.pe?.symbol === c.dataset.sym), t = row.ce?.symbol === c.dataset.sym ? "CE" : "PE";
      api.onPick({ symbol: c.dataset.sym, name: optName(idx.key, chain.expiry, row.strike, t), lot_size: chain.lot_size, option: true });
    };
    drawLive();
  }
  function drawLive() {
    drawT = Date.now();
    const s = summary(); chips(s); api.onSummary?.(s);
    const body = el.querySelector("#chbody"); if (!body) return;
    const cur = api.current(), pick = api.aiPick(), rows = s ? s.rows : chain.rows.map((r) => ({ strike: r.strike, ce: r.ce, pe: r.pe }));
    const oi = (c) => (c?.dOi ? `<small class="${c.dOi > 0 ? "up" : "down"}">${sgn(c.dOi)}${fk(Math.abs(c.dOi))}</small>` : "");
    const px = (c, t) => (c ? `<td class="px ${t}${c.symbol === cur ? " me" : ""}${c.symbol === pick ? " ai" : ""}" data-sym="${esc(c.symbol)}" role="button" tabindex="0" title="${t === "ce" ? "Call" : "Put"} kholiye">${f2(c.ltp)}${c.symbol === pick ? `<i class="aib">AI</i>` : ""}</td>` : `<td></td>`);
    const itm = (k, t) => s && (t === "ce" ? k < under.spot : k > under.spot);
    body.innerHTML = rows.map((r) => `<tr class="${s && r.strike === s.atm ? "atm" : ""}">
      <td>${oi(r.ce)}</td><td class="${itm(r.strike, "ce") ? "itm" : ""}">${fk(r.ce?.oi)}</td><td class="iv">${r.ce?.iv ?? "–"}</td>${px(r.ce, "ce")}
      <td class="k">${r.strike}</td>${px(r.pe, "pe")}<td class="iv">${r.pe?.iv ?? "–"}</td><td class="${itm(r.strike, "pe") ? "itm" : ""}">${fk(r.pe?.oi)}</td><td>${oi(r.pe)}</td></tr>`).join("");
    if (!scrolled && s) { const a = body.querySelector("tr.atm"); if (a) { el.scrollTop = Math.max(0, a.offsetTop - el.clientHeight / 2); scrolled = true; } }
  }
  function chips(s) {
    const chip = (l, v, cls = "") => `<div class="ai-chip"><span>${l}</span><b class="${cls}">${v}</b></div>`;
    const days = chain ? Math.max(0, Math.round((Date.parse(`${chain.expiry}T15:30:00+05:30`) - Date.now()) / 864e5 * 10) / 10) : null;
    chipsEl.innerHTML = [chip("PCR", s?.pcr ?? "–", s?.pcr > 1 ? "up" : s?.pcr < 0.8 ? "down" : ""), chip("Max pain", s?.maxPain ?? "–"),
      chip("Support (PE OI)", s?.support ?? "–", "up"), chip("Resistance (CE OI)", s?.resistance ?? "–", "down"), chip("ATM", s?.atm ?? "–"),
      chip("ATM IV", s?.atmIv ? s.atmIv + "%" : "–"), chip("Expiry", days != null ? `${days} din` : "–")].join("");
  }
  return {
    setIndex, setExpiry, setUnder, onTick, summary, snapshot, reload: () => load(), draw: drawLive,
    get idx() { return idx; }, get chain() { return chain; }, get under() { return under; }, base0: () => base0, baseAt: () => baseAt,
    ready: () => !!(chain && under.spot),
  };
}

export const CHAIN_CSS = `
.ch-box{max-height:440px;overflow:auto}
.ch-t{width:100%;border-collapse:collapse;font-size:12px}
.ch-t th{position:sticky;top:0;z-index:1;background:var(--surface);font-size:10.5px;color:var(--muted);font-weight:600;text-transform:uppercase;padding:6px;text-align:right;border-bottom:1px solid var(--line)}
.ch-t th.ce{color:var(--pos)}.ch-t th.pe{color:var(--neg)}.ch-t th.k,.ch-t td.k{text-align:center}
.ch-t td{padding:5px 6px;text-align:right;border-top:1px solid var(--line);white-space:nowrap}
.ch-t td.k{font-weight:700;background:var(--surface-2)}
.ch-t td.iv{color:var(--muted)}.ch-t td.itm{background:color-mix(in srgb,var(--warn) 7%,transparent)}
.ch-t td.px{cursor:pointer;font-weight:600;position:relative}.ch-t td.px:hover{background:var(--accent-soft);color:var(--accent)}
.ch-t td.px.me{outline:2px solid var(--accent);outline-offset:-2px}
.ch-t td.px.ai{background:color-mix(in srgb,var(--accent) 14%,transparent)}
.ch-t .aib{font-style:normal;font-size:9px;font-weight:800;margin-left:4px;padding:1px 4px;border-radius:3px;background:var(--accent);color:#fff;vertical-align:1px}
.ch-t tr.atm td{border-top:2px solid var(--accent)}
`;
