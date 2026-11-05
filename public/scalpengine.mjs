// Scalping "smart bracket" for a LONG option position. Pure logic: no network, no timers of its own.
// The page feeds it ticks (onTick) and order updates (onOrder) and gives it three async actions:
//   place({side, price, qty}) -> order_id     cancel(order_id) -> void     modify(order_id, {price}) -> void
//
// Flow:  BUY LIMIT entry -> (filled) SELL LIMIT target
//        price touches slTrigger once -> SL is armed: cancel the target first, THEN SELL LIMIT at slLimit
//        SL not filled within chaseSec -> change the SL order's price to the current price (repeats every chaseSec)
// Only one SELL order is ever open at a time, so a target and a stop can never both fill.
// Everything here runs in the browser: if the page is closed, the target stays on Zerodha but the SL logic stops.

export const STATES = ["idle", "entry_open", "active", "sl_armed", "sl_open", "done", "error", "stopped"];
export const LIVE = new Set(["entry_open", "active", "sl_armed", "sl_open"]);
const OPEN = new Set(["OPEN", "TRIGGER PENDING", "PUT ORDER REQ RECEIVED", "VALIDATION PENDING", "OPEN PENDING", "MODIFY PENDING",
  "MODIFY VALIDATION PENDING", "AMO REQ RECEIVED", "CANCEL PENDING", "MODIFIED"]);
export const isOpen = (s) => OPEN.has(String(s || "").toUpperCase());
export const tickFloor = (p, tick = 0.05) => Math.round(Math.max(tick, Math.floor(p / tick + 1e-9) * tick) * 100) / 100;
const r2 = (p) => Math.round(p * 100) / 100;
const RETRY_MS = 3000;                               // how often to retry a cancel that Zerodha refused

export function checkPlan(p) {
  const n = (v) => Number(v), has = (v) => v != null && v !== "";
  if (!(n(p.qty) > 0) || !Number.isInteger(n(p.qty))) return "Quantity theek nahi";
  if (!(n(p.entry) > 0)) return "Entry price theek nahi";
  if (has(p.target) && !(n(p.target) > n(p.entry))) return "Target entry se upar hona chahiye";
  if (has(p.slTrigger)) {
    if (!(n(p.slTrigger) > 0 && n(p.slTrigger) < n(p.entry))) return "SL trigger entry se neeche hona chahiye";
    if (!(n(p.slLimit) > 0)) return "SL limit price chahiye";
    if (n(p.slLimit) >= n(p.entry)) return "SL limit entry se neeche hona chahiye";
  } else if (has(p.slLimit)) return "SL limit ke saath SL trigger bhi dijiye";
  if (!has(p.target) && !has(p.slTrigger)) return "Target ya stop-loss mein se kam se kam ek dijiye";
  if (!(n(p.chaseSec) >= 3 && n(p.chaseSec) <= 600)) return "Chase time 3 se 600 second";
  return null;
}

export class Bracket {
  constructor(plan, actions, { now = () => Date.now(), log = () => {}, onChange = () => {} } = {}) {
    const bad = checkPlan(plan); if (bad) throw new Error(bad);
    const opt = (v) => (v === "" || v == null ? null : +v);
    this.p = { qty: +plan.qty, entry: +plan.entry, target: opt(plan.target), slTrigger: opt(plan.slTrigger), slLimit: opt(plan.slLimit),
      chaseSec: +plan.chaseSec, tick: +plan.tick || 0.05 };
    this.a = actions; this.now = now; this.logf = log; this.onChange = onChange;
    this.state = "idle"; this.o = { entry: null, target: null, sl: null }; this.filled = 0; this.avg = null;
    this.busy = false; this.ltp = null; this.reason = null; this.events = []; this.exitAsap = false; this.cancelAt = 0;
  }
  log(msg) { const e = { at: this.now(), msg }; this.events.push(e); if (this.events.length > 200) this.events.shift(); this.logf(e); }
  set(st, why) { this.state = st; if (why) this.reason = why; this.onChange(this); }
  get live() { return LIVE.has(this.state); }
  async run(fn) {                                    // one action at a time
    if (this.busy) return false; this.busy = true;
    try { await fn(); return true; } catch (e) { this.log("✗ " + e.message); this.fail(e.message); return false; } finally { this.busy = false; this.onChange(this); }
  }
  fail(msg) { if (this.live || this.state === "idle") this.set("error", msg); }
  // qty still held: entry fills minus what the target already sold (a target can fill partly before we cancel it)
  remaining() { return Math.max(0, this.filled - (this.o.target?.filled || 0)); }

  async start() {
    if (this.state !== "idle") return false;
    return this.run(async () => {
      this.log(`BUY LIMIT ${this.p.qty} @ ${this.p.entry} bhej rahe hain`);
      const id = await this.a.place({ side: "BUY", price: this.p.entry, qty: this.p.qty });
      this.o.entry = { id: String(id), status: "OPEN", filled: 0 }; this.log(`Entry order laga: ${id}`); this.set("entry_open");
    });
  }

  // u = Zerodha order update / order history row: {order_id, status, filled_quantity, average_price, status_message}
  async onOrder(u) {
    const id = String(u.order_id || ""), st = String(u.status || "").toUpperCase();
    const which = ["entry", "target", "sl"].find((k) => this.o[k]?.id === id); if (!which || !st) return;
    const o = this.o[which], fq = u.filled_quantity == null ? o.filled || 0 : +u.filled_quantity || 0;
    if (o.status === st && fq === (o.filled || 0)) return;            // nothing new (WebSocket + polling both report it)
    if (o.final) return;                                             // already handled a COMPLETE/CANCELLED/REJECTED
    o.status = st; o.filled = fq; if (+u.average_price) o.avg = +u.average_price;
    const why = u.status_message ? ": " + u.status_message : "";
    if (["COMPLETE", "CANCELLED", "REJECTED"].includes(st)) o.final = true;
    if (!this.live) return this.onChange(this);
    if (which === "entry") {
      if (st === "COMPLETE") { this.filled = o.filled || this.p.qty; this.avg = o.avg ?? this.p.entry; this.log(`✓ Entry bhar gaya: ${this.filled} @ ${this.avg}`); await this.protect(); }
      else if (st === "CANCELLED" || st === "REJECTED") {
        if (o.filled > 0) { this.filled = o.filled; this.avg = o.avg ?? this.p.entry; this.log(`Entry ${st === "REJECTED" ? "reject" : "cancel"} hua, lekin ${o.filled} bhara: usko protect kar rahe hain`); await this.protect(); }
        else { this.log(st === "REJECTED" ? `✗ Entry reject hua${why}` : "Entry cancel hua"); this.set("done", st === "REJECTED" ? `Entry reject hua${why}` : "Entry cancel hua, koi position nahi bani"); }
      }
    } else if (which === "target") {
      if (st === "COMPLETE") {
        if (this.o.sl && isOpen(this.o.sl.status)) { this.log("⚠ Target aur SL dono khule the: SL cancel kar rahe hain"); try { await this.a.cancel(this.o.sl.id); } catch {} }
        this.log(`✓ Target bhar gaya @ ${o.avg ?? this.p.target}`); this.set("done", "Target hit");
      } else if (st === "REJECTED") { this.log(`✗ Target reject hua${why}. Sirf SL nazar mein hai.`); this.o.lostTarget = true; if (this.state === "sl_armed") await this.placeSl(); }
      else if (st === "CANCELLED") {
        if (this.state === "sl_armed") { this.log("Target cancel ho gaya"); await this.placeSl(); }
        else if (this.state === "active") { this.log("Target bahar se cancel hua. Sirf SL nazar mein hai."); this.o.lostTarget = true; }
      }
    } else if (which === "sl") {
      if (st === "COMPLETE") { this.log(`✓ ${this.o.sl.exit ? "Exit" : "Stop-loss"} se bahar @ ${o.avg ?? o.price}`); this.set("done", this.o.sl.exit ? "Exit ho gaya" : "Stop-loss exit"); }
      else if (st === "REJECTED") { this.log(`✗ SL order reject hua${why}`); this.fail("SL order reject hua: turant Kite mein position check kariye"); }
      else if (st === "CANCELLED") { this.log("SL order bahar se cancel hua"); this.fail("SL order cancel ho gaya: position ab bina SL ke hai. Kite mein check kariye"); }
    }
    this.onChange(this);
  }

  async protect() {
    this.set("active");
    if (this.p.target == null) { this.log("Target nahi diya, sirf SL nazar mein hai"); return; }
    this.busy = true;                                // ticks wait while the target is being placed (no SL in between)
    try { await this.place("target", this.p.target, "Target"); }
    catch (e) { this.log(`✗ Target nahi laga: ${e.message}. SL nazar mein hai.`); this.o.lostTarget = true; }
    finally { this.busy = false; }
    if (this.ltp != null) await this.onTick(this.ltp);                  // price may already be below the trigger
  }
  async place(key, price, label) {
    const qty = key === "target" ? this.filled : this.remaining();
    const id = await this.a.place({ side: "SELL", price: r2(price), qty });
    this.o[key] = { id: String(id), status: "OPEN", price: r2(price), qty, filled: 0, placedAt: this.now(), chases: 0, exit: label === "Exit" };
    this.log(`${label} SELL LIMIT ${qty} @ ${r2(price)} laga: ${id}`);
  }
  pxNow() { return r2(tickFloor(this.ltp || this.p.entry, this.p.tick)); }

  async onTick(ltp) {
    if (!(+ltp > 0)) return; this.ltp = +ltp;
    if (this.busy) return;
    if (this.state === "entry_open") {
      // entry partly filled and price already fell to the trigger: stop buying more, protect what we have
      const e = this.o.entry;
      if (e?.filled > 0 && this.p.slTrigger != null && this.ltp <= this.p.slTrigger && isOpen(e.status) && this.now() - this.cancelAt > RETRY_MS) {
        await this.run(async () => { this.cancelAt = this.now(); this.log(`⚡ Daam ${this.ltp} trigger tak aaya, entry adhoori: baaki entry cancel kar rahe hain`); await this.a.cancel(e.id); });
      }
    } else if (this.state === "active" && this.p.slTrigger != null && this.ltp <= this.p.slTrigger) {
      await this.run(async () => {
        this.log(`⚡ Daam ${this.ltp} ne SL trigger ${this.p.slTrigger} chhua: SL chalu`); this.set("sl_armed");
        await this.armInner();
      });
    } else if (this.state === "sl_armed") {
      const t = this.o.target;
      if (!this.o.sl && t && isOpen(t.status) && this.now() - this.cancelAt > RETRY_MS) await this.run(() => this.armInner());   // cancel was refused: retry
      else if (!this.o.sl && !(t && isOpen(t.status))) await this.placeSl();                                                   // cancel confirmed while we were busy
    } else if (this.state === "sl_open") {
      const s = this.o.sl;
      if (s && isOpen(s.status) && this.now() - s.placedAt >= this.p.chaseSec * 1000) {
        await this.run(async () => {
          const px = this.pxNow();
          this.log(`${this.p.chaseSec}s mein ${s.exit ? "exit" : "SL"} nahi bhara: daam ${s.price} se ${px} (abhi ka daam) kar rahe hain`);
          s.placedAt = this.now();                                      // also spaces out retries if the modify fails
          await this.a.modify(s.id, { price: px }); s.price = px; s.chases++;
        });
      }
    }
  }
  // cancel an open target first (the SL goes in after Zerodha confirms CANCELLED), else place the SL now
  async armInner() {
    const t = this.o.target;
    if (t && isOpen(t.status)) {
      this.cancelAt = this.now(); this.log("Pehle target cancel kar rahe hain");
      try { await this.a.cancel(t.id); } catch (e) { this.log(`Target cancel nahi hua (${e.message}), dobara try karenge`); }
    } else await this.placeSlInner();
  }
  async placeSl() { return this.run(() => this.placeSlInner()); }
  async placeSlInner() {
    if (this.state !== "sl_armed" || this.o.sl) return;
    if (this.remaining() <= 0) { this.set("done", "Target poora bhar gaya"); return; }
    if (this.exitAsap) await this.place("sl", this.pxNow(), "Exit");
    else await this.place("sl", this.p.slLimit, "Stop-loss");
    this.set("sl_open");
  }

  // ---- manual buttons ----
  async cancelEntry() {
    return this.run(async () => { const e = this.o.entry; if (this.state === "entry_open" && e && isOpen(e.status)) { this.log("Entry cancel kar rahe hain"); await this.a.cancel(e.id); } });
  }
  async exitNow() {                                  // sell everything at the current price (and keep chasing it)
    if (!["active", "sl_armed", "sl_open"].includes(this.state)) { this.log(this.state === "entry_open" ? "Abhi position nahi bani: pehle 'Entry cancel' dabaiye" : "Abhi koi position nahi hai"); this.onChange(this); return false; }
    return this.run(async () => {
      this.exitAsap = true; const px = this.pxNow(), s = this.o.sl;
      if (this.state === "sl_open" && s && isOpen(s.status)) {
        this.log(`Exit: SL order ko ${px} par kar rahe hain`); s.placedAt = this.now(); s.exit = true;
        await this.a.modify(s.id, { price: px }); s.price = px; return;
      }
      this.log(`Exit abhi ke daam ${px} par`);
      if (this.state === "active") this.set("sl_armed");
      await this.armInner();
    });
  }
  stop() { this.set("stopped", "Aapne managing band ki (Zerodha par lage orders waise hi hain)"); this.log("Managing band"); }
  openOrderIds() { return ["entry", "target", "sl"].map((k) => this.o[k]).filter((o) => o && isOpen(o.status)).map((o) => o.id); }
  toJSON() { return { p: this.p, state: this.state, o: this.o, filled: this.filled, avg: this.avg, reason: this.reason, exitAsap: this.exitAsap, events: this.events.slice(-60) }; }
  static restore(json, actions, opts) {
    const b = new Bracket(json.p, actions, opts);
    Object.assign(b, { state: json.state, o: json.o, filled: json.filled, avg: json.avg, reason: json.reason, exitAsap: !!json.exitAsap, events: json.events || [] });
    return b;
  }
}
