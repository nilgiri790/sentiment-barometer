// Fetch headlines from Google News RSS. Returns [{title, source, url, published}].
import { NEWS_LANG, NEWS_WINDOW, MAX_ARTICLES_PER_STOCK } from "./config.mjs";

export function feedUrl(query) {
  const [hl, gl, ceid] = NEWS_LANG;
  const q = encodeURIComponent(`${query} when:${NEWS_WINDOW}`);
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function clean(s) {
  if (s == null) return "";
  s = s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENT[e])
    .trim();
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? clean(m[1]) : "";
};

// Split out so it can be tested offline.
export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let title = tag(it, "title");
    const link = tag(it, "link");
    const source = tag(it, "source");
    // Google News titles look like "Headline - Source": strip the trailing source
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    let published = null;
    const raw = tag(it, "pubDate");
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d)) published = d.toISOString().slice(0, 19);
    }
    if (title && link) items.push({ title, source, url: link, published });
  }
  return items;
}

export async function fetchStockNews(query, fetchImpl = fetch, timeoutMs = 10000) {
  const r = await fetchImpl(feedUrl(query), {
    headers: { "User-Agent": "Mozilla/5.0 sentiment-tracker" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Google News answered ${r.status}`);
  return parseRss(await r.text()).slice(0, MAX_ARTICLES_PER_STOCK);
}
