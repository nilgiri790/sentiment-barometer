// Market context bar on the Scalping page (above the charts): India VIX, the index future (premium, VWAP, OI build-up),
// heavyweight shares, the day type (opening range + VWAP), the expected move from the ATM straddle, previous-day levels
// (high / low / close, CPR, pivots) and your event calendar. Live over the page's WebSocket; all free (no AI).
import { buildup } from "./optanalytics.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const f0 = (v) => (v == null || !Number.isFinite(+v) ? "–" : Math.round(+v).toLocaleString("en-IN"));
const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
const sg = (v, d = 2) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);
const IST = 19800;
const istDay = (ms) => new Date(ms + IST * 1000).toISOString().slice(0, 10);
const istMin = (ms) => { const d = new Date(ms + IST * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const fk = (v) => (v == null ? "–" : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + "L" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v)));

// api: {H, setTokens(list), spot(), summary() -> chain summary, expiry() -> chain expiry, onLevels()}
export function mountContext(el, api) {
  const H = api.H;
  let C = null, u = null, byTok = new Map(), or = null, fut0 = null, events = [], drawT = 0, showEv = false, show = { oi: true, px: true };
  try { Object.assign(show, JSON.parse(localStorage.getItem("sb-scalp-lv") || "{}")); } catch {}

  async function setIndex(key) {
    u = key; C = null; or = null; fut0 = null; byTok = new Map(); api.setTokens([]); draw();
    try {
      const [r, cr] = await Promise.all([fetch(`/api/context?u=${key}`, { cache: "no-store" }), fetch(`/api/candles?sym=${encodeURIComponent(key === "NIFTY" ? "NIFTY 50.NS" : "NIFTY BANK.NS")}&interval=minute`, { cache: "no-store" })]);
      const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
      if (u !== key) return;
      C = d; fut0 = d.fut ? { oi: d.fut.oi, last: d.fut.last } : null;
      for (const x of [d.vix, d.fut, ...(d.heavy || [])]) if (x?.token) byTok.set(x.token, x);
      api.setTokens([...byTok.keys()]);
      const cd = await cr.json().catch(() => ({})), today = istDay(Date.now());
      const first = (cd.candles || []).filter(([t]) => istDay(t * 1000) === today && istMin(t * 1000) < 570);   // 9:15 - 9:30
      if (first.length) or = { h: Math.max(...first.map((c) => c[2])), l: Math.min(...first.map((c) => c[3])), done: first.length >= 15 || istMin(Date.now()) >= 570 };
    } catch (e) { C = { error: e.message }; }
    if (H.isAdmin()) { try { events = (await H.adminGet("events")).events || []; } catch {} }
    draw(); api.onLevels?.();
  }
  function onTick(t) {
    const x = byTok.get(t.token); if (!x) return;
    x.last = t.ltp; if (t.oi != null && x === C?.fut) x.oi = t.oi; if (t.avg && x === C?.fut) x.avg = t.avg;
    if (!x.prevClose && t.close) x.prevClose = t.close;
    if (Date.now() - drawT > 1500) draw();
  }
  // opening range keeps growing until 9:30 from live index prices
  function onSpot(px) { const m = istMin(Date.now()); if (m >= 555 && m < 570) { or = or ? { h: Math.max(or.h, px), l: Math.min(or.l, px), done: false } : { h: px, l: px, done: false }; } }

  function dayType() {
    const spot = api.spot(), f = C?.fut;
    if (!or || !spot) return { t: "–", cls: "" };
    if (!or.done && istMin(Date.now()) < 570) return { t: "Opening range ban rahi hai (9:30 tak)", cls: "" };
    const aboveV = f?.avg ? f.last >= f.avg : null;
    if (spot > or.h && aboveV !== false) return { t: "📈 Trend UP (OR ke upar, VWAP ke upar)", cls: "up" };
    if (spot < or.l && aboveV !== true) return { t: "📉 Trend DOWN (OR ke neeche, VWAP ke neeche)", cls: "down" };
    return { t: "↔ Range: OR ke andar ya mixed. Scalping mein saavdhaan", cls: "warn" };
  }
  function straddle() {
    const s = api.summary(); if (!s) return null;
    const row = s.rows.find((r) => r.strike === s.atm), v = (row?.ce?.ltp || 0) + (row?.pe?.ltp || 0);
    return v > 0 ? { v, lo: s.atm - v, hi: s.atm + v, atm: s.atm } : null;
  }
  function levels() {
    if (!C?.index) return null;
    const p = C.index, st = straddle();
    return { pdh: p.prevDay?.h, pdl: p.prevDay?.l, pdc: p.prevDay?.c, r1: p.pivots?.r1, s1: p.pivots?.s1, cpr: p.cpr?.p, orh: or?.h, orl: or?.l, expHi: st?.hi, expLo: st?.lo, show };
  }
  function draw() {
    drawT = Date.now();
    if (!u) { el.innerHTML = ""; return; }
    if (!C) { el.innerHTML = `<div class="cx-b"><span class="note" style="margin:0">Market context aa raha hai…</span></div>`; return; }
    if (C.error) { el.innerHTML = `<div class="cx-b"><span class="note" style="margin:0">Market context nahi aaya: ${esc(C.error)}</span></div>`; return; }
    const v = C.vix, f = C.fut, spot = api.spot(), dt = dayType(), st = straddle(), lv = C.index;
    const vc = pct(v?.last, v?.prevClose), prem = f?.last && spot ? f.last - spot : null;
    const dOi = f?.oi != null && fut0?.oi != null ? f.oi - fut0.oi : null, b = dOi ? buildup(f.last - (fut0.last || f.last), dOi) : null;
    const heavy = (C.heavy || []).map((h) => ({ ...h, c: pct(h.last, h.prevClose) })), up = heavy.filter((h) => h.c > 0).length;
    const today = istDay(Date.now()), tomorrow = istDay(Date.now() + 864e5), exp = api.expiry();
    const evs = [...(exp === today ? [{ date: today, text: "⚠ Aaj expiry: theta tez, premium jaldi girta hai" }] : []), ...events.filter((e) => e.date === today || e.date === tomorrow)];
    const chip = (l, val, cls = "", title = "") => `<div class="cx-chip ${cls}" title="${esc(title)}"><span>${l}</span><b>${val}</b></div>`;
    el.innerHTML = `<div class="cx-b">
      ${chip("India VIX", `${f2(v?.last)} <small class="${vc > 0 ? "down" : "up"}">${sg(vc)}%</small>`, v?.last > 18 ? "hot" : "", "Darr ka meter: zyada = bade jhatke, premium mehenga")}
      ${f ? chip("Future", `${f0(f.last)} <small>prem ${prem == null ? "–" : sg(prem, 0)}</small>`, "", `${f.symbol.replace(/\.NFO$/, "")}`) : ""}
      ${f?.avg ? chip("Fut VWAP", `${f0(f.avg)} <small class="${f.last >= f.avg ? "up" : "down"}">${f.last >= f.avg ? "upar" : "neeche"}</small>`) : ""}
      ${f ? chip("Fut OI (page se)", `${dOi == null ? "–" : (dOi >= 0 ? "+" : "−") + fk(Math.abs(dOi))} <small class="${b === "long buildup" || b === "short covering" ? "up" : b ? "down" : ""}">${esc(b || "")}</small>`) : ""}
      ${chip("Din ka mizaaj", `<span class="${dt.cls}">${esc(dt.t)}</span>`, "wide", or ? `Opening range ${f0(or.l)} – ${f0(or.h)}` : "")}
      ${st ? chip("Expected move", `±${f0(st.v)} <small>${f0(st.lo)} – ${f0(st.hi)}</small>`, "", "ATM straddle (CE + PE) ke daam se market ka andaaza") : ""}
      ${lv?.prevDay ? chip("Kal ka H / L / C", `${f0(lv.prevDay.h)} / ${f0(lv.prevDay.l)} / ${f0(lv.prevDay.c)}`, "", `CPR ${f0(lv.cpr?.bc)} – ${f0(lv.cpr?.tc)} · R1 ${f0(lv.pivots?.r1)} · S1 ${f0(lv.pivots?.s1)}`) : ""}
      <div class="cx-heavy" title="Index ke bade shares: index inhi se chalta hai"><span class="label">Heavyweights ${up}/${heavy.length} upar</span>
        ${heavy.map((h) => `<span class="cx-h ${h.c > 0 ? "up" : h.c < 0 ? "down" : ""}">${esc(h.sym)} ${sg(h.c)}%</span>`).join("")}</div>
      <div class="cx-ev">${evs.map((e) => `<span class="cx-e">📅 ${e.date === today ? "Aaj" : "Kal"}: ${esc(e.text)}</span>`).join("")}
        <label class="cx-t"><input type="checkbox" data-lv="oi" ${show.oi ? "checked" : ""}> OI levels</label><label class="cx-t"><input type="checkbox" data-lv="px" ${show.px ? "checked" : ""}> Price levels</label>
        ${H.isAdmin() ? `<button type="button" class="btn2 sm" id="cxev">📅 Events</button>` : ""}</div>
      ${showEv ? evEditor() : ""}</div>`;
    el.querySelectorAll("[data-lv]").forEach((c) => (c.onchange = () => { show[c.dataset.lv] = c.checked; try { localStorage.setItem("sb-scalp-lv", JSON.stringify(show)); } catch {} api.onLevels?.(); }));
    const eb = el.querySelector("#cxev"); if (eb) eb.onclick = () => { showEv = !showEv; draw(); };
    if (showEv) wireEv();
  }
  function evEditor() {
    return `<div class="cx-edit"><div class="note" style="margin:0">Aane wale bade events (RBI policy, Fed, bade results). Aaj / kal ke event upar dikhenge.</div>
      ${events.map((e, i) => `<div class="cx-er"><span>${esc(e.date)}</span><span>${esc(e.text)}</span><button type="button" class="btn2 sm danger" data-del="${i}">×</button></div>`).join("")}
      <div class="cx-er"><input class="field" type="date" id="cxd"><input class="field" id="cxt" maxlength="80" placeholder="jaise: RBI policy 10 baje"><button type="button" class="btn sm" id="cxadd">Jodiye</button></div></div>`;
  }
  function wireEv() {
    const save = async (list) => { try { events = (await H.adminPost("events", { events: list })).events; draw(); } catch (e) { H.toast(e.message); } };
    el.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => save(events.filter((_, i) => i !== +b.dataset.del))));
    el.querySelector("#cxadd").onclick = () => { const d = el.querySelector("#cxd").value, t = el.querySelector("#cxt").value.trim(); if (!d || !t) return H.toast("Tareekh aur event dono likhiye."); save([...events, { date: d, text: t }]); };
  }
  return { setIndex, onTick, onSpot, draw, levels, dayType: () => dayType().t, data: () => C, vix: () => C?.vix?.last ?? null };
}

export const CONTEXT_CSS = `
.cx-b{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;padding:10px 12px}
.cx-chip{border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2);padding:5px 9px;display:grid;gap:1px;min-width:0}
.cx-chip span{font-size:10.5px;color:var(--muted);white-space:nowrap}.cx-chip b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.cx-chip small{font-size:11px;font-weight:600}
.cx-chip.hot{border-color:var(--neg)}.cx-chip.wide b{white-space:normal}.cx-chip .warn{color:var(--warn-ink)}
.cx-heavy{display:flex;flex-wrap:wrap;gap:5px;align-items:center;flex-basis:100%}.cx-h{font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:10px;background:var(--hover)}
.cx-h.up{color:var(--pos);background:var(--pos-soft)}.cx-h.down{color:var(--neg);background:var(--neg-soft)}
.cx-ev{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex-basis:100%}.cx-e{font-size:12px;font-weight:600;color:var(--warn-ink);background:var(--warn-bg);padding:3px 8px;border-radius:var(--r-sm)}
.cx-t{font-size:11.5px;color:var(--text-2);display:inline-flex;gap:4px;align-items:center}.cx-ev .btn2{margin-left:auto}
.cx-edit{flex-basis:100%;display:grid;gap:6px;border:1px solid var(--line);border-radius:var(--r-sm);padding:10px;background:var(--surface-2)}
.cx-er{display:grid;grid-template-columns:150px 1fr auto;gap:8px;align-items:center;font-size:12.5px}.cx-er .field{height:30px}
@media(max-width:600px){.cx-er{grid-template-columns:1fr}}
`;
