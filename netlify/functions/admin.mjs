// /api/admin/*  — the password-protected "Manage API Keys" page talks to this.
import { getStore } from "@netlify/blobs";
import { handleAdmin } from "../../lib/admin.mjs";

export default (req) => handleAdmin(req, {
  adminStore: getStore({ name: "admin", consistency: "strong" }),
  dataStore: getStore({ name: "sentiment", consistency: "strong" }),
  cacheStore: getStore("cache"),
});

export const config = { path: "/api/admin/*" };
