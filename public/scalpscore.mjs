// "Score": a fixed-rule check of how many market factors point the same way, made by our code (no AI call).
// It is shown next to the AI's own confidence % and NOT sent to the AI, so the two can be compared fairly in the
// AI report card. Each factor votes +1 (calls / up), -1 (puts / down) or 0 (no clear side); missing data is skipped.
// Input = the same payload the AI gets (index 1m / 5m indicators, chain PCR + OI change rows, market context).

const near = (rows, atm, k = 5) => {                   // the ATM strike and k strikes either side
  const i = rows.findIndex((r) => r[0] === atm); if (i < 0) return rows;
  return rows.slice(Math.max(0, i - k), i + k + 1);
};

export function confluence(p) {
  const out = [], add = (k, label, side, txt) => out.push({ k, label, side, txt });
  const i1 = p?.index?.ind1m, i5 = p?.index?.ind5m, ch = p?.chain, mk = p?.market;
  const cross = (x) => (x?.ema9 != null && x?.ema21 != null ? (x.ema9 > x.ema21 ? 1 : x.ema9 < x.ema21 ? -1 : 0) : null);
  const t1 = cross(i1); if (t1 != null) add("t1", "1 min trend", t1, `EMA 9 ${t1 > 0 ? ">" : t1 < 0 ? "<" : "="} EMA 21`);
  const t5 = cross(i5); if (t5 != null) add("t5", "5 min trend", t5, `EMA 9 ${t5 > 0 ? ">" : t5 < 0 ? "<" : "="} EMA 21`);
  if (i1?.rsi14 != null) { const r = i1.rsi14; add("rsi", "RSI (1 min)", r >= 55 ? 1 : r <= 45 ? -1 : 0, `RSI ${Math.round(r)}${r >= 55 ? " (taakat upar)" : r <= 45 ? " (taakat neeche)" : " (beech mein)"}`); }
  const f = mk?.future;                                   // the index has no volume, so VWAP comes from the future
  if (f?.last && f?.vwap) { const s = f.last > f.vwap ? 1 : f.last < f.vwap ? -1 : 0; add("vwap", "Future VWAP", s, `Future ${s > 0 ? "VWAP ke upar" : s < 0 ? "VWAP ke neeche" : "VWAP par"}`); }
  if (ch?.pcr != null) { const r = ch.pcr; add("pcr", "PCR", r >= 1 ? 1 : r <= 0.8 ? -1 : 0, `PCR ${r}${r >= 1 ? " (put writing zyada)" : r <= 0.8 ? " (call writing zyada)" : " (beech mein)"}`); }
  if (Array.isArray(ch?.rows) && ch.rows.length) {         // OI added near the money: put writers = support (up), call writers = cap (down)
    let ce = 0, pe = 0; for (const r of near(ch.rows, ch.atm)) { ce += +r[4] || 0; pe += +r[8] || 0; }
    if (ce || pe) { const big = Math.max(Math.abs(ce), Math.abs(pe)), d = pe - ce, s = Math.abs(d) < big * 0.1 ? 0 : d > 0 ? 1 : -1;
      add("oi", "OI badlav (ATM ±5)", s, s > 0 ? "PE OI zyada juda (support)" : s < 0 ? "CE OI zyada juda (resistance)" : "CE / PE OI barabar"); }
  }
  const hw = (mk?.heavyweights || []).filter((h) => h[1] != null);
  if (hw.length) { const up = hw.filter((h) => h[1] > 0).length, dn = hw.filter((h) => h[1] < 0).length, s = up > hw.length / 2 ? 1 : dn > hw.length / 2 ? -1 : 0;
    add("hw", "Heavyweights", s, `${up}/${hw.length} upar`); }
  const n = out.length, bull = out.filter((x) => x.side > 0).length, bear = out.filter((x) => x.side < 0).length;
  return { n, bull, bear, items: out };
}

// the score for one signal: how many factors agree with BUY_CE (up) or BUY_PE (down)
export function scoreFor(c, signal) {
  if (!c?.n) return null;
  const side = signal === "BUY_CE" ? 1 : signal === "BUY_PE" ? -1 : 0;
  return { agree: side > 0 ? c.bull : side < 0 ? c.bear : null, n: c.n, side };
}
