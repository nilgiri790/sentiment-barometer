// Offline tests for the shared Claude helper. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeMessage } from "../lib/claude.mjs";
import { aiAnalyze } from "../lib/aianalyze.mjs";

const res = (status, body) => ({ ok: status < 300, status, json: async () => body });

test("asks with thinking disabled and returns the text", async () => {
  const seen = [];
  const r = await claudeMessage({ apiKey: "k", model: "claude-haiku-5-5", prompt: "hi", maxTokens: 900,
    fetchImpl: async (u, o) => { seen.push(JSON.parse(o.body)); return res(200, { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "## Jawab\n- ok" }] }); } });
  assert.equal(r.text, "## Jawab\n- ok");
  assert.deepEqual(seen[0].thinking, { type: "disabled" }); assert.equal(seen[0].max_tokens, 900);
});

test("model that cannot disable thinking: retried with low effort and more room", async () => {
  const seen = [];
  const r = await claudeMessage({ apiKey: "k", model: "claude-opus-5-5", prompt: "hi", maxTokens: 900, fetchImpl: async (u, o) => {
    const b = JSON.parse(o.body); seen.push(b);
    if (b.thinking) return res(400, { type: "error", error: { type: "invalid_request_error", message: "thinking type disabled is not supported for this model" } });
    return res(200, { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }); } });
  assert.equal(r.text, "done"); assert.equal(seen.length, 2);
  assert.equal(seen[1].thinking, undefined); assert.deepEqual(seen[1].output_config, { effort: "low" }); assert.equal(seen[1].max_tokens, 3600);
});

test("the live bug: thinking used the whole budget -> clear error, not a blank answer", async () => {
  const f = async () => res(200, { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }] });
  await assert.rejects(claudeMessage({ apiKey: "k", model: "m", prompt: "x", fetchImpl: f }), /kat gaya/);
  await assert.rejects(claudeMessage({ apiKey: "k", model: "m", prompt: "x", fetchImpl: async () => res(200, { stop_reason: "refusal", content: [] }) }), /mana kar diya/);
  await assert.rejects(claudeMessage({ apiKey: "k", model: "m", prompt: "x", fetchImpl: async () => res(200, { stop_reason: "end_turn", content: [] }) }), /khaali/);
  await assert.rejects(claudeMessage({ apiKey: "k", model: "m", prompt: "x", fetchImpl: async () => res(400, { error: { message: "prompt is too long" } }) }), /400: .*too long/);
  const st = { get: async () => null, setJSON: async () => {} };
  await assert.rejects(aiAnalyze({ prompt: "Support batao", candles: [] }, st, { apiKey: "k", model: "m", fetchImpl: f }), /kat gaya/);
});
