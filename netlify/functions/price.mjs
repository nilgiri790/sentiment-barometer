// /api/price and /api/search. Uses Zerodha when connected today (keys from Manage API Keys), else Yahoo.
import { getStore } from "@netlify/blobs";
import { handlePrice } from "../../lib/prices.mjs";
import { loadSecrets } from "../../lib/secrets.mjs";

export default async (req) => handlePrice(req, {
  secrets: await loadSecrets(getStore({ name: "admin", consistency: "strong" })),
  cache: getStore("cache"),
});

export const config = { path: ["/api/price", "/api/search"] };
