// One pipeline run: fetch news -> keep new ones -> score -> save. Storage is Netlify Blobs.
import { KEEP_DAYS, CLAUDE_MODEL, HALF_LIFE_HOURS, SOURCE_WEIGHTS, DEFAULT_SOURCE_WEIGHT } from "./config.mjs";
import { fetchStockNews } from "./news.mjs";
import { scoreRows } from "./sentiment.mjs";
import { sinceIso } from "../public/barometer.mjs";
import { getWatchlist } from "./watchlist.mjs";

export const WEIGHTS = { halfLife: HALF_LIFE_HOURS, sources: SOURCE_WEIGHTS, defaultWeight: DEFAULT_SOURCE_WEIGHT };
const keyFor = (stock) => `articles-${stock}`;

export async function collectStock(store, stock, info, opts = {}) {
  const old = (await store.get(keyFor(stock), { type: "json" })) || [];
  const seen = new Set(old.map((a) => a.url));
  const items = await fetchStockNews(info.query, opts.fetchImpl, opts.newsTimeout);
  const fresh = items.filter((i) => !seen.has(i.url) && (seen.add(i.url), true));
  const all = [...fresh, ...old];
  const todo = all.filter((a) => a.score == null).sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  const scored = await scoreRows(stock, todo, opts);
  const cutoff = sinceIso(KEEP_DAYS, opts.now);
  const kept = all.filter((a) => !a.published || a.published >= cutoff)
    .sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  await store.setJSON(keyFor(stock), kept);
  return { stock, new: fresh.length, scored, total: kept.length };
}

export async function runAll(store, opts = {}) {
  const log = opts.log || console.log;
  const list = opts.stocks || await getWatchlist(store);
  const results = await Promise.all(Object.entries(list).map(([s, info]) =>
    collectStock(store, s, info, opts).catch((e) => ({ stock: s, error: e.message }))));
  const engine = (opts.key ?? process.env.ANTHROPIC_API_KEY) ? `Claude (${opts.model || CLAUDE_MODEL})` : "keyword";
  await store.setJSON("meta", { updated: new Date().toISOString(), engine, results });
  for (const r of results) log(r.error ? `${r.stock}: could not update (${r.error})` : `${r.stock}: new=${r.new} scored=${r.scored} kept=${r.total}`);
  return results;
}

// What the dashboard receives: last 14 days of scored headlines per stock + settings.
export async function dashboardData(store, now = new Date()) {
  const meta = (await store.get("meta", { type: "json" })) || null;
  const since = sinceIso(14, now), stocks = {};
  for (const [s, info] of Object.entries(await getWatchlist(store))) {
    const rows = ((await store.get(keyFor(s), { type: "json" })) || [])
      .filter((a) => a.score != null && a.published && a.published >= since).slice(0, 300)
      .map(({ title, source, url, published, score, reason, engine }) => ({ title, source, url, published, score, reason, engine }));
    stocks[s] = { ticker: info.ticker, name: info.name || null, index: !!info.index, headlines: rows };
  }
  return { updated: meta?.updated ?? null, engine: meta?.engine ?? null, weights: WEIGHTS, stocks };
}

// Claude key/model: the one saved on the website (Manage API Keys) wins, else Netlify's environment variable.
export function scoringOptions(secrets = {}, env = process.env) {
  const a = secrets.anthropic || {};
  return { key: a.api_key || env.ANTHROPIC_API_KEY || "", model: a.model || env.CLAUDE_MODEL || CLAUDE_MODEL };
}
