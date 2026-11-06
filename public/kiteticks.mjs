// Zerodha Kite WebSocket (wss://ws.kite.trade) binary tick parser + candle builder. Used by the chart page.
// Packet layout (big-endian, prices in paise for NSE/BSE/NFO):
//   message: int16 packetCount, then per packet: int16 length + bytes
//   ltp mode (8):            token, ltp
//   index quote/full (28/32): token, ltp, high, low, open, close, change, [exchange time]
//   quote/full (44/184):     token, ltp, last qty, avg price, volume, buy qty, sell qty, open, high, low, close,
//                            full only: last trade time, OI, OI high, OI low, exchange time, then 10 x 12-byte depth
//                            (qty int32, price int32, orders int16, 2 pad): 5 bids then 5 asks
export function parseTicks(buf) {
  const v = new DataView(buf), out = [];
  if (buf.byteLength < 2) return out;                      // 1-byte heartbeat
  const n = v.getInt16(0); let off = 2;
  for (let i = 0; i < n && off + 2 <= buf.byteLength; i++) {
    const len = v.getInt16(off), p = off + 2; off = p + len;
    if (len < 8 || off > buf.byteLength) continue;
    const t = { token: v.getInt32(p), ltp: v.getInt32(p + 4) / 100 };
    if (len === 28 || len === 32) { t.index = true; t.high = v.getInt32(p + 8) / 100; t.low = v.getInt32(p + 12) / 100; t.open = v.getInt32(p + 16) / 100; t.close = v.getInt32(p + 20) / 100; }
    else if (len >= 44) {
      t.volume = v.getInt32(p + 16); t.open = v.getInt32(p + 28) / 100; t.high = v.getInt32(p + 32) / 100; t.low = v.getInt32(p + 36) / 100; t.close = v.getInt32(p + 40) / 100;
      t.buyQty = v.getInt32(p + 20); t.sellQty = v.getInt32(p + 24); t.avg = v.getInt32(p + 12) / 100;   // avg = the day's average traded price (VWAP)
      if (len >= 184) {                                      // full mode: OI + 5 best bids and 5 best asks (12 bytes each)
        t.oi = v.getInt32(p + 48);
        const lvl = (q) => ({ qty: v.getInt32(q), price: v.getInt32(q + 4) / 100, orders: v.getInt16(q + 8) });
        t.depth = { buy: [0, 1, 2, 3, 4].map((i) => lvl(p + 64 + i * 12)), sell: [0, 1, 2, 3, 4].map((i) => lvl(p + 124 + i * 12)) };
        t.bid = t.depth.buy[0].price || null; t.ask = t.depth.sell[0].price || null;
      }
    }
    out.push(t);
  }
  return out;
}

export const IST = 19800;                                   // seconds; chart times are shown in India time
// Bucket start (chart time, IST-shifted seconds) for a tick at epoch ms.
export function bucketOf(ms, sec) {
  const s = Math.floor(ms / 1000) + IST;
  return Math.floor(s / sec) * sec;
}

// Apply one tick to a bar list (mutates). dv = volume traded since the previous tick. Returns the bar that changed.
export function applyTick(bars, ms, price, dv, sec) {
  const time = bucketOf(ms, sec), last = bars[bars.length - 1];
  if (last && time === last.time) {
    last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; last.volume += dv;
    return last;
  }
  if (last && time < last.time) return null;                // late tick for an old bucket: ignore
  const bar = { time, open: price, high: price, low: price, close: price, volume: dv };
  bars.push(bar);
  return bar;
}

// Build bars of `sec` seconds from a tick list [{ms, price, dv}]
export function barsFromTicks(ticks, sec) {
  const bars = [];
  for (const t of ticks) applyTick(bars, t.ms, t.price, t.dv, sec);
  return bars;
}

// Text messages on the same WebSocket: {"type":"order","data":{...}} is a live update for one of your orders.
export function orderUpdate(text) {
  try { const m = JSON.parse(text); return m && m.type === "order" && m.data?.order_id ? m.data : null; } catch { return null; }
}
