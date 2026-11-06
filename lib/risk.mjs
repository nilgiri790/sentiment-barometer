// Scalping risk rules ("kill switch"), saved in Blobs store "admin" key "risk". They apply to EVERY trade from the Scalping
// page (yours and the AI's): max money at risk per trade, max loss per day, max losing trades in a row, max trades per day,
// max bid-ask spread, the pre-trade checklist and the auto square-off time. For real orders the server checks them too.
import { getJournal } from "./journal.mjs";
import { riskTodayOf } from "../public/tradestats.mjs";

export const RISK_DEFAULTS = { riskPerTrade: 500, maxLossDay: 2000, maxConsecLoss: 3, maxTradesDay: 10, spreadPct: 2, checklist: true, sqoffAt: "15:15" };

export function cleanRisk(s = {}) {
  const d = RISK_DEFAULTS, i = (v, lo, hi, def) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : def; };
  const f = (v, lo, hi, def) => { const n = Number(v); return n >= lo && n <= hi ? Math.round(n * 10) / 10 : def; };
  return {
    riskPerTrade: i(s.riskPerTrade, 50, 1000000, d.riskPerTrade), maxLossDay: i(s.maxLossDay, 100, 10000000, d.maxLossDay),
    maxConsecLoss: i(s.maxConsecLoss, 1, 20, d.maxConsecLoss), maxTradesDay: i(s.maxTradesDay, 1, 200, d.maxTradesDay),
    spreadPct: f(s.spreadPct, 0.1, 20, d.spreadPct), checklist: typeof s.checklist === "boolean" ? s.checklist : d.checklist,
    sqoffAt: /^(09|1[0-5]):[0-5]\d$/.test(String(s.sqoffAt || "")) && String(s.sqoffAt) <= "15:25" ? String(s.sqoffAt) : d.sqoffAt,
  };
}
export async function getRisk(store) { return cleanRisk({ ...RISK_DEFAULTS, ...((await store.get("risk", { type: "json" })) || {}) }); }
export async function saveRisk(store, s) { const c = cleanRisk({ ...(await getRisk(store)), ...s }); await store.setJSON("risk", c); return c; }

// today's numbers for one mode (shared with the page)
export const riskToday = riskTodayOf;
// returns an error text when a REAL BUY from the Scalping page must be refused
export async function riskGuard(store, now = Date.now()) {
  const risk = await getRisk(store), t = riskToday(await getJournal(store), "real", risk, now);
  return t.locked ? `🔒 Kill switch: ${t.locked}. Aaj ke liye naya trade band (kal phir khulega).` : null;
}
