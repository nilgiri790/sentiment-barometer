# Stock Sentiment Barometer: Netlify version (v2): handoff notes

Read this first. It carries context from earlier chats.

## About the user
- Not from a tech background. Explain simply, exact click-by-click steps, no jargon.
- Writes in Hinglish (Hindi in English letters). Reply in the same style unless asked otherwise.
- MacBook Air. Chose **Netlify** (no card, free plan hard cap = no surprise bill) over Firebase.

## What the project does
Reads news per stock, scores each headline -1 (lack of trust) .. +1 (trust), combines into a barometer
-100..+100 (24h half-life recency x source weight). Sentiment is a signal to study, not investment advice. Keep the disclaimer.
v1 (Python + Streamlit + SQLite, runs locally via Start.command) is the separate `sentiment_tracker` folder;
this v2 is a port of it to Netlify. Same formulas, same keyword lists, same Claude prompt.

## Layout
- `public/index.html` static dashboard (cards, gauge, sentiment vs price, headlines, look-back select, live price search).
- `public/barometer.mjs` barometer/dailySeries/labelFor, imported by both the page and the functions.
- `lib/config.mjs` stocks, news window, model (`CLAUDE_MODEL` env, default claude-haiku-5-5), weights.
- `lib/news.mjs` Google News RSS, regex parser (`parseRss` tested offline). `lib/sentiment.mjs` Claude via fetch,
  keyword fallback; max 2 batches of 20 per stock per run (rest scored next run) to stay inside the scheduled-function time limit.
- `lib/pipeline.mjs` runAll (stocks in parallel, one failing does not stop others), dashboardData (last 14 days, max 300/stock).
- Functions: `collect` (@hourly schedule), `data` (/api/data, cache 5 min), `price` (/api/price, /api/search) -> `lib/prices.mjs`:
  Zerodha Kite when connected today (quote -> instrument_token -> historical candles; 1d=5minute today only + live tip,
  5d=15minute last 5 sessions, 1mo=day placed at 09:15 IST; search from /instruments/NSE EQ list cached daily in Blobs
  store `cache` key `kite-nse`), else / on any Kite error Yahoo with a Hinglish `notice`. Response has `source`.
- Storage: Netlify Blobs store `sentiment`, keys `articles-<STOCK>` (kept 30 days) and `meta`.
- **Manage API Keys** (left sidebar, `#/keys`, `public/keys.mjs`): password-protected admin page.
  Backend `lib/admin.mjs` via functions `admin` (/api/admin/* : status, login, logout, keys GET/POST, remove, test, collect)
  and `kite-callback` (/api/kite/login -> Zerodha, /api/kite/callback swaps request_token for the day's access token).
  `lib/providers.mjs` = list of services (add one there + a test in `lib/keytests.mjs`). Statuses: active / partial / soon.
  Keys stored AES-256-GCM encrypted in Blobs store `admin` key `secrets` with KEYS_SECRET; never returned in full (masked last 4).
  Session = HMAC cookie `sb_admin` (HttpOnly, Secure, SameSite=Lax, 12 h); 5 wrong passwords -> 15 min lock; Origin check on POST.
  Changing ADMIN_PASSWORD logs out sessions but keeps keys. Claude key/model saved on the site win over env ANTHROPIC_API_KEY.
  "Run now" (admin) runs the pipeline with an 8 s budget (sync function limit ~10 s); unfinished Claude scoring waits for the hourly run.
- Env vars (set by Deploy.command, ALL scopes, not marked secret so `env:get` can see them): ADMIN_PASSWORD, KEYS_SECRET (random).
  Read via `runtimeEnv()` (Netlify.env.get, falling back to process.env). /api/admin/status returns `missing: [...]` names when unset.
- 2026-11-04 issue: after the first deploy with the keys page, the live site said "setup baaki hai" (functions did not see the
  env vars). Cause unknown (first version set them with `--scope functions` only). Fix shipped: all scopes, Netlify.env reader,
  Deploy.command re-sets both vars every run with the same values (KEYS_SECRET never changes once set), verifies them,
  and after deploy curls /api/admin/status and prints the result. If it still fails, check Netlify UI env vars + function logs.
- `Deploy.command` Mac double-click: downloads Node v24.22.2 into `.tools/` if missing, npm install, npm test,
  `netlify login` if needed; if the folder is not linked it links the newest existing `sentiment-barometer-*` site
  (so a fresh unzip updates the same site) or creates one; asks for ADMIN_PASSWORD once (Reset-Password.command forces it),
  creates KEYS_SECRET once; then `netlify deploy --prod`.
- The user's live site: https://sentiment-barometer-1wtsbo.netlify.app (first deployed 2026-11-04).
- **Buy/Sell (built + deployed 2026-11-04; relay set up and tested; no real order placed yet):** Zerodha requires a registered static IP
  for API orders (SEBI, from 1 Apr 2026); Netlify has none. So: page (`public/trade.mjs`, Buy/Sell under the price search,
  admin only, review + confirm step) -> `/api/admin/order` (`lib/orders.mjs`: NSE/BSE only, limits max_qty/max_value from the
  "Order relay (Firebase)" provider card, MARKET value checked with Kite /quote/ltp, 3 s double-click lock, last 50 orders
  logged in Blobs admin `orders`) -> HMAC-signed (RELAY_SECRET, 60 s expiry) POST to the relay -> Kite /orders/regular.
  Relay = `relay/` (Cloud Run service `kite-relay`, asia-south1, Node 22, no deps, max 1 instance) in the user's paid Firebase
  project, Direct VPC egress (all traffic) -> Cloud NAT `kite-relay-nat` with static IP `kite-relay-ip`. `relay/setup.sh`
  (run in Google Cloud Shell) creates everything idempotently and prints Static IP / Relay URL / Relay secret.
  MARKET orders send market_protection=-1 (exchange rule for API market orders). Cost estimate unverified (NAT gateway +
  static IP; sources disagree, roughly ₹600 to ₹2,700/month): user should set a budget alert and check the first bill.
  SET UP 2026-11-04: Google Cloud project `sentiment-berometer` (new, separate from the user's old `fnv-business-app`;
  billing = Google free trial, ~₹28.6k credit, 38 days left on 2026-11-04 -> user must Upgrade before it ends or the relay stops).
  Static IP 34.14.135.137 (setup.sh check confirmed relay egress = this IP); Relay URL https://kite-relay-fm3odurdfq-el.a.run.app.
  IP added in Kite developer console -> Profile -> IP Whitelist (account level, max 2 IPs, 1 change/week).
  The first relay secret was shown in a chat screenshot; user was told to rotate it with
  `gcloud run services update kite-relay --region asia-south1 --update-env-vars RELAY_SECRET=...`.
  Relay URL + secret saved on the live site; Test connection OK (user, 2026-11-04). First real order not yet tried
  (planned: 1-share LIMIT order next market day after Login with Zerodha).

## UI redesign (2026-11-05, presentation only)
"Premium fintech terminal" look requested by the user. Only public/index.html (CSS + markup templates), public/keys.mjs
(markup) and public/trade.mjs (order ticket markup) changed; no server/lib/function, endpoint, ID or data-* hook changed.
Design tokens on :root (dark default, light via topbar toggle saved in localStorage `sb-theme`; old var names kept as aliases),
Inter font (Google Fonts), topbar (title, update/engine chips, look-back, theme), sidebar with SVG icons -> bottom tab bar
on mobile, dashboard grid with sticky Quote panel on the right (>=1180px), tiles with a score meter, gauge + stats panel,
chart with gridlines + hover tooltips (data-tip), quote chart with area fill, prev-close line and crosshair, sticky-header
tables, skeletons, order ticket (side toggle, segmented order type/product, live value, Escape closes, review -> confirm;
success still only on server ok). Holdings/positions/watchlist/P&L/indices do NOT exist and were not added.
Checked with a 44-step Playwright regression against the real handlers (fake Kite/relay) + 31 unit tests.

## Search (2026-11-05)
Type-ahead suggestions under the Quote search box (debounced 160 ms, per-query cache, arrow keys/Enter/Esc, mouse;
same /api/search). Search now also returns NSE indices (Kite instruments segment INDICES, cache key `kite-nse-v2`, rows
[symbol, name, kind]) and understands BANKNIFTY/NIFTY/FINNIFTY/VIX-style names (INDEX_ALIASES). Index symbols look like
"NIFTY BANK.NS"; /api/price marks them `index:true` (Yahoo fallback via ^NSEBANK/^NSEI etc.); the page shows no Buy/Sell
for indices and the order code rejects them.

## Dashboard stock list (2026-11-05)
`lib/watchlist.mjs`: the dashboard stocks live in Blobs store `sentiment` key `watchlist` (starts as config STOCKS; max 25).
runAll and dashboardData use it, so only listed stocks are collected hourly. Admin-only POST /api/admin/watch
{op:"add", symbol, name, index} (share or index; options refused; fetches its news at once) / {op:"remove", key}; returns
fresh dashboard data. UI: × on each tile (admin only), "+ Dashboard mein add karein" under a share/index quote.
Old articles are kept on remove (re-adding brings them back). /api/data cache lowered to 60 s.

Live issue 2026-11-05: pressing × gave a bare "Error 401" (no JSON error) and the card stayed. Our handlers always send
{error:"..."} with 401, and an earlier GET /api/admin/status (which never returns 401) also showed a bare 401 once, fixed
by a hard refresh -> something in front of the function (or a stale session) answers 401. Pending fix (not pushed yet):
dashboard/keys fetches read text, show the raw reply in the message, and on 401 hide admin buttons + ask to Logout/Login.

## Index options / F&O (2026-11-05)
`lib/options.mjs`: daily NFO list (Kite /instruments/NFO, 9 s timeout, Blobs cache `kite-nfo-v1`, also pre-warmed by the
hourly collect when Zerodha is logged in) filtered to BANKNIFTY/NIFTY/FINNIFTY/MIDCPNIFTY CE/PE, expired contracts hidden.
Symbols "BANKNIFTY26NOV52000CE.NFO" (toKite -> NFO:...). Search understands "banknifty 52000 ce", "bank nifty pe dec".
/api/price for options = Zerodha only, adds `option` meta (strike, expiry, type, lot_size). New /api/chain?u=&expiry=
(spot via /quote/ltp, ±10 strikes, one /quote call). UI: public/chain.mjs (option chain modal; click LTP opens contract),
"option chain dekhein" button on index/option quotes, option ticket in lots (NRML/MIS).
Order safety: options OFF unless Order relay card field allow_fno = yes; max_lots (default 1); value limit on premium;
qty = lots x lot_size from the NFO list; SELL only up to the net quantity held (Kite /portfolio/positions) -> no writing.
Relay accepts exchange NFO with NRML/MIS (shares still CNC/MIS). THE DEPLOYED RELAY MUST BE UPDATED for NFO orders:
Cloud Shell `cd sentiment-barometer && git pull && bash relay/setup.sh` (keeps the current secret). Zerodha account needs
the F&O segment active. Tested offline (44 unit tests) + browser suites with a fake Kite/relay; NOT yet against real Kite NFO.

## Live chart page (2026-11-05)
"Launch chart" link in the Quote panel header opens public/chart.html?sym=&name=&tf= in a new tab (public/chartpage.mjs).
Library: TradingView Lightweight Charts 4.2.3, vendored at public/vendor/ (Apache-2.0, LICENSE copied, attribution kept).
History: GET /api/candles?sym=&interval=minute|3minute|5minute|10minute|15minute|30minute|60minute|day (Kite historical,
returns instrument_token + prevClose; Yahoo fallback for shares/indices; options Zerodha only). Live: admin-only GET
/api/admin/ticker gives {api_key, access_token}; the browser opens wss://ws.kite.trade, subscribes in "quote" mode and
public/kiteticks.mjs parses the binary packets (big-endian, paise/100; 8=ltp, 28/32=index, 44+=quote). Ticks update the
running candle; 1s/5s/10s/30s candles exist only from ticks since the page opened (Kite has no second history).
Not admin or no Zerodha login -> "Delayed · 20s refresh" polling of /api/candles. Studies: Volume, SMA 20, EMA 50, VWAP
(intraday, resets per IST day), Bollinger 20,2; types Candles/Hollow/Line/Area; crosshair OHLCV legend; fit; full screen;
theme shared with the site. Chart times are shifted +5:30 so the axis shows India time. `?wsurl=` test hook works on
localhost only. Tested with a fake Kite WebSocket (binary packets) + 52 unit tests; NOT yet against the real ws.kite.trade.

## Seen on the live site (user screenshot, 2026-11-04)
- Site loads. "Not updated yet" (hourly collect had not run yet). Price search: "Yahoo answered 429" (Yahoo rate-limits
  Netlify's servers). Added a retry on query2.finance.yahoo.com; may still fail -> real fix is the Zerodha price source.
- Note: Tata Motors demerged in 2025; check whether TATAMOTORS.NS still works or should change (e.g. TMPV.NS).

## Tested (build sandbox, no internet to Google/Yahoo/Netlify docs)
- 17 offline tests pass (admin: login/lock/origin/encryption/mask/Kite flow/Run now; pipeline as before)
- Deploy.command simulated with a fake netlify CLI (relinks old site, password checks, reset, KEYS_SECRET once).
- Keys page driven in Chromium against the real handlers with in-memory storage (desktop + phone, no JS errors, full key never in page).
- Earlier: 7 offline tests pass (`npm test`), incl. mocked Claude path, dedupe across runs, failure isolation.
- `netlify functions:serve`: routes work, Blobs read/write work, errors handled. `netlify build`: manifest shows
  collect @hourly and the /api routes, Node 22 runtime.
- Dashboard rendered in Chromium with data produced by the real pipeline from fake RSS (desktop + phone, light + dark, no JS errors).
NOT tested: real Google News fetch from Netlify, Yahoo from Netlify servers (Yahoo may block datacenter IPs;
the page degrades: chart shows only sentiment, search shows an error note), real Claude call, the actual deploy
and Deploy.command on a real Mac, whether the Netlify UI shows "Run now" for scheduled functions.
Netlify plan numbers (300 credits/month free, deploy ~15 credits, compute per GB-hour) came from third-party 2026 blogs; verify.

## Secrets
Never ask the user to paste keys in chat. All service keys go in the site's 🔑 Manage API Keys page.
VERIFIED LIVE 2026-11-04: keys page setup works after the env-var fix; Kite keys saved, Login with Zerodha + token exchange
worked, Test connection = "Zerodha connected (Anuj)". NOT tested for real yet: YouTube/Reddit tests, Claude /v1/models test.
User has the paid Connect plan. Zerodha price source VERIFIED LIVE 2026-11-04 (ITC.NS search + 1 day chart, "Prices: Zerodha
(real-time)"). Claude scoring VERIFIED LIVE (user saved the Anthropic key; dashboard shows "Scoring: Claude (claude-haiku-5-5)").

## Roadmap
- Add the Anthropic key (more accurate). Maybe: live WebSocket ticks from Kite; morning reminder to log in to Zerodha.
- More sources as fetchers returning {title, source, url, published}: NSE/BSE announcements, Reddit, YouTube, then worldwide.
- After 2-4 weeks of data, check whether sentiment moves come before price moves.
- GitHub + Netlify auto-deploy SET UP 2026-11-04: repo https://github.com/nilgiri790/sentiment-barometer (PUBLIC, because
  Netlify's free plan only builds private-repo commits from one contributor, and that contributor is a different GitHub user,
  tknj98tpn2-jpg). Netlify site linked to branch main; build command `npm test` (failing tests block the deploy),
  NPM_FLAGS=--omit=dev. Never commit secrets: the repo is public. Deploy.command remains as a manual backup only.
  Future sessions: start Claude Code with this repo selected.

## Working with the user
Do the work yourself; give short numbered steps for what only they can do (logins, clicks in Netlify).
Show a preview before big changes.
**PUSH RULE (user's explicit instruction, 2026-11-04):** collect ALL changes and push to GitHub ONLY when the user says
"code GitHub ko bhejo" (send code to GitHub). Every push to main = one Netlify production deploy = credits.
Until then keep changes uncommitted in the working tree (a session stop hook nags about unpushed commits; do not push for it).
When the user asks to send: commit everything in one commit, run `npm test`, push once, then ask them to check Netlify Deploys.
