// Runs by itself every hour on Netlify: collects and scores the latest news.
import { getStore } from "@netlify/blobs";
import { runAll, scoringOptions } from "../../lib/pipeline.mjs";
import { loadSecrets, runtimeEnv } from "../../lib/secrets.mjs";

export default async () => {
  const secrets = await loadSecrets(getStore({ name: "admin", consistency: "strong" }));
  await runAll(getStore({ name: "sentiment", consistency: "strong" }), scoringOptions(secrets, runtimeEnv()));
};

export const config = { schedule: "@hourly" };
