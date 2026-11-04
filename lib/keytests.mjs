// "Test connection" for each provider. Returns {ok, msg}. Never returns the key itself.
import { fetchStockNews } from "./news.mjs";
import { kiteTokenValid } from "./secrets.mjs";

const T = (ms = 7000) => AbortSignal.timeout(ms);
const why = (s) => (s === 401 || s === 403 ? "key galat hai ya iski permission nahi hai" : s === 429 ? "bahut zyada requests, thodi der baad try karein" : `service ne ${s} jawab diya`);

export async function testProvider(id, v = {}, fetchImpl = fetch) {
  switch (id) {
    case "anthropic": {
      if (!v.api_key) return { ok: false, msg: "Pehle API key save kariye." };
      const r = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": v.api_key, "anthropic-version": "2023-06-01" }, signal: T() });
      return r.ok ? { ok: true, msg: "Claude se connection theek hai." } : { ok: false, msg: "Claude: " + why(r.status) };
    }
    case "kite": {
      if (!v.api_key || !v.api_secret) return { ok: false, msg: "Pehle API key aur secret dono save kariye." };
      if (!v.access_token || !kiteTokenValid(v.token_at)) return { ok: false, msg: "Keys saved hain. Ab 'Login with Zerodha' dabaiye (roz subah 6 baje token expire hota hai)." };
      const r = await fetchImpl("https://api.kite.trade/user/profile", {
        headers: { "X-Kite-Version": "3", Authorization: `token ${v.api_key}:${v.access_token}` }, signal: T() });
      if (!r.ok) return { ok: false, msg: "Zerodha: " + why(r.status) + ". 'Login with Zerodha' dobara kariye." };
      const d = await r.json();
      return { ok: true, msg: `Zerodha connected (${d.data?.user_name || d.data?.user_id || "account"}).` };
    }
    case "google_news": {
      const items = await fetchStockNews("Nifty share market", fetchImpl);
      return items.length ? { ok: true, msg: `Google News chal raha hai (${items.length} khabrein mili).` } : { ok: false, msg: "Google News se koi khabar nahi aayi." };
    }
    case "youtube": {
      if (!v.api_key) return { ok: false, msg: "Pehle API key save kariye." };
      const r = await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&regionCode=IN&maxResults=1&key=${encodeURIComponent(v.api_key)}`, { signal: T() });
      return r.ok ? { ok: true, msg: "YouTube key theek hai." } : { ok: false, msg: "YouTube: " + why(r.status) };
    }
    case "reddit": {
      if (!v.client_id || !v.client_secret) return { ok: false, msg: "Pehle Client ID aur secret dono save kariye." };
      const r = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
        method: "POST", body: "grant_type=client_credentials", signal: T(),
        headers: { Authorization: "Basic " + Buffer.from(`${v.client_id}:${v.client_secret}`).toString("base64"),
                   "content-type": "application/x-www-form-urlencoded", "User-Agent": "sentiment-barometer/1.0" } });
      const d = r.ok ? await r.json() : {};
      return d.access_token ? { ok: true, msg: "Reddit keys theek hain." } : { ok: false, msg: "Reddit: " + (r.ok ? "keys galat lagti hain" : why(r.status)) };
    }
    default:
      return { ok: false, msg: "Ye service pehchaani nahi gayi." };
  }
}
