// Scalping "smart bracket" for a LONG option position. Pure logic: no network, no timers of its own.
// The page feeds it ticks (onTick) and order updates (onOrder) and gives it async actions:
//   place({side, price, qty}) -> order_id   cancel(id)   modify(id, {price})
//   placeSL({side, trigger, price, qty}) -> order_id   modifySL(id, {trigger, price})      (only for the Zerodha SL mode)
//
// Two ways to protect a position (plan.hardSl):
//  * Zerodha SL (hardSl: true, safest): after the entry fills, a SELL stop-loss order (trigger + a limit a bit below it)
//    waits ON ZERODHA, so it works even if this page / laptop / internet stops. The target is watched here: when the price
//    reaches it, the Zerodha SL is cancelled first, then the position is sold at the current price.
//  * Page SL (hardSl: false): SELL LIMIT target waits on Zerodha; when the price touches slTrigger the target is cancelled
//    first, THEN a SELL LIMIT at slLimit goes in. This part runs only while the page is open.
// Either way: an exit LIMIT not filled within chaseSec is re-priced to the current price (repeats every chaseSec), and
// only one SELL order is ever open, so a target and a stop can never both fill.
// Optional: beAt (points of profit -> stop moves to the entry price), trailBy (stop follows the highest price minus this),
// maxHoldSec (no exit by then -> sell at the current price).

export const STATES = ["idle", "entry_open", "active", "sl_armed", "sl_open", "done", "error", "stopped"];
export const LIVE = new Set(["entry_open", "active", "sl_armed", "sl_open"]);
const OPEN = new Set(["OPEN", "TRIGGER PENDING", "PUT ORDER REQ RECEIVED", "VALIDATION PENDING", "OPEN PENDING", "MODIFY PENDING",
  "MODIFY VALIDATION PENDING", "AMO REQ RECEIVED", "CANCEL PENDING", "MODIFIED"]);
export const isOpen = (s) => OPEN.has(String(s || "").toUpperCase());
export const tickFloor = (p, tick = 0.05) => Math.round(Math.max(tick, Math.floor(p / tick + 1e-9) * tick) * 100) / 100;
const r2 = (p) => Math.round(p * 100) / 100;
const RETRY_MS = 3000;                               // how often to retry a cancel that Zerodha refused
const MOVE_MS = 3000;                                // at most one Zerodha SL move every 3 s (trailing)
export const HARD_GAP = 0.03;                        // Zerodha SL: limit price 3% below the trigger (exchange rule: sell limit <= trigger)
export const hardLimit = (trig, tick = 0.05) => tickFloor(trig * (1 - HARD_GAP), tick);
const WHY_TXT = { tp: "Target", time: "Time exit", manual: "Exit", slnow: "Stop-loss" };

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
  for (const k of ["beAt", "trailBy", "maxHoldSec"]) if (has(p[k]) && !(n(p[k]) >= 0)) return "Breakeven / trailing / time exit theek nahi";
  return null;
}

export class Bracket {
  constructor(plan, actions, { now = () => Date.now(), log = () => {}, onChange = () => {} } = {}) {
    const bad = checkPlan(plan); if (bad) throw new Error(bad);
    const opt = (v) => (v === "" || v == null ? null : +v);
    this.p = { qty: +plan.qty, entry: +plan.entry, target: opt(plan.target), slTrigger: opt(plan.slTrigger), slLimit: opt(plan.slLimit),
      chaseSec: +plan.chaseSec, tick: +plan.tick || 0.05, hardSl: !!plan.hardSl && opt(plan.slTrigger) != null,
      beAt: +plan.beAt || 0, trailBy: +plan.trailBy || 0, maxHoldSec: +plan.maxHoldSec || 0 };
    this.a = actions; this.now = now; this.logf = log; this.onChange = onChange;
    this.state = "idle"; this.o = { entry: null, target: null, sl: null, hard: null }; this.filled = 0; this.avg = null;
    this.busy = false; this.ltp = null; this.reason = null; this.events = []; this.exitAsap = false; this.exitWhy = null; this.cancelAt = 0;
    this.filledAt = null; this.hi = null; this.slMoved = false; this.movedAt = 0; this.hardFailed = false;
  }
  log(msg) { const e = { at: this.now(), msg }; this.events.push(e); if (this.events.length > 200) this.events.shift(); this.logf(e); }
  set(st, why) { this.state = st; if (why) this.reason = why; this.onChange(this); }
  get live() { return LIVE.has(this.state); }
  async run(fn) {                                    // one action at a time
    if (this.busy) return false; this.busy = true;
    try { await fn(); return true; } catch (e) { this.log("✗ " + e.message); this.fail(e.message); return false; } finally { this.busy = false; this.onChange(this); }
  }
  fail(msg) { if (this.live || this.state === "idle") this.set("error", msg); }
  // qty still held: entry fills minus what the target / Zerodha SL already sold
  remaining() { return Math.max(0, this.filled - (this.o.target?.filled || 0) - (this.o.hard?.filled || 0)); }
  closer() { return this.p.hardSl ? this.o.hard : this.o.target; }      // the resting SELL that must go before an exit

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
    const which = ["entry", "target", "sl", "hard"].find((k) => this.o[k]?.id === id); if (!which || !st) return;
    const o = this.o[which], fq = u.filled_quantity == null ? o.filled || 0 : +u.filled_quantity || 0;
    if (o.status === st && fq === (o.filled || 0)) return;            // nothing new (WebSocket + polling both report it)
    if (o.final) return;                                             // already handled a COMPLETE/CANCELLED/REJECTED
    const was = o.status;
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
    } else if (which === "hard") {
      if (st === "COMPLETE") { this.log(`✓ Zerodha SL se bahar @ ${o.avg ?? o.price}`); this.set("done", this.slMoved && (o.avg ?? o.price) >= this.avg ? "Trailing SL exit" : "Stop-loss exit"); }
      else if (st === "REJECTED") { this.log(`✗ Zerodha SL reject hua${why}`); this.fail("Zerodha SL reject hua: turant Kite mein position check kariye"); }
      else if (st === "CANCELLED") {
        if (this.state === "sl_armed") { this.log("Zerodha SL cancel ho gaya"); await this.placeSl(); }
        else { this.log("Zerodha SL bahar se cancel hua"); this.fail("Zerodha SL cancel ho gaya: position ab bina SL ke hai. Kite mein check kariye"); }
      } else if (st === "OPEN" && was === "TRIGGER PENDING") { o.trigAt = this.now(); this.log(`⚡ Zerodha par SL trigger hua (${o.trigger}): ${o.price} tak bechne ki koshish`); }
    } else if (which === "sl") {
      const w = this.o.sl.exit;
      if (st === "COMPLETE") { this.log(`✓ ${w ? WHY_TXT[w] || "Exit" : "Stop-loss"} se bahar @ ${o.avg ?? o.price}`); this.set("done", w === "tp" ? "Target hit" : w === "time" ? "Time exit" : w === "slnow" ? "Stop-loss exit" : w ? "Exit ho gaya" : this.slMoved && (o.avg ?? o.price) >= this.avg ? "Trailing SL exit" : "Stop-loss exit"); }
      else if (st === "REJECTED") { this.log(`✗ SL order reject hua${why}`); this.fail("SL order reject hua: turant Kite mein position check kariye"); }
      else if (st === "CANCELLED") { this.log("SL order bahar se cancel hua"); this.fail("SL order cancel ho gaya: position ab bina SL ke hai. Kite mein check kariye"); }
    }
    this.onChange(this);
  }

  async protect() {
    this.set("active"); this.filledAt = this.now(); this.hi = this.avg;
    // the price is already at / under the stop when the entry fills: no stop order (Zerodha would refuse it), sell now
    if (this.p.slTrigger != null && this.ltp != null && this.ltp <= this.p.slTrigger) {
      this.log(`⚡ Entry bharte hi daam ${this.ltp} SL ${this.p.slTrigger} ke neeche: turant bech rahe hain`);
      this.exitWhy = "slnow"; this.exitAsap = true; this.set("sl_armed"); await this.placeSl(); return;
    }
    this.busy = true;                                // ticks wait while the protection goes in (no other SELL in between)
    try {
      if (this.p.hardSl) {
        if (!this.a.placeSL) this.p.hardSl = false;
        else {
          try { await this.placeHard(this.p.slTrigger); }
          catch (e) { this.p.hardSl = false; this.hardFailed = true; this.log(`⚠ Zerodha par SL nahi laga (${e.message}): ab SL is page se chalega`); }
        }
      }
      if (!this.p.hardSl) {
        if (this.p.target == null) this.log("Target nahi diya, sirf SL nazar mein hai");
        else { try { await this.place("target", this.p.target, "Target"); } catch (e) { this.log(`✗ Target nahi laga: ${e.message}. SL nazar mein hai.`); this.o.lostTarget = true; } }
      }
    } finally { this.busy = false; }
    if (this.ltp != null) await this.onTick(this.ltp);                  // price may already be below the trigger / at the target
  }
  async placeHard(trig) {
    const qty = this.remaining(), price = hardLimit(trig, this.p.tick);
    const id = await this.a.placeSL({ side: "SELL", trigger: r2(trig), price, qty });
    this.o.hard = { id: String(id), status: "TRIGGER PENDING", trigger: r2(trig), price, qty, filled: 0, placedAt: this.now(), chases: 0 };
    this.log(`🛡 Zerodha SL laga: ${qty} qty, trigger ${r2(trig)} → ${price} tak bechega (page band ho tab bhi): ${id}`);
  }
  async place(key, price, label) {
    const qty = key === "target" ? this.filled : this.remaining();
    const id = await this.a.place({ side: "SELL", price: r2(price), qty });
    this.o[key] = { id: String(id), status: "OPEN", price: r2(price), qty, filled: 0, placedAt: this.now(), chases: 0, exit: key === "sl" && this.exitWhy ? this.exitWhy : false };
    this.log(`${label} SELL LIMIT ${qty} @ ${r2(price)} laga: ${id}`);
  }
  pxNow() { return r2(tickFloor(this.ltp || this.p.entry, this.p.tick)); }

  async onTick(ltp) {
    if (!(+ltp > 0)) return; this.ltp = +ltp;
    if (this.filled && this.live) this.hi = Math.max(this.hi ?? this.ltp, this.ltp);
    if (this.busy) return;
    const now = this.now(), P = this.p;
    if (this.state === "entry_open") {
      // entry partly filled and price already fell to the trigger: stop buying more, protect what we have
      const e = this.o.entry;
      if (e?.filled > 0 && P.slTrigger != null && this.ltp <= P.slTrigger && isOpen(e.status) && now - this.cancelAt > RETRY_MS) {
        await this.run(async () => { this.cancelAt = now; this.log(`⚡ Daam ${this.ltp} trigger tak aaya, entry adhoori: baaki entry cancel kar rahe hain`); await this.a.cancel(e.id); });
      }
    } else if (this.state === "active") {
      const h = this.o.hard;
      if (P.hardSl && h && h.status === "OPEN") {                         // Zerodha SL triggered but not filled: chase it
        if (now - (h.trigAt || h.placedAt) >= P.chaseSec * 1000) await this.run(async () => {
          const px = this.pxNow(); h.trigAt = now;
          this.log(`${P.chaseSec}s mein Zerodha SL nahi bhara: daam ${h.price} se ${px} (abhi ka daam) kar rahe hain`);
          await this.a.modify(h.id, { price: px }); h.price = px; h.chases++;
        });
      } else if (P.hardSl && P.target != null && this.ltp >= P.target) {
        await this.run(async () => { this.exitWhy = "tp"; this.exitAsap = true; this.log(`🎯 Daam ${this.ltp} target ${P.target} par: pehle Zerodha SL hata kar bech rahe hain`); this.set("sl_armed"); await this.armInner(); });
      } else if (!P.hardSl && P.slTrigger != null && this.ltp <= P.slTrigger) {
        await this.run(async () => { this.log(`⚡ Daam ${this.ltp} ne SL trigger ${P.slTrigger} chhua: SL chalu`); this.set("sl_armed"); await this.armInner(); });
      } else if (P.maxHoldSec && this.filledAt != null && now - this.filledAt >= P.maxHoldSec * 1000) {
        await this.run(async () => { this.exitWhy = "time"; this.exitAsap = true; this.log(`⏱ ${Math.round(P.maxHoldSec / 60)} min mein target / SL nahi: abhi ke daam par bahar nikal rahe hain`); this.set("sl_armed"); await this.armInner(); });
      } else await this.moveStop();
    } else if (this.state === "sl_armed") {
      const t = this.closer();
      if (!this.o.sl && t && isOpen(t.status) && now - this.cancelAt > RETRY_MS) await this.run(() => this.armInner());   // cancel was refused: retry
      else if (!this.o.sl && !(t && isOpen(t.status))) await this.placeSl();                                                   // cancel confirmed while we were busy
    } else if (this.state === "sl_open") {
      const s = this.o.sl;
      if (s && isOpen(s.status) && now - s.placedAt >= P.chaseSec * 1000) {
        await this.run(async () => {
          const px = this.pxNow();
          this.log(`${P.chaseSec}s mein ${s.exit ? "exit" : "SL"} nahi bhara: daam ${s.price} se ${px} (abhi ka daam) kar rahe hain`);
          s.placedAt = now;                                              // also spaces out retries if the modify fails
          await this.a.modify(s.id, { price: px }); s.price = px; s.chases++;
        });
      }
    }
  }
  // breakeven + trailing: raise the stop (never lower it)
  async moveStop() {
    const P = this.p, tick = P.tick;
    if (P.slTrigger == null || (!P.beAt && !P.trailBy) || this.hi == null || !this.avg) return;
    let want = P.slTrigger;
    const beOn = !P.beAt || this.hi >= this.avg + P.beAt;
    if (P.beAt && beOn) want = Math.max(want, tickFloor(this.avg, tick));
    if (P.trailBy && beOn) want = Math.max(want, tickFloor(this.hi - P.trailBy, tick));
    if (!(want > P.slTrigger + tick / 2)) return;
    if (P.hardSl) {
      const h = this.o.hard;
      if (!h || h.status !== "TRIGGER PENDING" || this.now() - this.movedAt < MOVE_MS) return;
      if (want >= this.ltp - tick) return;                               // price already below the new stop: the trigger check handles it
      await this.run(async () => {
        this.movedAt = this.now(); const price = hardLimit(want, tick);
        await this.a.modifySL(h.id, { trigger: r2(want), price });
        this.log(`⬆ Zerodha SL upar khiskaya: trigger ${h.trigger} → ${r2(want)}${want >= this.avg ? " (ab nuksan nahi)" : ""}`);
        h.trigger = r2(want); h.price = price; P.slTrigger = r2(want); this.slMoved = true;
      });
    } else {
      const gap = P.slLimit != null ? P.slLimit - P.slTrigger : 0;
      this.log(`⬆ SL upar khiskaya: trigger ${P.slTrigger} → ${r2(want)}${want >= this.avg ? " (ab nuksan nahi)" : ""}`);
      P.slTrigger = r2(want); if (P.slLimit != null) P.slLimit = r2(want + gap); this.slMoved = true; this.onChange(this);
    }
  }
  // cancel the resting SELL first (the exit goes in after Zerodha confirms CANCELLED), else place the exit now
  async armInner() {
    const t = this.closer();
    if (t && isOpen(t.status)) {
      this.cancelAt = this.now(); this.log(this.p.hardSl ? "Pehle Zerodha SL cancel kar rahe hain" : "Pehle target cancel kar rahe hain");
      try { await this.a.cancel(t.id); } catch (e) { this.log(`Cancel nahi hua (${e.message}), dobara try karenge`); }
    } else await this.placeSlInner();
  }
  async placeSl() { return this.run(() => this.placeSlInner()); }
  async placeSlInner() {
    if (this.state !== "sl_armed" || this.o.sl) return;
    if (this.remaining() <= 0) { this.set("done", this.o.hard?.filled ? "Stop-loss exit" : "Target poora bhar gaya"); return; }
    if (this.exitAsap) await this.place("sl", this.pxNow(), WHY_TXT[this.exitWhy] || "Exit");
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
      this.exitAsap = true; if (!this.exitWhy) this.exitWhy = "manual";
      const px = this.pxNow(), s = this.o.sl, h = this.o.hard;
      if (this.state === "sl_open" && s && isOpen(s.status)) {
        this.log(`Exit: SL order ko ${px} par kar rahe hain`); s.placedAt = this.now(); s.exit = s.exit || "manual";
        await this.a.modify(s.id, { price: px }); s.price = px; return;
      }
      if (this.p.hardSl && h && h.status === "OPEN") {                    // Zerodha SL already triggered: just re-price it
        this.log(`Exit: Zerodha SL ko ${px} par kar rahe hain`); h.trigAt = this.now();
        await this.a.modify(h.id, { price: px }); h.price = px; return;
      }
      this.log(`Exit abhi ke daam ${px} par`);
      if (this.state === "active") this.set("sl_armed");
      await this.armInner();
    });
  }
  stop() { this.set("stopped", "Aapne managing band ki (Zerodha par lage orders waise hi hain)"); this.log("Managing band"); }
  openOrderIds() { return ["entry", "target", "sl", "hard"].map((k) => this.o[k]).filter((o) => o && isOpen(o.status)).map((o) => o.id); }
  toJSON() { return { p: this.p, state: this.state, o: this.o, filled: this.filled, avg: this.avg, reason: this.reason, exitAsap: this.exitAsap, exitWhy: this.exitWhy,
    filledAt: this.filledAt, hi: this.hi, slMoved: this.slMoved, hardFailed: this.hardFailed, events: this.events.slice(-60) }; }
  static restore(json, actions, opts) {
    const b = new Bracket(json.p, actions, opts);
    Object.assign(b, { state: json.state, o: { hard: null, ...json.o }, filled: json.filled, avg: json.avg, reason: json.reason, exitAsap: !!json.exitAsap, exitWhy: json.exitWhy || null,
      filledAt: json.filledAt ?? null, hi: json.hi ?? null, slMoved: !!json.slMoved, hardFailed: !!json.hardFailed, events: json.events || [] });
    Object.assign(b.p, json.p);
    return b;
  }
}
