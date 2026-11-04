// Zerodha redirects here after the daily login. Set this as the "Redirect URL" in your Kite Connect app:
//   https://<your-site>.netlify.app/api/kite/callback
import { getStore } from "@netlify/blobs";
import { handleKiteCallback } from "../../lib/admin.mjs";
import { kiteChecksum } from "../../lib/secrets.mjs";

export default (req) => handleKiteCallback(req, { adminStore: getStore({ name: "admin", consistency: "strong" }), checksum: kiteChecksum });

export const config = { path: ["/api/kite/login", "/api/kite/callback"] };
