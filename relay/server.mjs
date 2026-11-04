// Tiny HTTP server for Cloud Run. All logic is in relay.mjs.
import http from "node:http";
import { handleRelay } from "./relay.mjs";

const secret = process.env.RELAY_SECRET || "";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
  req.on("end", async () => {
    const out = await handleRelay({ method: req.method, path: req.url.split("?")[0], body, headers: req.headers }, { secret })
      .catch((e) => ({ status: 500, json: { error: e.message } }));
    res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(out.json));
  });
}).listen(process.env.PORT || 8080);
