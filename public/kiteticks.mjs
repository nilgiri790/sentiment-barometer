// Zerodha Kite WebSocket (wss://ws.kite.trade) binary tick parser + candle builder. Used by the chart page.
// Packet layout (big-endian, prices in paise for NSE/BSE/NFO):
//   message: int16 packetCount, then per packet: int16 length + bytes
//   ltp mode (8):            token, ltp
//   index quote/full (28/32): token, ltp, high, low, open, close, change, [exchange time]
//   quote/full (44/184):     token, ltp, last qty, avg price, volume, buy qty, sell qty, open, high, low, close, ...
export function parseTicks(buf) {
  const v = new DataView(buf), out = [];
  if (buf.byteLength < 2) return out;                      // 1-byte heartbeat
  const n = v.getInt16(0); let off = 2;
  for (let i = 0; i < n && off + 2 <= buf.byteLength; i++) {
    const len = v.getInt16(off), p = off + 2; off = p + len;
    if (len < 8 || off > buf.byteLength) continue;
    const t = { token: v.getInt32(p), ltp: v.getInt32(p + 4) / 100 };
    if (len === 28 || len === 32) { t.index = true; t.high = v.getInt32(p + 8) / 100; t.low = v.getInt32(p + 12) / 100; t.open = v.getInt32(p + 16) / 100; t.close = v.getInt32(p + 20) / 100; }
    else if (len >= 44) { t.volume = v.getInt32(p + 16); t.open = v.getInt32(p + 28) / 100; t.high = v.getInt32(p + 32) / 100; t.low = v.getInt32(p + 36) / 100; t.close = v.getInt32(p + 40) / 100; }
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
