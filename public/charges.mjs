// Zerodha charges for NSE index OPTIONS (estimate). Rates as of Nov 2026 — check zerodha.com/charges if they change:
//   brokerage ₹20 per executed order · STT 0.15% of premium on SELL (Budget 2026, from 1 Apr 2026)
//   NSE transaction charge 0.03503% of premium · SEBI ₹10 per crore · stamp duty 0.003% on BUY
//   GST 18% on (brokerage + transaction charge + SEBI fee)
export const OPTION_RATES = { brokerage: 20, stt: 0.0015, txn: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 };

const r2 = (x) => Math.round(x * 100) / 100;
// buy / sell = premium x qty (rupees); orders = executed orders (normally 1 buy + 1 sell)
export function optionCharges({ buy = 0, sell = 0, buyOrders = buy > 0 ? 1 : 0, sellOrders = sell > 0 ? 1 : 0 }, R = OPTION_RATES) {
  const brokerage = R.brokerage * (buyOrders + sellOrders);
  const stt = Math.round(sell * R.stt);                       // STT is rounded to the rupee on the contract note
  const txn = (buy + sell) * R.txn, sebi = (buy + sell) * R.sebi, stamp = buy * R.stamp;
  const gst = (brokerage + txn + sebi) * R.gst;
  const total = brokerage + stt + txn + sebi + stamp + gst;
  return { brokerage: r2(brokerage), stt: r2(stt), txn: r2(txn), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst), total: r2(total) };
}
