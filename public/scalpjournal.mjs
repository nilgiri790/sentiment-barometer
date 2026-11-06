// "Trade summary" tab on the Scalping page: every finished trade (AI or yours, Paper or Asli) with P&L after charges,
// the exit, WHY it made / lost money and the lesson (AI review), totals, and what the AI has learned from losses.
// Data: GET / POST /api/admin/journal (saved on the server, same on every device).
import { computeStats, proStats, EXIT_TXT } from "./tradestats.mjs";
import { IST } from "./kiteticks.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null || !Number.isFinite(+v) ? "–" : (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const inr = (v) => (v == null || !Number.isFinite(+v) ? "–" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${Math.abs(+v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const istDay = (ms) => new Date(ms + IST * 1000).toISOString().slice(0, 10);
const when = (iso) => { const d = new Date(Date.parse(iso) + IST * 1000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}`; };
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const SETUP = { breakout: "Breakout", vwap: "VWAP", oi: "OI shift", reversal: "Reversal", range: "Range", ai: "AI", other: "Doosra" };
const MOOD = { planned: "Planned", fomo: "FOMO", revenge: "Revenge", bored: "Bas aise hi" };
const short = (n) => String(n || "").replace(/^(\S+) \d+ [A-Z]{3} \d\d /, "$1 ");

export function mountJournal(el, api) {
  const H = api.H;
  let trades = [], F = { range: "today", who: "all", mode: "all" }, open = null, loaded = false, sig = null, week = null, reviewing = false;
  try { Object.assign(F, JSON.parse(localStorage.getItem("sb-scalp-tj") || "{}")); } catch {}

  async function load() {
    if (!H.isAdmin()) { trades = []; loaded = true; draw(); api.onChange?.(); return; }
    try {
      const [j, g] = await Promise.all([H.adminGet("journal"), H.adminGet("signals").catch(() => null)]);
      trades = j.trades || []; week = j.weekReview || null; sig = g;
    } catch (e) { H.toast("Trade summary nahi aayi: " + e.message); }
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
    const list = filtered(), s = computeStats(list), ps = proStats(list);
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
        ${card("Har trade se average", inr(ps.expectancy), tone(ps.expectancy), "expectancy (charges ke baad)")}
        ${card("Max drawdown", ps.n ? inr(-ps.maxDD) : "–", ps.maxDD ? "down" : "", "sabse uchi kamai se sabse bada girav")}
        ${card("Average R", ps.avgR == null ? "–" : `${ps.avgR >= 0 ? "+" : ""}${ps.avgR}R`, tone(ps.avgR), "1R = jitna risk liya")}
        ${card("Average slippage", ps.avgSlip == null ? "–" : `${ps.avgSlip >= 0 ? "+" : ""}${f2(ps.avgSlip)}`, ps.avgSlip > 0 ? "down" : "", "socha vs bhara (BUY par + = mehenga)")}
      </div>
      ${ps.n >= 2 ? `<section class="panel"><div class="panel-h"><h2>📈 Equity curve</h2><span class="right note" style="margin:0">charges ke baad, trade dar trade</span></div><div class="panel-b">${curveSvg(ps.curve)}</div></section>` : ""}
      ${ps.n ? `<section class="panel"><div class="panel-h"><h2>🔍 Kab aur kaise jeet-te ho</h2></div><div class="panel-b tj-groups">
        ${grpTable("Samay", ps.bySlot)}${grpTable("CE / PE", ps.byType)}${grpTable("Din", ps.byExpiry)}${grpTable("Setup", ps.bySetup, SETUP)}${grpTable("Mann", ps.byMood, MOOD)}${grpTable("SL kahan", ps.bySl)}${grpTable("Kisne", ps.bySource)}
      </div></section>` : ""}
      ${reportCard()}
      ${weekCard()}
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
    const wb = el.querySelector("#tjweek");
    if (wb) wb.onclick = async () => { reviewing = true; draw(); try { week = (await H.adminPost("journal", { op: "week-review" })).review; } catch (e) { H.toast(e.message); } reviewing = false; draw(); };
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
        <span>Paisa</span><b>Gross ${inr(t.gross)} · charges ${inr(-(t.charges || 0))} · net <span class="${tone(t.net)}">${inr(t.net)}</span>${t.r != null ? ` · <span class="${tone(t.r)}">${t.r >= 0 ? "+" : ""}${t.r}R</span>` : ""}</b>
        <span>Tareeka</span><b>${t.setup ? SETUP[t.setup] || t.setup : "–"} · mann: ${t.mood ? MOOD[t.mood] || t.mood : "–"} · ${t.hardSl ? "🛡 Zerodha SL" : "Page SL"}${t.slip != null ? ` · slippage ${t.slip >= 0 ? "+" : ""}${f2(t.slip)}` : ""}${t.expiryDay ? " · expiry din" : ""}</b>
        ${t.ctx ? `<span>Market (entry par)</span><b>Spot ${f2(t.ctx.spot)} · PCR ${t.ctx.pcr ?? "–"} · ATM IV ${t.ctx.atmIv ?? "–"}% · Support ${t.ctx.support ?? "–"} · Resistance ${t.ctx.resistance ?? "–"}</b>` : ""}
        ${t.signal ? `<span>AI ne kyon liya</span><b>${t.signal.confidence}% bharosa${t.signal.summary ? ": " + esc(t.signal.summary) : ""}</b>` : ""}</div>
      ${t.signal?.reasons?.length ? `<ul class="tj-reasons">${t.signal.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }
  function curveSvg(c) {
    const W = 600, Hh = 140, xs = c.map((_, i) => i), ys = [0, ...c.map((p) => p[1])], lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const X = (i) => 8 + (i / Math.max(1, xs.length - 1)) * (W - 16), Y = (v) => 8 + (1 - (v - lo) / span) * (Hh - 16);
    const pts = c.map((p, i) => `${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" "), last = c.at(-1)[1];
    return `<svg class="tj-curve" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" class="z"/><polyline points="${pts}" class="${last >= 0 ? "up" : "down"}"/>
      ${c.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p[1])}" r="2.5" class="${p[1] >= 0 ? "up" : "down"}"><title>${inr(p[1])}</title></circle>`).join("")}</svg>`;
  }
  function grpTable(title, g, names = {}) {
    const rows = Object.entries(g || {}); if (!rows.length) return "";
    return `<table class="tj-g tnum"><thead><tr><th>${title}</th><th class="r">Trade</th><th class="r">Jeet</th><th class="r">Net</th></tr></thead><tbody>
      ${rows.sort((a, b) => b[1].net - a[1].net).map(([k, v]) => `<tr><td>${esc(names[k] || k)}</td><td class="r">${v.n}</td><td class="r">${Math.round((v.wins / v.n) * 100)}%</td><td class="r ${tone(v.net)}">${inr(v.net)}</td></tr>`).join("")}</tbody></table>`;
  }
  function reportCard() {
    const st = sig?.stats; if (!st?.all?.n) return `<section class="panel"><div class="panel-h"><h2>🎯 AI report card</h2></div><div class="panel-b"><div class="note">AI ke signals ka hisaab yahan aayega: har signal ke baad page dekhta hai ki pehle target aaya ya SL (bina trade kiye bhi).</div></div></section>`;
    const row = (l, x) => `<tr><td>${l}</td><td class="r">${x.n}</td><td class="r up">${x.target}</td><td class="r down">${x.sl}</td><td class="r">${x.none}</td><td class="r"><b>${x.hitRate ?? "–"}${x.hitRate != null ? "%" : ""}</b></td></tr>`;
    return `<section class="panel"><div class="panel-h"><h2>🎯 AI report card</h2><span class="right note" style="margin:0">AI ka signal sach mein kitni baar sahi nikla (live daam par)</span></div><div class="panel-b">
      <table class="tj-g tnum"><thead><tr><th>Signal</th><th class="r">Kul</th><th class="r">Target pehle</th><th class="r">SL pehle</th><th class="r">Kuch nahi</th><th class="r">Sahi %</th></tr></thead><tbody>
      ${row("Sab", st.all)}${row("AI 70%+ bharosa", st.hi)}${row("AI 70% se kam", st.lo)}${st.scHi ? row("Score 70%+ (jaise 5/7)", st.scHi) + row("Score 50–69% (4/7)", st.scMid) + row("Score 50% se kam", st.scLo) + row("Dono: AI 70%+ aur score 70%+", st.both) : ""}${row("CE", st.ce)}${row("PE", st.pe)}</tbody></table>
      <div class="tj-sigs">${(sig.signals || []).slice(0, 10).map((x) => `<span class="pill ${x.outcome === "target" ? "p-pos" : x.outcome === "sl" ? "p-neg" : "p-neu"}" title="${esc(x.name)} · AI ${x.confidence}%${x.score != null ? ` · score ${x.score}/${x.scoreN}` : ""}">${esc(short(x.name))} ${x.outcome === "target" ? "✓" : x.outcome === "sl" ? "✗" : "–"}</span>`).join("")}</div>
      <div class="note">"AI %" = AI ka apna andaaza. "Score" = hamare code ka niyam (kitni cheezein signal ke saath). 2–3 hafte baad jiska "Sahi %" zyada ho, Auto trade mein usi ki shart lagaiye (⚙ Settings). AI wala hisaab agle scan mein AI ko bhi bheja jaata hai.</div></div></section>`;
  }
  function weekCard() {
    return `<section class="panel"><div class="panel-h"><h2>🧠 Hafte ka AI review</h2><span class="right"><button type="button" class="btn sm" id="tjweek" ${reviewing ? "disabled" : ""}>${reviewing ? "AI padh raha hai…" : "Is hafte ka review (1 AI call)"}</button></span></div>
      <div class="panel-b">${week ? `<p class="tj-ws">${esc(week.summary)}</p><div class="rcols">
        <div><div class="label">Achha kiya</div><ul>${week.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div><div class="label">Galtiyan</div><ul>${week.mistakes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
        <div class="label" style="margin-top:8px">Agle hafte ke niyam</div><ol class="tj-rules">${week.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
        <div class="note">${when(week.at)} · ${week.trades} trades par</div>` : `<div class="note">Pichhle 7 din ke saare trades dekhkar AI batayega: kahan paisa banta hai, kahan galti hoti hai, aur agle hafte ke niyam.</div>`}</div></section>`;
  }
  return { load, add, today, draw, list: () => trades };
}

export const JOURNAL_CSS = `
.sp-tabs{display:flex;gap:6px;margin-bottom:14px}.sp-tabs button{height:36px;padding:0 18px;font-size:13.5px}
.tj-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.tj-bar .btn2{margin-left:auto}
.tj-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin:14px 0}
.tj-card{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:12px 14px;display:grid;gap:4px}
.tj-card span{font-size:11.5px;color:var(--muted)}.tj-card b{font-size:20px;font-weight:700}.tj-card small{font-size:11.5px;color:var(--muted)}
.tj-curve{width:100%;height:140px;display:block}.tj-curve polyline{fill:none;stroke-width:2}.tj-curve .up{stroke:var(--pos);fill:var(--pos)}.tj-curve polyline.up{fill:none}
.tj-curve .down{stroke:var(--neg);fill:var(--neg)}.tj-curve polyline.down{fill:none}.tj-curve .z{stroke:var(--line-2);stroke-dasharray:4 4}
.tj-groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.tj-g{width:100%;border-collapse:collapse;font-size:12.5px}.tj-g th{font-size:10.5px;color:var(--muted);text-transform:uppercase;font-weight:600;text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}
.tj-g td{padding:4px 6px;border-bottom:1px solid var(--line)}.tj-g .r{text-align:right}
.tj-sigs{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}.p-neg{background:var(--neg-soft);color:var(--neg)}
.tj-ws{margin:0 0 8px;font-size:13.5px;line-height:1.5}.tj-rules{margin:4px 0 0;padding-left:20px;font-size:13px;line-height:1.55}
.tj-cards+section,.tj-groups{margin-bottom:0}#sptj>section{margin-bottom:14px}
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
