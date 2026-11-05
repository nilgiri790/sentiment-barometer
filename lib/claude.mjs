// One place for every Claude call on the site (headline scoring, news report, Backtest AI).
// Newer models (e.g. claude-haiku-5-5) think by default, and thinking tokens count against max_tokens: with a small
// max_tokens the whole budget can go to thinking and the reply has no text. These calls are short, so we ask with
// thinking disabled (also faster, which matters inside Netlify's ~10 s limit). Models that refuse to disable thinking
// (400) are asked again with low effort and more room. An empty reply becomes a clear error, never a silent blank.
export async function claudeMessage({ apiKey, model, prompt, maxTokens = 1000, timeoutMs = 8500, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("Iske liye Claude key chahiye. API Keys mein Claude (Anthropic) key save kariye.");
  const deadline = Date.now() + timeoutMs;
  const send = async (extra, max) => {
    const left = Math.max(1000, deadline - Date.now());
    try {
      return await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(left),
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: max, ...extra, messages: [{ role: "user", content: prompt }] }),
      });
    } catch (e) {
      throw new Error(e.name === "TimeoutError" ? "AI ne samay par jawab nahi diya, sawaal chhota karke dobara try kariye." : e.message);
    }
  };
  let r = await send({ thinking: { type: "disabled" } }, maxTokens);
  if (r.status === 400) {
    let msg = ""; try { msg = JSON.stringify(await r.json()); } catch {}
    if (/thinking|disabled|effort/i.test(msg)) r = await send({ output_config: { effort: "low" } }, Math.min(16000, maxTokens * 4));
    else throw new Error(`Claude API answered 400${msg ? ": " + msg.slice(0, 160) : ""}`);
  }
  if (!r.ok) throw new Error(`Claude API answered ${r.status}`);
  const d = await r.json();
  const text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) {
    if (d.stop_reason === "refusal") throw new Error("AI ne is sawaal ka jawab dene se mana kar diya. Sawaal thoda alag tarah poochhiye.");
    if (d.stop_reason === "max_tokens") throw new Error("AI ka jawab lamba tha aur beech mein kat gaya. Dobara try kariye.");
    throw new Error("AI ne khaali jawab diya. Dobara try kariye.");
  }
  return { text, stopReason: d.stop_reason || null, model: d.model || model };
}
