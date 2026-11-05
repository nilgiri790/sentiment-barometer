// Sentiment page settings, saved in Blobs store "sentiment" key "settings". Not secret (the page shows them to everyone);
// only the admin can change them.
export const DEFAULT_SETTINGS = {
  newsLang: "en",          // "en" = English India, "hi" = Hindi India (Google News edition)
  newsWindow: "3d",        // how far back Google News looks: 1d / 3d / 7d
  maxArticles: 40,         // headlines per stock per run (10..100)
  autoCollect: true,       // hourly collection on/off
  lookback: 3,             // default look-back on the page (1 / 3 / 7 / 14 days)
  reportLang: "hinglish",  // AI report language: "hinglish" | "english" | "hindi"
  reportLength: "short",   // "short" | "detailed"
};
const KEY = "settings";

export function cleanSettings(s = {}) {
  const d = DEFAULT_SETTINGS, o = { ...d };
  if (["en", "hi"].includes(s.newsLang)) o.newsLang = s.newsLang;
  if (["1d", "3d", "7d"].includes(s.newsWindow)) o.newsWindow = s.newsWindow;
  const m = Math.round(Number(s.maxArticles)); if (m >= 10 && m <= 100) o.maxArticles = m;
  if (typeof s.autoCollect === "boolean") o.autoCollect = s.autoCollect;
  if ([1, 3, 7, 14].includes(Number(s.lookback))) o.lookback = Number(s.lookback);
  if (["hinglish", "english", "hindi"].includes(s.reportLang)) o.reportLang = s.reportLang;
  if (["short", "detailed"].includes(s.reportLength)) o.reportLength = s.reportLength;
  return o;
}
export async function getSettings(store) { return cleanSettings((await store.get(KEY, { type: "json" })) || {}); }
export async function saveSettings(store, s) { const c = cleanSettings(s); await store.setJSON(KEY, c); return c; }

// Google News options from settings
export const NEWS_EDITIONS = { en: ["en-IN", "IN", "IN:en"], hi: ["hi", "IN", "IN:hi"] };
export const newsOpts = (s) => ({ lang: NEWS_EDITIONS[s.newsLang] || NEWS_EDITIONS.en, window: s.newsWindow, max: s.maxArticles });
