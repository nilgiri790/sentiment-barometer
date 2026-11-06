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
by a hard refresh -> something in front of the function (or a stale session) answers 401. Fix shipped 2026-11-05 (live site then showed × working):
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

## Sentiment page split (2026-11-05)
Sidebar: Dashboard, API Keys, Sentiment (#/sentiment). Dashboard = Quote panel only (wider, 320 px chart, quick-open chips:
NIFTY 50 / BANK NIFTY / RELIANCE / HDFC BANK / ITC), quote "add" button now says "+ Sentiment list mein add karein".
Sentiment page (#view-sent): its own type-ahead search (shares/indices only; shared makeAC helper also drives the Quote box),
chosen-stock bar with "Scan news" + "+ List mein add"/"Barometer dekhein", AI report panel, the barometer (tiles with ×,
gauge with a "Scan news" button, chart, headlines) and a Settings panel. Look-back select + news-update chips show only here.
Scan news = two admin calls (Netlify ~10 s limit): POST /api/admin/scan {step:"news", symbol, name, index} -> lib/scan.mjs
scanNews (Google News up to 30, Claude scoring with a 6.5 s budget, keyword for the rest, barometer; Blobs `scan-<KEY>`),
then {step:"report", key} -> makeReport (one Claude call, JSON {overall, summary, positives, negatives, themes, watch},
8.5 s timeout; simple counts-based report when no key / unreadable answer; Blobs `report-<KEY>`). GET /api/admin/report?key=
returns the saved one ("Pichhli report"). Settings: lib/settings.mjs, Blobs `settings` in store `sentiment`
{newsLang en|hi, newsWindow 1d|3d|7d, maxArticles 10..100, autoCollect, lookback 1|3|7|14, reportLang hinglish|english|hindi,
reportLength short|detailed}; POST /api/admin/settings (admin); /api/data includes them; hourly collect skips when
autoCollect is off; fetchStockNews takes {lang, window, max}. Global CSS `[hidden]{display:none !important}`.
Tested: 58 unit tests; browser suites (stand-in server with fake Kite/Claude/news): sent 26, regress 44, ac 12, watch 17,
s401 5, fno 17+2, chart 15 — all pass. Runner: scratchpad tools/runall.sh (not in the repo).

## Backtest page (2026-11-05)
Sidebar item "Backtest" below Sentiment (#/backtest, #view-bt). public/backtest.mjs is lazy-loaded (dynamic import) and
gets {makeAC, suggest, adminPost, toast, isAdmin} from index.html. Search (shares, indices, options) + timeframe 1D/1h/15m/
5m/1m -> /api/candles (Kite limits: 1D ~2 years, 1h 120 days, 15m 45, 5m 15, 1m 4) -> Lightweight Charts candles + volume,
OHLCV legend, data summary (period, change, high/low with dates, max drawdown, volatility, avg volume, SMA50/200),
last 30 candles table, CSV download. Create strategy: templates (SMA/EMA crossover, RSI, breakout, Bollinger) with params,
or "AI se banaiye" -> POST /api/admin/ai {mode:"strategy"} (lib/aianalyze.mjs; Claude returns strategy JSON, validated by
validateStrategy; never code). Risk inputs: stop-loss %, target %, max hold candles, capital, cost % per side.
Engine public/btengine.mjs (also used server-side): long only, signal on close -> fill next open, SL/TP intrabar
(stop first), costs, equity + stats (return, buy&hold, trades, win rate, avg win/loss, profit factor, max DD, exposure).
Results: B/S/SL/T markers + strategy MAs/bands on the chart, equity curve vs buy&hold, trades table. Last AI strategy kept in
localStorage `sb-bt-strategy`. "AI se poochhiye": quick prompts + textarea -> POST /api/admin/ai {mode:"analyze", stats,
candles (last 400), backtest summary, prompt}; answer language/length from Sentiment settings; tiny safe markdown render.
Tested: 65 unit tests (engine, validation, AI prompt/strategy); browser bt suite 16/16 + all earlier suites pass.

## Claude calls (2026-11-05 fix)
Live bug: Backtest "Analyze" returned an empty answer. Cause: claude-haiku-5-5 thinks by default and thinking tokens count
against max_tokens (900) -> the reply had only an empty thinking block (stop_reason max_tokens). All Claude calls now go
through lib/claude.mjs claudeMessage(): sends thinking {type:"disabled"} (allowed on Haiku 5.5 at its default medium effort;
also faster), and on a 400 about thinking (Opus 5.5 / Sonnet 5.5 / Fable reject disabling) retries with
output_config.effort "low" and 4x max_tokens; empty text -> Hinglish error by stop_reason (max_tokens / refusal / empty).
Used by lib/sentiment.mjs (scoring), lib/scan.mjs (report), lib/aianalyze.mjs (Backtest AI). Tests: test/claude.test.mjs.

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

## Scalping page (2026-11-05, redesigned same day)
Sidebar item "Scalping" below Backtest (#/scalp, #view-scalp, lazy public/scalp.mjs; gets {makeAC, suggest, adminPost, adminGet,
toast, isAdmin}). User decision: ONLY BANK NIFTY and NIFTY. No search bar, no watchlist (both removed on request).
Top bar: index switch BANK NIFTY | NIFTY (localStorage `sb-scalp-index`), Expiry select (from /api/chain expiries),
timeframe 1s/5s/15s (ticks only) / 1m / 5m for BOTH charts, live status. Left column: index chart (NIFTY BANK / NIFTY 50
candles via /api/candles + index ticks; price lines Support / Resistance / Max pain from the chain) with stat chips (PCR, max
pain, support, resistance, ATM, ATM IV, days to expiry); option chart (open contract, bid/ask/lot, IV + Greeks row, entry /
target / SL lines); option chain panel (public/scalpchain.mjs: /api/chain ±10 strikes, live LTP / OI / volume over the WebSocket,
OI Δ since page open, IV, ITM shading, ATM row, open contract outlined, AI pick badge; click a CE / PE price = open it);
AI panel; market depth. Right: Bracket, Smart order, Simple order (trade.mjs). Strike/index/expiry changes are locked while a
bracket is live. Zerodha WebSocket in "full" mode for the open option + index + chain (token sources merged); order updates
from text {type:"order"}; no WebSocket -> /api/admin/ltp every 3 s for the option, chain + index chart refresh every 30 s.
Smart order: lots, entry (follows live price until typed), target / SL trigger / SL limit kept as offsets from entry in
Points (₹) or Percent (%) (toggle "Target/SL mein"; +/- boxes editable; default +10/-7/-6; localStorage `sb-scalp-form`),
chase seconds (3..600, default 30), MIS/NRML, one-click toggle (OFF by default -> confirm box), charges box (below).
Engine public/scalpengine.mjs (pure, unit tested):
BUY LIMIT -> on fill SELL LIMIT target -> price <= trigger once -> cancel target, wait for CANCELLED, then SELL LIMIT at SL limit
-> not filled in chaseSec -> MODIFY that SL order to the current price (tick floor), repeated every chaseSec. Only one SELL open
at a time. Handles partial fills, refused cancel (retry 3 s), target filled before cancel, rejects; Exit now; Managing band.
RUNS IN THE BROWSER: page closed = target stays on Zerodha, SL/chase stop. Bracket saved in localStorage `sb-scalp` and
resumed on reload (index taken from the contract symbol; forgotten after 18 h); order status polled via GET
/api/admin/order-status?id= (2 s, 4 s when WS live).
Server: POST /api/admin/order-change {op:"cancel"|"modify", order_id, price} (lib/orders.mjs changeOrder: reads the order from
Kite first; must be open; modify only SELL LIMIT) -> relay POST /cancel (DELETE /orders/regular/{id}) or /modify (PUT, LIMIT price).
Option SELL also refused if held qty minus pending SELL orders < qty (no writing, no double sells); option SELL skips the 3 s
lock and the value limit (it only closes). THE DEPLOYED RELAY MUST BE UPDATED (Cloud Shell: git pull && bash relay/setup.sh),
otherwise cancel/modify get "Relay purana hai". NOT tested against real Kite.

## Scalping AI trade assistant (2026-11-05)
User decisions: AI NEVER places orders; it picks ONE strike (CE or PE) from the WHOLE loaded chain of the selected index, or
WAIT. "Scan trade" button = 1 Haiku call; the picked strike OPENS and the Smart order form is FILLED (user presses BUY).
AI Scan ON = repeat every 30 s / 1 / 2 / 5 min (localStorage `sb-scalp-ai-every`), only shows the signal + "🔔 Naya AI signal"
toast, never switches the open strike (button "Ye strike kholo + form bharo"). Turns itself OFF: market closed (Mon-Fri
9:15-15:30 IST, holidays unknown), daily limit reached, 3 failures in a row, index changed; always OFF after reload.
Daily call limit editable on the page. public/scalpai.mjs builds the payload: index {spot, prevClose, change %, 1m + 5m
indicators (EMA 9/21, RSI 14, VWAP, ATR 14, Bollinger %b, trend, day high/low), last 30 x 1m, last 20 x 5m}, chain {expiry,
lot, ATM, PCR + PCR before, max pain, support, resistance, ATM IV, rows [strike, CE sym/ltp/OI/OI chg, PE sym/ltp/OI/OI chg,
CE/PE IV, CE/PE volume, CE/PE delta], top OI changes + build-up since the last scan}, openContract (optional: ltp, bid/ask,
spread, depth qty, Greeks, 1m indicators), minutes to close. Analytics public/optanalytics.mjs (Black-Scholes, r 6.5 %,
expiry 15:30 IST, IV by bisection, Greeks are our estimates; max pain only over loaded strikes).
POST /api/admin/ai {mode:"trade", payload, question} -> lib/aitrade.mjs: needs chain rows; underlying BANKNIFTY or NIFTY only;
daily limit in Blobs admin `ai-usage` {day, used, limit} (default 100, 1..2000; counted before the call); news = last 48 h of
`articles-<INDEX>` + `scan-<INDEX>` (only if that index is collected / scanned on the Sentiment page); one claudeMessage call,
model claude-haiku-5-5 (fixed), 900 tokens, 8.5 s; parseSignal validates (symbol must be in the chain / open contract and
match CE/PE, target > entry > SL, entry within 15 % of premium) else WAIT + note. GET /api/admin/ai-usage, POST
/api/admin/ai-limit {limit}. Last 15 signals in localStorage `sb-scalp-ai`. Test hook `?anytime=1` (localhost only).
Charges: Smart order summary shows "Brokerage + charges" for BUY + SELL (at target), breakdown, break-even, max loss / target
profit after charges. public/charges.mjs optionCharges() (unit tested): ₹20 per order, STT 0.15% of sell premium (Budget
2026, from 1 Apr 2026; rounded to the rupee), NSE txn 0.03503%, SEBI ₹10/crore, stamp 0.003% on buy, GST 18% on
brokerage+txn+SEBI. Rates from web sources (zerodha.com/charges was not reachable from the sandbox): estimate only.
Search fix (same day): "NIFTY 50 / 100 / 200 / 500 / NEXT 50" are index names, not strikes, and an option query whose number
matches no strike now falls through to the share / index search (before, "NIFTY 50" returned NIFTY options).
Tested: 100 unit tests; browser scalp suite 62/62 (fake Kite WS with chain OI ticks + price control, fake NIFTY + BANKNIFTY
options, fake Haiku strike pick, stateful fake order book) + all earlier suites pass.

## AI trader modes, Paper trading, Trade summary (2026-11-06)
User asked: simpler AI section, an "AI trade mode" where the AI trades by itself, and a separate trade summary with profit /
loss, the reason, and the AI learning from losses. (This REPLACES the earlier "AI never places orders" decision, but only
inside the limits below; Paper is the default.)
- Top bar switch "📝 Paper | ₹ Asli" (localStorage `sb-scalp-mode`, default paper; Asli needs a confirm; locked while a
  bracket runs). Paper = public/paperbroker.mjs (same place / cancel / modify as the relay; fills on live ticks: BUY when
  price <= limit at min(limit, price), SELL when price >= limit at max(limit, price); no order leaves the page; restored
  after reload from the bracket's saved orders). Simple order (real ticket) only shows in Asli mode.
- AI panel (public/scalpai.mjs) = "AI trader": modes Band | Signal | Auto trade + "Abhi scan karo"; all settings behind
  "⚙ Settings" (interval, daily AI call limit, auto-trade lots / max trades per day / max loss per day ₹ / min confidence %,
  optional note to the AI); result card compact, reasons folded in "Kyon?". Signal = looks every N s and only tells (🔔).
  Auto trade = looks every N s; on BUY_CE/BUY_PE with confidence >= minConf it opens the strike, fills the form (lots from
  settings) and starts the bracket itself (scalp.mjs autoTrade). Guards: one trade at a time (no AI look while a trade
  runs), 9:20-15:00 IST for new trades, today's AI trades < maxTrades, today's AI net > -maxLoss, 5 min pause after an AI
  loss, Asli needs relay + Zerodha login + F&O. Entry not filled in 60 s -> cancelled. Limit / loss / error -> AI turns
  itself off. Asli AI BUY orders carry `auto:true`; /api/admin/order then checks lib/journal.mjs autoGuard (Blobs admin
  `auto-count` per IST day vs maxTrades, lots <= setting, today's REAL AI net from the journal vs maxLoss). Settings: Blobs
  admin `ai-auto` {lots 1, maxTrades 5, maxLoss 1000, minConf 65}; GET /api/admin/ai-usage returns {usage, auto, today};
  POST /api/admin/ai-auto {auto}.
- Trade summary = second tab "📒 Trade summary" on the Scalping page (public/scalpjournal.mjs): filters Aaj / 7 din / Sab,
  AI / Aapke, Paper / Asli; cards (net P&L after charges, trades, win %, avg win / loss, best / worst); "AI ne nuksan se
  kya seekha" (lessons from losses); table, click a row for why it made / lost money, the lesson, plan, price move
  (max for / against), money (gross, charges, net), market at entry, the AI's reasons. "Paper trades hatao" clears paper rows.
  Every finished bracket (paper or real, AI or manual) is posted once (id) to POST /api/admin/journal {op:"add", trade}:
  lib/journal.mjs cleanTrade works out gross / charges / net on the server (optionCharges), reviews it with ONE Haiku call
  (counts toward the daily AI limit; JSON {reason, lesson, tag}) or a rule-based reason + lesson when no key / limit
  reached; Blobs admin `journal` (last 300). public/tradestats.mjs = bracketResult (from Bracket.toJSON) + computeStats.
- "Learning": aiTrade adds promptMemory(journal) to every trade prompt: last 30 closed trades (wins, win %, net, by CE/PE,
  by confidence >= 70) + the last 6 loss lessons + 2 win lessons ("YOUR PAST TRADES ... do not repeat the same mistakes").
  It is in-context memory, not model training.
- Toasts now stack (#toasts container in index.html) instead of covering each other.
- Tested: 110 unit tests (paper broker + engine, trade result / stats, journal clean / review / memory / guard, admin
  endpoints); browser scalp suite 77/77 (Paper auto trade end-to-end on fake ticks, AI review, summary tab, lessons in the
  next prompt, limits) + all earlier suites pass. NOT tested with real money / real Kite.

## Pro trader features (2026-11-06, NOT pushed until the user says so)
User asked to build every feature from my "brilliant options trader" list. Built:
- Zerodha-side SL (default "SL kahan: Zerodha par"): after the entry fills, the engine (public/scalpengine.mjs `hardSl`) places a
  SELL SL order on Zerodha (trigger = SL trigger, limit = trigger - 3 % `hardLimit`); the target stays virtual (page watches it and,
  when hit, modifies the SL order to a LIMIT at the price). Page closed = SL still on Zerodha. Fallback to the page SL if placeSL
  is missing / refused (row shows a warning). Price already below the stop at fill -> sells at once (exitWhy "slnow").
  Breakeven (`beAt` pts -> SL = entry), trailing SL (`trailBy` pts, max one Zerodha modify per 3 s), time exit (`maxHoldSec`).
  Relay (relay/relay.mjs) accepts order_type SL + trigger_price, modify with trigger_price (keeps SL) or price only (-> LIMIT).
  lib/orders.mjs changeOrder: TRIGGER PENDING SL only takes a trigger move; triggered SL a price change. Paper broker has SL too.
  THE DEPLOYED RELAY MUST BE UPDATED again (Cloud Shell: git pull && bash relay/setup.sh); until then real trades fall back to page SL.
- Risk cockpit public/scalprisk.mjs + lib/risk.mjs (Blobs admin `risk`; GET/POST /api/admin/risk): risk per trade ₹, max loss
  per day, max consecutive losses, max trades per day, spread guard %, checklist on/off, auto square-off time (default 15:15).
  Kill switch: BUY disabled with the reason; for REAL scalp BUYs (`scalp:true`) the server checks riskGuard too (429).
  Lot mode "Risk se" = biggest lots whose SL loss fits risk per trade. 🚨 PANIC = cancel entry + exit now. Revenge detection
  (new trade within 2 min of a loss -> confirm, mood "revenge"). Setup / mood tags, 3-item checklist (manual trades only).
  The 3 s double-click lock is skipped for scalp BUYs.
- Context bar public/scalpctx.mjs + lib/context.mjs (GET /api/context?u=, one /quote + day candles): India VIX, near future
  (premium, VWAP from WS avg price, OI change since page open), heavyweights (approx fixed lists in HEAVYWEIGHTS), day type
  (opening range + VWAP), expected move (ATM straddle), yesterday H/L/C + CPR / pivots, events (📅 editor, GET/POST
  /api/admin/events, user maintained; "Aaj expiry" automatic). Index chart lines: OI levels / price levels (toggles) + AI plan.
  NFO cache key now `kite-nfo-v2` (also futures). kiteticks.mjs reads avg price (offset 12).
- AI: returns a plan {above, below, note} too; Smart interval (EVERY 0) = scan again only when the index crosses a plan level
  (min 60 s gap, else every 10 min). AI report card: each signal tracked on live chain prices (target first / SL first / none),
  POST /api/admin/signals (Blobs admin `signals`, last 500) and fed back into the prompt (signalMemory). Prompt gets `market` context.
  autoTrade waits up to 3 s for a live tick, re-anchors entry / target / SL to the live price when >0.5 % off, skips if price <= SL.
- Journal pro stats (tradestats.mjs proStats): equity curve SVG, max drawdown, expectancy, avg R, slippage, groups by time slot,
  CE/PE, expiry day, setup, mood, SL type, AI vs you. Weekly AI review (1 Haiku call, POST /api/admin/journal {op:"week-review"},
  Blobs admin `week-review`).
- Hotkeys Shift+C (ATM CE) / Shift+P (ATM PE) / Shift+B (BUY) / Shift+X (Exit); quick ITM / ATM / OTM buttons.
- NOT built: partial booking (would need two SELL orders at once; the one-SELL safety rule stays).
Tested: 126 unit tests; browser scalp suite 95/95 (Zerodha SL Asli bracket on the fake order book, kill switch, panic, revenge,
context bar, report card, weekly review) + all earlier suites pass. NOT tested with real Kite / real money.
