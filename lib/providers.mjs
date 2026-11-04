// Every outside service the website can use. To add one: add an entry here (and a test in lib/keytests.mjs).
// status: "active" = used by the site now, "partial" = keys work, feature being built, "soon" = keys can be saved, not used yet.
export const PROVIDERS = [
  {
    id: "anthropic", name: "Claude (Anthropic)", group: "AI scoring", status: "active",
    purpose: "Har headline ko -1 se +1 tak score karta hai. Key na ho to simple keyword scoring chalti hai.",
    link: "https://console.anthropic.com/settings/keys", cost: "Anthropic alag se charge karta hai (usage ke hisaab se).",
    fields: [
      { id: "api_key", label: "API key", secret: true, placeholder: "sk-ant-..." },
      { id: "model", label: "Model (optional)", secret: false, placeholder: "claude-haiku-5-5" },
    ],
  },
  {
    id: "kite", name: "Zerodha Kite Connect", group: "Prices", status: "active",
    purpose: "Real-time prices (Connect plan). Roz subah 6 baje login khatam hota hai: din mein ek baar 'Login with Zerodha' dabaiye. Login na ho to prices Yahoo se (15 min late).",
    link: "https://developers.kite.trade/apps", cost: "Zerodha lagbhag ₹500/mahina leta hai.",
    fields: [
      { id: "api_key", label: "API key", secret: true, placeholder: "Kite app ki API key" },
      { id: "api_secret", label: "API secret", secret: true, placeholder: "Kite app ka API secret" },
    ],
  },
  {
    id: "google_news", name: "Google News", group: "News sources", status: "active", noKey: true,
    purpose: "Har stock ki khabrein (RSS feed). Iske liye key nahi chahiye. Test se pata chalta hai ki news aa rahi hai ya nahi.",
    fields: [],
  },
  {
    id: "youtube", name: "YouTube Data API", group: "News sources", status: "soon",
    purpose: "Stock videos ke comments se sentiment. Key abhi save kar sakte hain, source jald jodenge.",
    link: "https://console.cloud.google.com/apis/library/youtube.googleapis.com", cost: "Google ka free quota kaafi hai.",
    fields: [{ id: "api_key", label: "API key", secret: true, placeholder: "AIza..." }],
  },
  {
    id: "reddit", name: "Reddit", group: "News sources", status: "soon",
    purpose: "r/IndianStreetBets jaise forums se sentiment. Keys abhi save kar sakte hain, source jald jodenge.",
    link: "https://www.reddit.com/prefs/apps", cost: "Personal use ke liye free.",
    fields: [
      { id: "client_id", label: "Client ID", secret: true, placeholder: "" },
      { id: "client_secret", label: "Client secret", secret: true, placeholder: "" },
    ],
  },
];

export const byId = (id) => PROVIDERS.find((p) => p.id === id);
