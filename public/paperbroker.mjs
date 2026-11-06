// Paper trading broker for the Scalping page: same actions as the real one (place / cancel / modify), no real order.
// Orders fill on live ticks: BUY LIMIT when the price is at or below the limit, SELL LIMIT when it is at or above.
// Fill price: BUY = min(limit, price now), SELL = max(limit, price now). Updates are sent like Zerodha order updates
// ({order_id, status, filled_quantity, average_price}) so the bracket engine works unchanged.
export class PaperBroker {
  constructor({ onUpdate = () => {}, ltp = () => null, now = () => Date.now(), defer = (f) => setTimeout(f, 0) } = {}) {
    this.onUpdate = onUpdate; this.ltp = ltp; this.now = now; this.defer = defer;
    this.orders = new Map(); this.n = 0;
  }
  emit(o) { const u = { order_id: o.id, status: o.status, filled_quantity: o.filled, average_price: o.avg, paper: true }; this.defer(() => this.onUpdate(u)); }
  async place({ side, price, qty }) {
    if (!(price > 0) || !(qty > 0) || !["BUY", "SELL"].includes(side)) throw new Error("Paper order theek nahi");
    const id = "P" + (++this.n), o = { id, side, price: +price, qty, filled: 0, avg: 0, status: "OPEN", at: this.now() };
    this.orders.set(id, o);
    return id;
  }
  // stop-loss order (SELL: waits until the price falls to the trigger, then works as a limit order)
  async placeSL({ side, trigger, price, qty }) {
    if (!(trigger > 0) || !(price > 0) || !(qty > 0) || !["BUY", "SELL"].includes(side)) throw new Error("Paper SL order theek nahi");
    if (side === "SELL" && price > trigger) throw new Error("SELL SL mein limit trigger se upar nahi ho sakti");
    const id = "P" + (++this.n), o = { id, side, price: +price, trigger: +trigger, qty, filled: 0, avg: 0, status: "TRIGGER PENDING", at: this.now() };
    this.orders.set(id, o);
    return id;
  }
  async modifySL(id, { trigger, price }) {
    const o = this.orders.get(String(id));
    if (!o || o.status !== "TRIGGER PENDING") throw new Error(`Order ab khula nahi hai (${o?.status || "?"}).`);
    o.trigger = +trigger; o.price = +price;
    this.tick(this.ltp());
  }
  async cancel(id) {
    const o = this.orders.get(String(id));
    if (!o) throw new Error("Paper order nahi mila");
    if (o.status !== "OPEN" && o.status !== "TRIGGER PENDING") throw new Error(`Order ab khula nahi hai (${o.status}).`);
    o.status = "CANCELLED"; this.emit(o);
  }
  async modify(id, { price }) {
    const o = this.orders.get(String(id));
    if (!o || o.status !== "OPEN") throw new Error(`Order ab khula nahi hai (${o?.status || "?"}).`);
    o.price = +price; delete o.trigger;                       // a re-priced triggered SL is a plain limit order
    this.tick(this.ltp());                                   // a re-priced order may now fill at once
  }
  // call on every live price
  tick(px) {
    if (!(px > 0)) return;
    for (const o of this.orders.values()) {
      if (o.status === "TRIGGER PENDING") {                  // stop-loss: wake up when the price crosses the trigger
        if (o.side === "SELL" ? px > o.trigger : px < o.trigger) continue;
        o.status = "OPEN"; this.emit(o);
      }
      if (o.status !== "OPEN") continue;
      const hit = o.side === "BUY" ? px <= o.price : px >= o.price;
      if (!hit) continue;
      o.status = "COMPLETE"; o.filled = o.qty; o.avg = o.side === "BUY" ? Math.min(o.price, px) : Math.max(o.price, px);
      this.emit(o);
    }
  }
  // after a page reload: take back the bracket's open orders from its saved state
  adopt(list) {
    for (const x of list) {
      if (!x?.id) continue;
      this.orders.set(String(x.id), { id: String(x.id), side: x.side, price: +x.price, qty: +x.qty, filled: 0, avg: 0, at: this.now(),
        ...(x.trigger ? { trigger: +x.trigger, status: x.status === "OPEN" ? "OPEN" : "TRIGGER PENDING" } : { status: "OPEN" }) });
      const k = +String(x.id).replace(/^P/, ""); if (k > this.n) this.n = k;
    }
  }
}
