// Turn scored headlines into a barometer from -100 (lack of trust) to +100 (trust).
// Shared by the hourly function and the dashboard page, so both always agree.
// w = { halfLife, sources: {name: weight}, defaultWeight }

const parse = (iso) => {
  if (!iso) return null;
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return isNaN(d) ? null : d;
};

export function sourceWeight(source, w) {
  const s = (source || "").toLowerCase();
  for (const [name, val] of Object.entries(w.sources)) if (s.includes(name)) return val;
  return w.defaultWeight;
}

export function barometer(rows, w, now = new Date()) {
  let num = 0, den = 0, pos = 0, neg = 0, neu = 0;
  for (const r of rows) {
    const dt = parse(r.published);
    if (!dt || r.score == null) continue;
    const ageH = Math.max(0, (now - dt) / 36e5);
    const wt = 0.5 ** (ageH / w.halfLife) * sourceWeight(r.source, w);
    num += wt * r.score; den += wt;
    if (r.score > 0.15) pos++; else if (r.score < -0.15) neg++; else neu++;
  }
  const score = den ? Math.round((1000 * num) / den) / 10 : 0;
  return { score, count: pos + neg + neu, positive: pos, negative: neg, neutral: neu };
}

// Average (source weighted) sentiment per calendar day (UTC): {"YYYY-MM-DD": -100..100}
export function dailySeries(rows, w) {
  const by = {};
  for (const r of rows) {
    const dt = parse(r.published);
    if (!dt || r.score == null) continue;
    const k = dt.toISOString().slice(0, 10), sw = sourceWeight(r.source, w);
    by[k] ??= [0, 0]; by[k][0] += sw * r.score; by[k][1] += sw;
  }
  const out = {};
  for (const k of Object.keys(by).sort()) if (by[k][1]) out[k] = Math.round((1000 * by[k][0]) / by[k][1]) / 10;
  return out;
}

export function labelFor(score) {
  if (score >= 40) return "Strong trust";
  if (score >= 15) return "Trust";
  if (score > -15) return "Neutral";
  if (score > -40) return "Lack of trust";
  return "Strong lack of trust";
}

export const sinceIso = (days, now = new Date()) =>
  new Date(now - days * 864e5).toISOString().slice(0, 19);
