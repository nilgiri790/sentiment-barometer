// "Trade summary" tab on the Scalping page: every finished trade (AI or yours, Paper or Asli) with P&L after charges,
// the exit, WHY it made / lost money and the lesson (AI review), totals, and what the AI has learned from losses.
// Data: GET / POST /api/admin/journal (saved on the server, same on every device).
import { computeStats, EXIT_TXT } from "./tradestats.mjs";
import { IST } from "./kiteticks.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const inr = (v) => (v == null || !Number.isFinite(+v) ? "–" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${Math.abs(+v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const istDay = (ms) => new Date(ms + IST * 1000).toISOString().slice(0, 10);
const when = (iso) => { const d = new Date(Date.parse(iso) + IST * 1000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}`; };
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const short = (n) => String(n || "").replace(/^(\S+) \d+ [A-Z]{3} \d\d /, "$1 ");

export function mountJournal(el, api) {
  const H = api.H;
  let trades = [], F = { range: "today", who: "all", mode: "all" }, open = null, loaded = false;
  try { Object.assign(F, JSON.parse(localStorage.getItem("sb-scalp-tj") || "{}")); } catch {}

  async function load() {
    if (!H.isAdmin()) { trades = []; loaded = true; draw(); api.onChange?.(); return; }
    try { trades = (await H.adminGet("journal")).trades || []; } catch (e) { H.toast("Trade summary nahi aayi: " + e.message); }
    loaded = true; draw(); api.onChange?.();
  }
  async function add(trade) {
    try { const d = await H.adminPost("journal", { op: "add", trade }); trades = d.trades || trades; draw(); api.onChange?.(); return d.trade; }
    catch (e) { H.toast("Trade summary mein save nahi hua: " + e.message); return null; }
  }
  function filtered() {
    const now = Date.now(), today = istDay(now), week = istDay(now - 6 * 864e5);
    return trades.filter((t) => (F.range === "today" ? t.day === today : F.range === "week" ? t.day >= week : true)
      && (F.who === "all" || t.source === F.who) && (F.mode === "all" || t.mode === F.mode));
  }
  // today's AI trades for one mode (used by the AI's daily limits)
  function today(mode) {
    const d = istDay(Date.now()), l = trades.filter((t) => t.source === "ai" && t.mode === mode && t.day === d);
    return { trades: l.length, net: Math.round(l.reduce((a, t) => a + (t.net || 0), 0) * 100) / 100, lastLossAt: l.filter((t) => t.net < 0).map((t) => Date.parse(t.closedAt)).sort((a, b) => b - a)[0] || 0 };
  }
  function draw() {
    if (!H.isAdmin()) { el.innerHTML = `<section class="panel"><div class="panel-b"><div class="note">Trade summary ke liye <a href="#/keys">API Keys</a> mein login kariye.</div></div></section>`; return; }
    const list = filtered(), s = computeStats(list);
    const seg = (k, opts) => `<div class="seg" data-f="${k}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${F[k] === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const card = (l, v, cls = "", sub = "") => `<div class="tj-card"><span>${l}</span><b class="${cls}">${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const lessons = list.filter((t) => t.net != null && t.net <= 0 && t.review?.lesson).slice(0, 5);
    el.innerHTML = `
      <section class="panel"><div class="panel-b tj-bar">
        ${seg("range", [["today", "Aaj"], ["week", "7 din"], ["all", "Sab"]])}${seg("who", [["all", "Sab"], ["ai", "AI ke"], ["manual", "Aapke"]])}${seg("mode", [["all", "Paper + Asli"], ["paper", "Paper"], ["real", "Asli"]])}
        <button type="button" class="btn2 sm danger" id="tjclear" ${trades.some((t) => t.mode === "paper") ? "" : "disabled"}>Paper trades hatao</button>
      </div></section>
      <div class="tj-cards tnum">
        ${card("Net P&L (charges ke baad)", inr(s.net), tone(s.net), s.n ? `Charges ${inr(-s.charges)}` : "")}
        ${card("Trades", s.n, "", s.n ? `${s.wins} munafa · ${s.losses} nuksan` : "")}
        ${card("Jeet %", s.winRate == null ? "–" : s.winRate + "%", s.winRate >= 50 ? "up" : s.winRate != null ? "down" : "")}
        ${card("Avg munafa / nuksan", `${inr(s.avgWin)} / ${inr(s.avgLoss)}`)}
        ${card("Sabse accha / bura", `${inr(s.best)} / ${inr(s.worst)}`)}
      </div>
      ${lessons.length ? `<section class="panel tj-learn"><div class="panel-h"><h2>🧠 AI ne nuksan se kya seekha</h2><span class="right note" style="margin:0">Ye sabak agle AI scan mein bheje jaate hain</span></div>
        <div class="panel-b"><ul>${lessons.map((t) => `<li><b>${esc(short(t.name))}</b> <span class="down">${inr(t.net)}</span>: ${esc(t.review.lesson)}</li>`).join("")}</ul></div></section>` : ""}
      <section class="panel"><div class="panel-h"><h2>Har trade</h2><span class="right note" style="margin:0">Row dabaiye: wajah aur sabak</span></div>
        ${list.length ? `<div class="scroll"><table class="tbl tj-t tnum"><thead><tr><th>Samay</th><th>Strike</th><th>Kisne</th><th class="r">Qty</th><th class="r">Entry → Exit</th><th>Exit</th><th class="r">Net P&L</th></tr></thead><tbody>
          ${list.map((t) => `<tr class="tj-row${open === t.id ? " open" : ""}" data-id="${esc(t.id)}" tabindex="0">
            <td>${when(t.at)}</td><td><b>${esc(short(t.name))}</b></td>
            <td><span class="pill ${t.source === "ai" ? "p-opt" : "p-neu"}">${t.source === "ai" ? "AI" : "Aap"}</span> <span class="pill ${t.mode === "real" ? "p-pos" : "p-soon"}">${t.mode === "real" ? "Asli" : "Paper"}</span></td>
            <td class="r">${t.qty}</td><td class="r">${f2(t.entry)} → ${f2(t.exit)}</td><td>${esc(EXIT_TXT[t.exitReason] || t.exitReason)}</td>
            <td class="r"><b class="${tone(t.net)}">${inr(t.net)}</b></td></tr>
            ${open === t.id ? `<tr class="tj-det"><td colspan="7">${detail(t)}</td></tr>` : ""}`).join("")}
        </tbody></table></div>` : `<div class="panel-b"><div class="note">${loaded ? "Is filter mein koi trade nahi. Trade poora hote hi yahan aa jaayega (Paper trade bhi)." : "Trades aa rahe hain…"}</div></div>`}
      </section>`;
    el.querySelectorAll("[data-f]").forEach((g) => (g.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; F[g.dataset.f] = b.dataset.v; try { localStorage.setItem("sb-scalp-tj", JSON.stringify(F)); } catch {} draw(); }));
    el.querySelectorAll(".tj-row").forEach((r) => (r.onclick = r.onkeydown = (e) => { if (e.type === "keydown" && e.key !== "Enter") return; open = open === r.dataset.id ? null : r.dataset.id; draw(); }));
    const c = el.querySelector("#tjclear");
    if (c) c.onclick = async () => { if (!confirm("Saare Paper trades summary se hata dein? Asli trades rahenge.")) return; try { trades = (await H.adminPost("journal", { op: "clear", mode: "paper" })).trades; draw(); api.onChange?.(); } catch (e) { H.toast(e.message); } };
  }
  function detail(t) {
    const r = t.review || {};
    return `<div class="tj-d">
      <div class="tj-why ${tone(t.net)}"><b>${t.net > 0 ? "Munafa kyon hua" : "Nuksan kyon hua"}:</b> ${esc(r.reason || "–")}</div>
      ${r.lesson ? `<div class="tj-lesson">🧠 <b>Sabak:</b> ${esc(r.lesson)} <span class="note" style="margin:0">(${r.by === "ai" ? "AI review" : "simple hisaab"})</span></div>` : ""}
      <div class="tj-kv"><span>Plan</span><b>Target ${f2(t.plan?.target)} · SL trigger ${f2(t.plan?.slTrigger)} → ${f2(t.plan?.slLimit)} · chase ${t.plan?.chaseSec ?? "–"}s</b>
        <span>Daam chala</span><b>max +${f2(t.mfe)} upar · −${f2(t.mae)} neeche · ${dur(t.durationSec || 0)}</b>
        <span>Paisa</span><b>Gross ${inr(t.gross)} · charges ${inr(-(t.charges || 0))} · net <span class="${tone(t.net)}">${inr(t.net)}</span></b>
        ${t.ctx ? `<span>Market (entry par)</span><b>Spot ${f2(t.ctx.spot)} · PCR ${t.ctx.pcr ?? "–"} · ATM IV ${t.ctx.atmIv ?? "–"}% · Support ${t.ctx.support ?? "–"} · Resistance ${t.ctx.resistance ?? "–"}</b>` : ""}
        ${t.signal ? `<span>AI ne kyon liya</span><b>${t.signal.confidence}% bharosa${t.signal.summary ? ": " + esc(t.signal.summary) : ""}</b>` : ""}</div>
      ${t.signal?.reasons?.length ? `<ul class="tj-reasons">${t.signal.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }
  return { load, add, today, draw, list: () => trades };
}

export const JOURNAL_CSS = `
.sp-tabs{display:flex;gap:6px;margin-bottom:14px}.sp-tabs button{height:36px;padding:0 18px;font-size:13.5px}
.tj-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.tj-bar .btn2{margin-left:auto}
.tj-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin:14px 0}
.tj-card{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:12px 14px;display:grid;gap:4px}
.tj-card span{font-size:11.5px;color:var(--muted)}.tj-card b{font-size:20px;font-weight:700}.tj-card small{font-size:11.5px;color:var(--muted)}
.tj-learn{margin-bottom:14px}.tj-learn ul{margin:0;padding-left:18px;display:grid;gap:6px;font-size:13px;line-height:1.45}
.tj-t td{vertical-align:middle}.tj-row{cursor:pointer}.tj-row.open td{background:var(--accent-soft)}
.tj-det td{background:var(--surface-2)}
.tj-d{display:grid;gap:8px;font-size:13px;line-height:1.5;padding:4px 0}
.tj-why.up b{color:var(--pos)}.tj-why.down b{color:var(--neg)}
.tj-lesson{background:var(--accent-soft);border-radius:var(--r-sm);padding:7px 10px}
.tj-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12.5px}.tj-kv span{color:var(--muted)}.tj-kv b{font-weight:500}
.tj-reasons{margin:0;padding-left:18px;font-size:12.5px;color:var(--text-2)}
@media(max-width:600px){.tj-kv{grid-template-columns:1fr}.tj-bar .btn2{margin-left:0}}
`;
