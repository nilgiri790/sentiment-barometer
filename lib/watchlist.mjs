// The stocks shown on the dashboard (and collected every hour). Saved in Blobs store "sentiment", key "watchlist".
// Starts with the stocks in config.mjs; the admin adds/removes them from the website.
import { STOCKS } from "./config.mjs";

export const MAX_STOCKS = 25;            // keeps the hourly news run inside Netlify's time limit
const KEY = "watchlist";

// Friendly Google News queries for indices.
const INDEX_QUERY = { "NIFTY BANK": "Bank Nifty", "NIFTY 50": "Nifty 50", "NIFTY FIN SERVICE": "Fin Nifty", "NIFTY IT": "Nifty IT index",
  "NIFTY MID SELECT": "Nifty Midcap Select", "INDIA VIX": "India VIX" };

export async function getWatchlist(store) {
  const saved = await store.get(KEY, { type: "json" });
  if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
  return Object.fromEntries(Object.entries(STOCKS).map(([k, v]) => [k, { ...v }]));
}
export const saveWatchlist = (store, list) => store.setJSON(KEY, list);

// From a search result ({symbol:"ITC.NS", name:"ITC LTD", index?}) to a watchlist entry. Options are not allowed.
export function entryFrom({ symbol, name = "", index = false } = {}) {
  const m = /^([A-Z0-9&\-_. ]{1,40})\.(NS|BO)$/i.exec(String(symbol || "").trim());
  if (!m) return { error: "Sirf NSE/BSE ke share ya index (jaise ITC, NIFTY BANK) dashboard par add ho sakte hain." };
  const key = m[1].toUpperCase().trim(), ticker = `${key}.${m[2].toUpperCase()}`;
  if (index) return { key, entry: { query: INDEX_QUERY[key] || key, ticker, name: name || key, index: true } };
  const clean = String(name || key).replace(/\b(LIMITED|LTD)\b\.?/gi, "").replace(/\s+/g, " ").trim() || key;
  return { key, entry: { query: `${clean} share`, ticker, name: name || key } };
}
