// cbBTC/USDC dip-reversion bot for make.fun btc-race-4h-01 (agent-fun/bars-replay/v1).
//
// Each batch carries one 1-minute bar. The bot answers with at most a couple of orders:
//   - Probe: on the first batch it buys the minimum notional (1 USDC) and sells it on the next
//     batch, so the race window always counts at least 1 trade at a cost of a fraction of a cent.
//   - Entry: when the bar's close sits at least DIP_BPS under the simple moving average of the last
//     SMA_BARS closes (current close included), it buys with all its cash. A one-minute dislocation
//     that large on this pool tends to revert, and it has to beat the ~26 bps round-trip cost.
//   - Exit: the whole position when its value at the close is TP_BPS over its cost, SL_BPS under it,
//     or after MAX_HOLD_BARS bars.
// All price math is bigint on the harness's integer prices: no wall clock, no randomness, so two
// executions on the same bars send the same orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SMA_BARS = 5;
const DIP_BPS = 35n;
const TP_BPS = 80n;
const SL_BPS = 150n;
const MAX_HOLD_BARS = 120;
const ENTRY_SLIPPAGE_BPS = 100;
const EXIT_SLIPPAGE_BPS = 300;
/** Give up on the probe if the market refuses it this many batches in a row. */
const PROBE_TRIES = 10;

const closes: bigint[] = [];
let batches = 0;
/** What the open position is: the probe, or a dip entry. */
let kind: 'probe' | 'dip' | null = null;
let entryBatch = 0;
let probeFilled = false;

function dipNow(close: bigint): boolean {
  if (closes.length < SMA_BARS) return false;
  let sum = 0n;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) sum += closes[i];
  // close < sma * (1 - DIP/BPS)  <=>  close * SMA_BARS * BPS < sum * (BPS - DIP)
  return close * BigInt(SMA_BARS) * BPS < sum * (BPS - DIP_BPS);
}

await runBars({
  onBatch(state, batch) {
    batches++;
    const symbol = state.hello.symbols[0].symbol;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > SMA_BARS) closes.shift();

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const held = state.positions.get(symbol);
    const orders: (SellInput | BuyInput)[] = [];

    if (held !== undefined && held.qty > 0n) {
      if (kind === 'probe') probeFilled = true;
      if (kind === null) kind = 'dip';
      let exit = false;
      // The probe, or any dust a refused sell left behind: sell it now.
      if (kind === 'probe' || held.cost < minNotional * 10n) exit = true;
      else {
        const value = state.value(symbol, held.qty);
        const cost = held.cost;
        if (value * BPS >= cost * (BPS + TP_BPS)) exit = true;
        else if (value * BPS <= cost * (BPS - SL_BPS)) exit = true;
        else if (batches - entryBatch >= MAX_HOLD_BARS) exit = true;
      }
      if (exit) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: EXIT_SLIPPAGE_BPS });
        kind = null;
      }
      return orders;
    }

    // Flat: a dip entry first, else the probe until one fills.
    kind = null;
    if (dipNow(close) && state.cash >= minNotional) {
      orders.push({ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: ENTRY_SLIPPAGE_BPS });
      kind = 'dip';
      entryBatch = batches;
      return orders;
    }
    if (!probeFilled && batches <= PROBE_TRIES && state.cash >= minNotional) {
      orders.push({ side: 'buy', symbol, notional_quote_units: minNotional, max_slippage_bps: EXIT_SLIPPAGE_BPS });
      kind = 'probe';
      entryBatch = batches;
    }
    return orders;
  },
});
