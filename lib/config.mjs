// Settings. Edit this file to add stocks or change behaviour, then run Deploy.command again.

// "query" is what we search in Google News, "ticker" is the Yahoo Finance symbol.
export const STOCKS = {
  RELIANCE:   { query: "Reliance Industries share", ticker: "RELIANCE.NS" },
  TCS:        { query: "TCS Tata Consultancy Services share", ticker: "TCS.NS" },
  HDFCBANK:   { query: "HDFC Bank share", ticker: "HDFCBANK.NS" },
  INFY:       { query: "Infosys share", ticker: "INFY.NS" },
  TATAMOTORS: { query: "Tata Motors share", ticker: "TATAMOTORS.NS" },
};

// Google News edition. English India by default. For Hindi news use ["hi", "IN", "IN:hi"].
export const NEWS_LANG = ["en-IN", "IN", "IN:en"];
export const NEWS_WINDOW = "3d";          // only look at news from the last 3 days
export const MAX_ARTICLES_PER_STOCK = 40;
export const KEEP_DAYS = 30;              // how long headlines are kept in storage

// Sentiment engine. Uses Claude if ANTHROPIC_API_KEY is set in Netlify's environment variables,
// else a simple keyword fallback.
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
export const BATCH_SIZE = 20;             // headlines scored per API call
export const MAX_BATCHES_PER_STOCK = 2;   // per hourly run, so a run stays within Netlify's time limit

// Barometer weighting
export const HALF_LIFE_HOURS = 24;        // news loses half its weight every 24 hours
export const SOURCE_WEIGHTS = {           // trusted business sources count more than unknown ones
  "economic times": 1.0, "moneycontrol": 1.0, "livemint": 1.0, "mint": 1.0,
  "business standard": 1.0, "reuters": 1.0, "bloomberg": 1.0, "cnbc": 0.9,
  "the hindu businessline": 0.9, "financial express": 0.9, "ndtv profit": 0.8,
};
export const DEFAULT_SOURCE_WEIGHT = 0.5;
