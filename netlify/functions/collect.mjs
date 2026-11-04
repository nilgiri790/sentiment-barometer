// Runs by itself every hour on Netlify: collects and scores the latest news.
import { getStore } from "@netlify/blobs";
import { runAll, scoringOptions } from "../../lib/pipeline.mjs";
import { loadSecrets, runtimeEnv } from "../../lib/secrets.mjs";
import { kiteReady } from "../../lib/prices.mjs";
import { nfoList } from "../../lib/options.mjs";

export default async () => {
  const secrets = await loadSecrets(getStore({ name: "admin", consistency: "strong" }));
  await runAll(getStore({ name: "sentiment", consistency: "strong" }), scoringOptions(secrets, runtimeEnv()));
  if (kiteReady(secrets.kite)) { try { await nfoList(secrets.kite, getStore("cache")); } catch (e) { console.log("options list:", e.message); } }
};

export const config = { schedule: "@hourly" };
