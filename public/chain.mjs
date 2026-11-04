// Option chain window (BANKNIFTY / NIFTY / FINNIFTY / MIDCPNIFTY). Data: GET /api/chain (Zerodha, live).
// Clicking a Call/Put price opens that contract in the Quote panel (where Buy/Sell lives).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (v == null ? "–" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const oiF = (v) => (v == null ? "–" : v >= 1e7 ? (v / 1e7).toFixed(2) + " Cr" : v >= 1e5 ? (v / 1e5).toFixed(2) + " L" : Number(v).toLocaleString("en-IN"));
const chgF = (v) => (v == null ? "–" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${f2(v)}</span>`);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const expF = (e) => { const [y, m, d] = e.split("-"); return `${+d} ${MON[+m - 1]} ${y}`; };

// Index name (as shown in the quote) -> option underlying
export const UNDERLYING_OF = { "NIFTY BANK": "BANKNIFTY", "NIFTY 50": "NIFTY", "NIFTY FIN SERVICE": "FINNIFTY", "NIFTY MID SELECT": "MIDCPNIFTY" };

export function openChain(underlying, { onPick } = {}) {
  const ov = document.createElement("div"); ov.className = "modal-bg";
  ov.innerHTML = `<div class="card modal chain-modal" role="dialog" aria-modal="true" aria-label="Option chain"></div>`;
  document.body.appendChild(ov);
  const m = ov.querySelector(".modal");
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  let expiry = "";

  const head = (d) => `<div class="ticket-h" style="--side:var(--accent)"><div><div class="ttl">${esc(underlying)} option chain</div>
      <div class="ltp">${d?.spot != null ? `Spot ${f2(d.spot)} · ` : ""}${d?.lot_size ? `Lot ${d.lot_size} · ` : ""}Zerodha · live</div></div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        ${d?.expiries ? `<select class="sel" data-exp aria-label="Expiry">${d.expiries.map((e) => `<option value="${e}"${e === d.expiry ? " selected" : ""}>${expF(e)}</option>`).join("")}</select>` : ""}
        <button class="icon-btn" data-r aria-label="Refresh" title="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/></svg></button>
        <button class="icon-btn" data-x aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div></div>`;

  const wire = (d) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-r]").onclick = load;
    const sel = m.querySelector("[data-exp]"); if (sel) sel.onchange = () => { expiry = sel.value; load(); };
    m.querySelectorAll("[data-sym]").forEach((b) => (b.onclick = () => { close(); onPick?.(b.dataset.sym, b.dataset.name); }));
  };

  async function load() {
    const keep = m.querySelector(".chain-wrap");
    if (!keep) m.innerHTML = `${head(null)}<div class="ticket-b"><div class="sk" style="height:320px"></div></div>`;
    else keep.style.opacity = ".5";
    wire(null);
    let d;
    try {
      const r = await fetch(`/api/chain?u=${encodeURIComponent(underlying)}&expiry=${encodeURIComponent(expiry)}`);
      d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    } catch (e) {
      m.innerHTML = `${head(null)}<div class="ticket-b"><div class="kres bad">Option chain nahi aayi: ${esc(e.message)}</div></div>`; wire(null); return;
    }
    expiry = d.expiry;
    const cell = (c, strike, t) => c?.ltp != null
      ? `<button class="ltpbtn" data-sym="${esc(c.symbol)}" data-name="${esc(`${underlying} ${expF(d.expiry)} ${strike} ${t}`)}" title="${esc(`${strike} ${t} kholiye`)}">${f2(c.ltp)}</button>` : "–";
    m.innerHTML = `${head(d)}
      <div class="chain-wrap scroll" style="max-height:min(62vh,620px)"><table class="tbl chain">
        <thead><tr><th class="r hide-m">OI</th><th class="r hide-m">Chg</th><th class="r">Call LTP</th><th class="c">Strike</th><th class="r">Put LTP</th><th class="r hide-m">Chg</th><th class="r hide-m">OI</th></tr></thead>
        <tbody>${d.rows.map((r) => {
          const itmC = d.spot != null && r.strike < d.spot, itmP = d.spot != null && r.strike > d.spot;
          return `<tr class="${r.strike === d.atm ? "atm" : ""}">
            <td class="r hide-m tnum${itmC ? " itm" : ""}">${oiF(r.ce?.oi)}</td><td class="r hide-m tnum${itmC ? " itm" : ""}">${chgF(r.ce?.chg)}</td>
            <td class="r tnum${itmC ? " itm" : ""}">${cell(r.ce, r.strike, "CE")}</td>
            <td class="c tnum strike">${r.strike}${r.strike === d.atm ? ` <span class="pill p-soon">ATM</span>` : ""}</td>
            <td class="r tnum${itmP ? " itm" : ""}">${cell(r.pe, r.strike, "PE")}</td>
            <td class="r hide-m tnum${itmP ? " itm" : ""}">${chgF(r.pe?.chg)}</td><td class="r hide-m tnum${itmP ? " itm" : ""}">${oiF(r.pe?.oi)}</td></tr>`; }).join("")}
        </tbody></table></div>
      <div class="ticket-f" style="justify-content:space-between;align-items:center"><span class="note" style="margin:0">Halka rang = in-the-money. Kisi daam par click karke wo option kholiye (Buy/Sell wahan).</span>
        <span class="note" style="margin:0">${new Date().toLocaleTimeString()}</span></div>`;
    wire(d);
    m.querySelector("tr.atm")?.scrollIntoView({ block: "center" });
  }
  load();
}
