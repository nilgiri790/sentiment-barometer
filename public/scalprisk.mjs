// "Risk meter" cockpit on the Scalping page (top of the right column): today's P&L against your daily loss limit, trades
// left, losing streak, the kill switch (locks new trades for the day), the PANIC button and the risk rules (⚙).
// Rules are saved on the server (GET / POST /api/admin/risk) and also checked there for real orders.
import { riskTodayOf } from "./tradestats.mjs";

const inr = (v) => (v == null || !Number.isFinite(+v) ? "–" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
export const RISK_DEFAULTS = { riskPerTrade: 500, maxLossDay: 2000, maxConsecLoss: 3, maxTradesDay: 10, spreadPct: 2, checklist: true, sqoffAt: "15:15" };

// api: {H, mode() -> "paper"|"real", trades() -> journal rows, onPanic(), live() -> bool, onChange()}
export function mountRisk(el, api) {
  const H = api.H;
  let risk = { ...RISK_DEFAULTS }, showSet = false, draft = {};
  async function load() {
    if (!H.isAdmin()) return draw();
    try { risk = (await H.adminGet("risk")).risk || risk; } catch {}
    draw(); api.onChange?.();
  }
  const today = () => riskTodayOf(api.trades(), api.mode(), risk);
  const blocked = () => today().locked;
  function draw() {
    const t = today(), m = api.mode(), used = Math.max(0, -t.net), pct = Math.min(100, (used / risk.maxLossDay) * 100);
    el.innerHTML = `<div class="panel-h"><h2>Risk meter</h2><span class="pill ${m === "real" ? "p-pos" : "p-soon"}">${m === "real" ? "ASLI" : "PAPER"}</span>
        <span class="right"><button type="button" class="btn2 sm" id="rkset" title="Risk ke niyam">⚙</button></span></div>
      <div class="panel-b rk-b">
        <div class="rk-row tnum"><span>Aaj P&L</span><b class="${t.net > 0 ? "up" : t.net < 0 ? "down" : ""}">${inr(t.net)}</b><span class="note" style="margin:0">limit −₹${risk.maxLossDay.toLocaleString("en-IN")}</span></div>
        <div class="rk-bar" title="Din ke nuksan ki limit kitni use hui"><i style="width:${pct}%" class="${pct >= 75 ? "hot" : ""}"></i></div>
        <div class="rk-grid tnum"><span>Trades</span><b>${t.trades}/${risk.maxTradesDay}</b><span>Lagataar loss</span><b class="${t.consec ? "down" : ""}">${t.consec}/${risk.maxConsecLoss}</b>
          <span>Risk / trade</span><b>₹${risk.riskPerTrade.toLocaleString("en-IN")}</b><span>Auto exit</span><b>${risk.sqoffAt}</b></div>
        <div class="rk-status ${t.locked ? "lock" : "ok"}">${t.locked ? `🔒 Aaj trading band: ${t.locked}. Kal phir khulega.` : "✅ Trading khula hai"}</div>
        <button type="button" class="btn rk-panic" id="rkpanic" ${api.live() ? "" : "disabled"} title="Chal raha trade turant band + AI band">🚨 PANIC: sab band karo</button>
        ${showSet ? `<div class="rk-set">
          <label><span>Har trade mein max risk ₹</span><input class="field" id="rk-riskPerTrade" type="number" min="50" step="50" value="${draft.riskPerTrade ?? risk.riskPerTrade}"></label>
          <label><span>Din ka max nuksan ₹</span><input class="field" id="rk-maxLossDay" type="number" min="100" step="100" value="${draft.maxLossDay ?? risk.maxLossDay}"></label>
          <label><span>Lagataar kitne loss par band</span><input class="field" id="rk-maxConsecLoss" type="number" min="1" max="20" value="${draft.maxConsecLoss ?? risk.maxConsecLoss}"></label>
          <label><span>Din mein max trade</span><input class="field" id="rk-maxTradesDay" type="number" min="1" max="200" value="${draft.maxTradesDay ?? risk.maxTradesDay}"></label>
          <label><span>Max spread %</span><input class="field" id="rk-spreadPct" type="number" min="0.1" max="20" step="0.1" value="${draft.spreadPct ?? risk.spreadPct}"></label>
          <label><span>Auto square-off</span><input class="field" id="rk-sqoffAt" type="time" min="09:15" max="15:25" value="${draft.sqoffAt ?? risk.sqoffAt}"></label>
          <label class="switch wide"><input type="checkbox" id="rk-checklist" ${(draft.checklist ?? risk.checklist) ? "checked" : ""}><span></span>Trade se pehle checklist</label>
          <div class="wide"><button type="button" class="btn sm" id="rksave">Save</button></div></div>` : ""}
      </div>`;
    el.querySelector("#rkset").onclick = () => { showSet = !showSet; draw(); };
    el.querySelector("#rkpanic").onclick = () => { if (confirm("PANIC: chal raha trade abhi ke daam par band karein aur AI band karein?")) api.onPanic(); };
    if (showSet) {
      el.querySelectorAll(".rk-set input").forEach((i) => (i.oninput = i.onchange = () => (draft[i.id.slice(3)] = i.type === "checkbox" ? i.checked : i.type === "time" ? i.value : +i.value)));
      el.querySelector("#rksave").onclick = async () => {
        try { risk = (await H.adminPost("risk", { risk: { ...risk, ...draft } })).risk; draft = {}; showSet = false; H.toast("Risk ke niyam save ho gaye."); draw(); api.onChange?.(); }
        catch (e) { H.toast(e.message); }
      };
    }
  }
  return { load, draw, today, blocked, settings: () => risk };
}

export const RISK_CSS = `
.rk-b{display:grid;gap:8px}
.rk-row{display:flex;align-items:baseline;gap:10px}.rk-row span{font-size:12px;color:var(--muted)}.rk-row b{font-size:20px;font-weight:700}
.rk-bar{height:6px;border-radius:3px;background:var(--line-2);overflow:hidden}.rk-bar i{display:block;height:100%;background:var(--warn)}.rk-bar i.hot{background:var(--neg)}
.rk-grid{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:4px 10px;font-size:12px}.rk-grid span{color:var(--muted)}.rk-grid b{font-weight:600}
.rk-status{font-size:12.5px;font-weight:600;padding:7px 10px;border-radius:var(--r-sm)}.rk-status.ok{background:var(--pos-soft);color:var(--pos)}.rk-status.lock{background:var(--neg-soft);color:var(--neg)}
.rk-panic{background:var(--neg) !important;width:100%;height:40px;font-size:14px;font-weight:800;letter-spacing:.02em}
.rk-set{display:grid;grid-template-columns:1fr 1fr;gap:8px;border:1px solid var(--line);border-radius:var(--r-sm);padding:10px;background:var(--surface-2)}
.rk-set label{display:grid;gap:3px;font-size:11px;color:var(--muted)}.rk-set .field{height:30px}.rk-set .wide{grid-column:1/-1}
`;
