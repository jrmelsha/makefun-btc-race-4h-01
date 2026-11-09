// cbBTC/USDC core-plus-dip bot for make.fun btc-race-4h-01 (agent-fun/bars-replay/v1).
//
// The race pays the highest net PnL over 4 hours, and in most 4-hour slices of the dev window the
// dip-reversion field makes nothing at all. So this bot holds two sleeves of one position:
//   - Core: on the first batch it buys CORE_BPS of its cash and holds it to the end of the window
//     (the harness sells it at the last close). It is the bot's trade on every window, and its
//     edge whenever BTC drifts up while the reversion bots sit in cash.
//   - Dip: with the rest of the cash, when a bar's close sits at least DIP_BPS under the simple
//     moving average of the last SMA_BARS closes (current close included), it buys; that sleeve
//     exits on TP_BPS over its cost, SL_BPS under it, or after MAX_HOLD_BARS bars.
// Each batch's fills say which sleeve an order filled for. All price math is bigint on the
// harness's integer prices: no wall clock, no randomness, so two executions send the same orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const CORE_BPS = 5_000n;
const SMA_BARS = 5;
const DIP_BPS = 35n;
const TP_BPS = 80n;
const SL_BPS = 150n;
const MAX_HOLD_BARS = 120;
const ENTRY_SLIPPAGE_BPS = 100;
const EXIT_SLIPPAGE_BPS = 300;

const closes: bigint[] = [];
let batches = 0;
/** What each order we sent was for, by client id. */
const roles = new Map<string, 'core' | 'dip' | 'exit'>();
let coreQty = 0n;
let coreFilled = false;
let corePending = false;
let dipQty = 0n;
let dipCost = 0n;
let dipPending = false;
let exitPending = false;
let dipBatch = 0;

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
    for (const fill of batch.fills) {
      const role = roles.get(fill.client_id);
      roles.delete(fill.client_id);
      if (role === 'core') {
        corePending = false;
        if (fill.status === 'filled') {
          coreQty += BigInt(fill.qty);
          coreFilled = true;
        }
      } else if (role === 'dip') {
        dipPending = false;
        if (fill.status === 'filled') {
          dipQty = BigInt(fill.qty);
          dipCost = BigInt(fill.notional_quote_units);
        }
      } else if (role === 'exit') {
        exitPending = false;
        if (fill.status === 'filled') {
          dipQty = 0n;
          dipCost = 0n;
        }
      }
    }

    const symbol = state.hello.symbols[0].symbol;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > SMA_BARS) closes.shift();

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const orders: (SellInput | BuyInput)[] = [];

    // Core sleeve: bought once, retried until the market fills it.
    if (!coreFilled) {
      if (!corePending) {
        const notional = (state.cash * CORE_BPS) / BPS;
        if (notional >= minNotional) {
          const id = state.clientId();
          roles.set(id, 'core');
          corePending = true;
          orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: EXIT_SLIPPAGE_BPS, client_id: id });
        }
      }
      return orders;
    }
    if (dipPending || exitPending) return orders;

    if (dipQty > 0n) {
      const value = state.value(symbol, dipQty);
      const exit =
        value * BPS >= dipCost * (BPS + TP_BPS) ||
        value * BPS <= dipCost * (BPS - SL_BPS) ||
        batches - dipBatch >= MAX_HOLD_BARS;
      if (exit) {
        const id = state.clientId();
        roles.set(id, 'exit');
        exitPending = true;
        orders.push({ side: 'sell', symbol, qty: dipQty, max_slippage_bps: EXIT_SLIPPAGE_BPS, client_id: id });
      }
      return orders;
    }

    if (dipNow(close) && state.cash >= minNotional) {
      const id = state.clientId();
      roles.set(id, 'dip');
      dipPending = true;
      dipBatch = batches;
      orders.push({ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: ENTRY_SLIPPAGE_BPS, client_id: id });
    }
    return orders;
  },
});
