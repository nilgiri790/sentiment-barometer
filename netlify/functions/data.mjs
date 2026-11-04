// The dashboard reads its data from here: /api/data
import { getStore } from "@netlify/blobs";
import { dashboardData } from "../../lib/pipeline.mjs";

export default async () =>
  Response.json(await dashboardData(getStore("sentiment")), { headers: { "cache-control": "public, max-age=300" } });

export const config = { path: "/api/data" };
