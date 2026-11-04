// API keys saved from the website. Stored ENCRYPTED in Netlify Blobs (store "admin"), using KEYS_SECRET
// (a random value Deploy.command puts in Netlify's environment variables). Admin login uses ADMIN_PASSWORD.
import crypto from "node:crypto";

const sha = (s) => crypto.createHash("sha256").update(s).digest();

// Netlify's settings (environment variables), read both the new way (Netlify.env) and the classic way (process.env).
const ENV_KEYS = ["ADMIN_PASSWORD", "KEYS_SECRET", "ANTHROPIC_API_KEY", "CLAUDE_MODEL"];
export function runtimeEnv() {
  const g = globalThis.Netlify?.env, out = { ...process.env };
  for (const k of ENV_KEYS) { let v; try { v = g?.get?.(k); } catch {} if (v) out[k] = v; }
  return out;
}
export const missingSetup = (env = runtimeEnv()) => ["ADMIN_PASSWORD", "KEYS_SECRET"].filter((k) => !env[k]);
export const isSetUp = (env = runtimeEnv()) => missingSetup(env).length === 0;

export function encrypt(obj, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", sha("keys|" + secret), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decrypt(box, secret) {
  const d = crypto.createDecipheriv("aes-256-gcm", sha("keys|" + secret), Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8"));
}

// {providerId: {field: value, ..., _updated, _test: {ok, msg, at}}}
export async function loadSecrets(store, env = runtimeEnv()) {
  if (!env.KEYS_SECRET) return {};
  const box = await store.get("secrets", { type: "json" });
  if (!box) return {};
  try { return decrypt(box, env.KEYS_SECRET); } catch { return {}; } // KEYS_SECRET changed: start fresh
}

export async function saveSecrets(store, all, env = runtimeEnv()) {
  if (!env.KEYS_SECRET) throw new Error("setup incomplete");
  await store.setJSON("secrets", encrypt(all, env.KEYS_SECRET));
}

export const mask = (v) => (!v ? "" : v.length <= 8 ? "••••" : "••••" + v.slice(-4));

// ---- admin session (HttpOnly cookie) ----
const sessKey = (env) => sha("session|" + env.KEYS_SECRET + "|" + env.ADMIN_PASSWORD);
export const COOKIE = "sb_admin";
export const SESSION_HOURS = 12;

export function makeSession(env = runtimeEnv(), now = Date.now()) {
  const exp = String(now + SESSION_HOURS * 36e5);
  return exp + "." + crypto.createHmac("sha256", sessKey(env)).update(exp).digest("hex");
}

export function checkSession(token, env = runtimeEnv(), now = Date.now()) {
  if (!token || !isSetUp(env)) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || +exp < now) return false;
  const good = crypto.createHmac("sha256", sessKey(env)).update(exp).digest("hex");
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

export function passwordOk(given, env = runtimeEnv()) {
  if (!env.ADMIN_PASSWORD || typeof given !== "string") return false;
  return crypto.timingSafeEqual(sha("pw|" + given), sha("pw|" + env.ADMIN_PASSWORD));
}

export const cookieOf = (req, name = COOKIE) =>
  (req.headers.get("cookie") || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];

// Kite access tokens expire every day at 6:00 AM India time.
export function kiteTokenValid(at, now = new Date()) {
  if (!at) return false;
  const ist = new Date(now.getTime() + 5.5 * 36e5);               // shift to IST wall clock
  const six = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6) - 5.5 * 36e5;
  const lastReset = now.getTime() >= six ? six : six - 864e5;
  return new Date(at).getTime() >= lastReset;
}
export const kiteChecksum = (apiKey, requestToken, apiSecret) =>
  crypto.createHash("sha256").update(apiKey + requestToken + apiSecret).digest("hex");
