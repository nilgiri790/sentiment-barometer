// "Manage API Keys" page. Talks to /api/admin/* (password protected, keys never come back in full).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STATUS = {
  active: ["p-pos", "Use ho raha hai"],
  partial: ["p-soon", "Keys + login ready, feature aa raha hai"],
  soon: ["p-neu", "Jald aa raha hai"],
};
const KITE_MSG = {
  ok: ["ok", "Zerodha login ho gaya. Token kal subah 6 baje tak chalega."],
  cancelled: ["bad", "Zerodha login cancel ho gaya."],
  "no-keys": ["bad", "Pehle Zerodha ki API key aur secret save kariye."],
  "login-first": ["bad", "Pehle is page par admin login kariye, phir 'Login with Zerodha' dabaiye."],
  failed: ["bad", "Zerodha login fail hua. Keys check karke dobara try kariye."],
};

let root, opts = {};
const HEAD = `<div class="page-head"><div><h1>API Keys &amp; Connections</h1>`;
async function api(path, body) {
  const r = await fetch("/api/admin/" + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const txt = await r.text(); let d = {}; try { d = JSON.parse(txt); } catch {}
  if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}` + (txt ? ` [${txt.replace(/\s+/g, " ").slice(0, 80)}]` : "")), { status: r.status });
  return d;
}
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
}
const ago = (iso) => {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso)) / 6e4;
  return m < 1 ? "abhi" : m < 60 ? `${Math.round(m)} min pehle` : m < 1440 ? `${Math.round(m / 60)} ghante pehle` : `${Math.round(m / 1440)} din pehle`;
};

export async function showKeys(el, o = {}) {
  root = el; opts = o;
  root.innerHTML = `${HEAD}<p class="sub">Loading…</p></div></div><div class="sk" style="height:120px;margin-bottom:10px"></div><div class="sk" style="height:220px"></div>`;
  let st;
  try { st = await api("status"); } catch (e) { root.innerHTML = `${HEAD}</div></div><div class="card empty"><b>Server se baat nahi ho payi</b>(${esc(e.message)})</div>`; return; }
  if (!st.setup) return setupNeeded(st.missing || []);
  if (!st.loggedIn) return loginForm();
  return keysPage();
}

function setupNeeded(missing) {
  root.innerHTML = `${HEAD}</div></div>
    <div class="card"><b>Ek baar ka setup baaki hai.</b>
    <p class="kp">Apne Mac par project folder mein <b>Deploy.command</b> par double-click kariye. Wo aapse ek admin password banwayega
    aur website update kar dega. Uske baad isi page par us password se login karke saari API keys yahin se manage kar sakenge.</p>
    ${missing.length ? `<p class="note">Website ko ye settings nahi mil rahi: <code>${missing.map(esc).join(", ")}</code>. Deploy.command ka naya version
    khud check karke batata hai ki kya gadbad hai. Wo jo likhe uska screenshot Claude ko bhejiye.</p>` : ""}</div>`;
}

function loginForm(err = "") {
  root.innerHTML = `${HEAD}
    <p class="sub">Ye page sirf aapke liye hai. Website ka link kisi ke paas bhi ho, password ke bina koi keys nahi dekh ya badal sakta.</p></div></div>
    <form class="card login" id="lf"><h3 style="margin-bottom:12px">Admin login</h3><label class="label" for="pw" style="display:block;margin-bottom:5px">Admin password</label>
      <input id="pw" type="password" autocomplete="current-password" required>
      <div class="kbtns"><button class="btn" style="width:100%">Login</button></div>
      ${err ? `<div class="kres bad">${esc(err)}</div>` : ""}
      <p class="kp" style="margin-top:12px">Password bhool gaye? Mac par project folder mein <b>Reset-Password.command</b> par double-click kariye.</p></form>`;
  root.querySelector("#pw").focus();
  root.querySelector("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button"); b.disabled = true;
    try { await api("login", { password: root.querySelector("#pw").value }); keysPage(); }
    catch (er) { loginForm(er.message); }
  };
}

async function keysPage(data) {
  if (!data) {
    try { data = await api("keys"); } catch (e) { return e.status === 401 ? loginForm() : (root.innerHTML = `<div class="card empty">${esc(e.message)}</div>`); }
  }
  const kiteFlag = new URLSearchParams(location.hash.split("?")[1] || "").get("kite");
  const groups = [...new Set(data.providers.map((p) => p.group))];
  root.innerHTML = `
    ${HEAD}
      <p class="sub">Keys encrypted (taala-band) rakhi jaati hain. Save hone ke baad poori key dobara nahi dikhti, sirf aakhri 4 akshar.
      Badlav turant lagu hote hain, dobara deploy ki zaroorat nahi.</p></div>
      <button class="btn2" id="logout">Logout</button></div>
    ${kiteFlag && KITE_MSG[kiteFlag] ? `<div class="kres ${KITE_MSG[kiteFlag][0]}" style="margin:0 0 14px">${KITE_MSG[kiteFlag][1]}</div>` : ""}
    <div class="grid2">
      <section class="panel"><div class="panel-h"><h2>News collection</h2><span class="right label">Auto · har ghante</span></div>
        <div class="panel-b"><p class="kp" style="margin-top:0">Naya key save karne ke baad ya pehli baar, yahan se turant chala sakte hain (10 second tak lagenge).</p>
        <button class="btn" id="run">Run now</button><div class="runres" id="runres"></div></div></section>
      <section class="panel"><div class="panel-h"><h2>Recent orders</h2><span class="right label">Website se</span></div>
        <div id="olog"><div class="sk" style="height:90px;margin:12px"></div></div></section>
    </div>
    ${groups.map((g) => `<div class="kgroup">${esc(g)}</div><div class="kgrid">${data.providers.filter((p) => p.group === g).map(card).join("")}</div>`).join("")}`;
  root.querySelector("#logout").onclick = async () => { await api("logout", {}).catch(() => {}); loginForm(); };
  root.querySelector("#run").onclick = runNow;
  api("orders").then((d) => {
    const el = root.querySelector("#olog"); if (!el) return;
    el.innerHTML = d.orders.length ? `<div class="scroll" style="max-height:260px"><table class="tbl"><thead><tr><th>Time</th><th>Side</th><th>Stock</th><th class="r">Qty</th><th class="r hide-m">Value</th><th>Status</th></tr></thead><tbody>${
      d.orders.slice(0, 15).map((o) => { const sd = String(o.order.transaction_type || o.order.side || "").toUpperCase();
        return `<tr><td class="src when">${new Date(o.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
          <td><span class="pill ${sd === "BUY" ? "p-pos" : "p-neg"}">${esc(sd)}</span></td>
          <td>${esc(o.order.tradingsymbol || o.order.symbol || "")}</td><td class="r tnum">${esc(o.order.quantity ?? o.order.qty ?? "")}</td>
          <td class="r tnum hide-m">${o.value ? `₹${Number(o.value).toLocaleString("en-IN")}` : "–"}</td>
          <td>${o.ok ? `<span class="pill p-pos">Sent</span> <span class="src">${esc(o.order_id)}</span>` : `<span class="pill p-neg">Failed</span> <span class="src">${esc(o.error)}</span>`}</td></tr>`; }).join("")
      }</tbody></table></div>` : `<div class="empty" style="padding:28px 16px">Abhi tak koi order nahi.</div>`;
  }).catch(() => {});
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => act(b)));
}

function card(p) {
  const [cls, label] = STATUS[p.status] || STATUS.soon;
  const anySet = p.fields.some((f) => f.set);
  const keyPill = p.noKey ? `<span class="pill p-neu">Key ki zaroorat nahi</span>`
    : anySet ? `<span class="pill p-pos">Saved</span>` : `<span class="pill p-neg">Key nahi hai</span>`;
  const t = p.test ? `<div class="kres ${p.test.ok ? "ok" : "bad"}">${p.test.ok ? "✓" : "✗"} ${esc(p.test.msg)} <span style="opacity:.7">(${ago(p.test.at)})</span></div>` : "";
  let kite = "";
  if (p.kite) {
    const cb = location.origin + "/api/kite/callback";
    const keyField = p.fields.find((f) => f.id === "api_key");
    kite = `<div class="copy">Kite app mein <b>Redirect URL</b> ye daaliye: <code>${esc(cb)}</code>
        <button class="btn2" data-act="copy" data-text="${esc(cb)}">Copy</button></div>
      <div class="kbtns" style="justify-content:space-between">${p.kite.loggedIn
        ? `<span class="pill p-pos">Aaj ka login ho gaya${p.kite.user ? `: ${esc(p.kite.user)}` : ""}</span>`
        : `<span class="pill p-neg">Aaj login nahi hua</span>`}
        <button class="btn" data-act="kite" data-id="${p.id}" ${keyField?.set && p.fields.every((f) => f.set) ? "" : "disabled title='Pehle keys save kariye'"}>Login with Zerodha</button></div>`;
  }
  return `<div class="card kcard" id="k-${p.id}">
    <div class="khead"><h3>${esc(p.name)}</h3><span style="margin-left:auto;display:inline-flex;gap:6px;flex-wrap:wrap">${keyPill}<span class="pill ${cls}">${label}</span></span></div>
    <p class="kp">${esc(p.purpose)}${p.cost ? ` <i>${esc(p.cost)}</i>` : ""}
      ${p.link ? ` <a href="${esc(p.link)}" target="_blank" rel="noopener">Key kahan milegi ↗</a>` : ""}</p>
    ${p.fields.length ? `<div class="kfields">${p.fields.map((f) => `<label>${esc(f.label)}
      <input type="${f.secret ? "password" : "text"}" data-f="${f.id}" autocomplete="off" spellcheck="false"
        placeholder="${esc(f.set ? (f.secret ? `Saved ${f.shown} (badalne ke liye nayi daaliye)` : f.shown) : f.placeholder || "")}"></label>`).join("")}</div>` : ""}
    <div class="kbtns">
      ${p.fields.length ? `<button class="btn" data-act="save" data-id="${p.id}">Save</button>` : ""}
      <button class="btn2" data-act="test" data-id="${p.id}">Test connection</button>
      ${anySet ? `<button class="btn2 danger" data-act="remove" data-id="${p.id}">Remove</button>` : ""}
      ${p.updated ? `<span class="note" style="margin:0">Last saved ${ago(p.updated)}</span>` : ""}
    </div>${kite}${t}</div>`;
}

async function act(b) {
  const id = b.dataset.id, a = b.dataset.act;
  if (a === "copy") { navigator.clipboard?.writeText(b.dataset.text).then(() => toast("Copy ho gaya")); return; }
  if (a === "kite") { location.href = "/api/kite/login"; return; } // server sends you on to Zerodha
  if (a === "remove" && !confirm("Ye keys hata dein? Ye service phir kaam nahi karegi.")) return;
  b.disabled = true;
  try {
    if (a === "save") {
      const values = {};
      root.querySelectorAll(`#k-${id} input[data-f]`).forEach((i) => { if (i.value.trim()) values[i.dataset.f] = i.value.trim(); });
      if (!Object.keys(values).length) { toast("Pehle box mein key daaliye."); b.disabled = false; return; }
      const d = await api("keys", { provider: id, values });
      await keysPage(d); toast("Save ho gaya. Ab 'Test connection' dabaiye.");
    } else if (a === "test") {
      b.textContent = "Testing…";
      await keysPage(await api("test", { provider: id }));
      document.getElementById("k-" + id)?.scrollIntoView({ block: "nearest" });
    } else if (a === "remove") {
      await keysPage(await api("remove", { provider: id })); toast("Hata diya.");
    }
  } catch (e) {
    if (e.status === 401) return loginForm("Session khatam ho gaya, dobara login kariye.");
    toast(e.message); b.disabled = false;
  }
}

async function runNow() {
  const b = root.querySelector("#run"), out = root.querySelector("#runres");
  b.disabled = true; b.textContent = "Chal raha hai…"; out.textContent = "";
  try {
    const d = await api("collect", {});
    out.innerHTML = d.results.map((r) => r.error ? `<span class="down">✗</span> <b>${esc(r.stock)}</b> · ${esc(r.error)}` : `<span class="up">✓</span> <b>${esc(r.stock)}</b> · ${r.new} nayi khabrein, ${r.scored} score hui`).join("<br>");
    opts.onCollected?.();
  } catch (e) {
    if (e.status === 401) return loginForm("Session khatam ho gaya, dobara login kariye.");
    out.textContent = "Nahi chal paya: " + e.message;
  }
  b.disabled = false; b.textContent = "Run now";
}
