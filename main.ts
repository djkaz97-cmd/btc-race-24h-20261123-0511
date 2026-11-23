// cbBTC staged-hold racer.
//
// The market pays nothing for churn: a full-size round trip costs about 26-45 bps in
// fee, slippage and price impact, and the window is only 24 hours of one asset. So the
// bot buys CBBTC once, in two tranches on the first two batches it can trade, and then
// holds. Its one defensive rule is a wide trailing stop measured on closes: when the
// close gives back TRAIL_BPS of the highest close since entry, everything is sold, and
// after a cooldown the bot may buy back once if the close has recovered well above the
// exit. The stop is deliberately far away (6.5%, several daily sigma of BTC) so ordinary
// intraday chop never touches it, while a real crash exits long before the 25% drawdown
// guardrail.
//
// Every decision is a pure function of the batches: no clock, no randomness, no
// environment, BigInt arithmetic only, so two executions emit byte-identical orders.

import { BPS, runBars, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** How the starting capital is spent, in order, on the first two tradable batches. */
const TRANCHE_BPS: readonly bigint[] = [5_500n, 4_500n];
/** Sell everything when the close is this far below the highest close since entry. */
const TRAIL_BPS = 650n;
/** Filled buys in total: the two staged tranches and at most one re-entry. */
const MAX_ENTRIES = 3;
/** Bars to wait after a stop-out before the (single) re-entry is considered. */
const COOLDOWN_BARS = 60;
/** The close must be this far above the exit fill price for the re-entry to fire. */
const REENTRY_MARGIN_BPS = 300n;
/** Order-level slippage guards, measured from the latest close. */
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1_000;

/** Index of the next staged tranche to spend (0 and 1 while staging completes). */
let stage = 0;
/** Client id of the buy awaiting its fill report, or null when none is in flight. */
let sentBuyId: string | null = null;
/** Filled buys of ours so far. */
let entries = 0;
/** Highest close (or fill price) since the last entry, in price units. */
let peak = 0n;
/** True once a trailing-stop sell has filled: the staged plan is over for good. */
let stopped = false;
/** Fill price of the last stop-out and the seq at which it filled. */
let exitPrice = 0n;
let exitBar = -1;
let serial = 0;

const nextId = (prefix: string): string => `${prefix}${++serial}`;

const minNotional = (state: { hello: { fees: { min_notional_quote_units: string } } }): bigint =>
  BigInt(state.hello.fees.min_notional_quote_units);

/** Cash to put into one buy: never more than the weight room, the cash, or what is wanted. */
function buySize(state: { cash: bigint; weightRoom: (symbol: string) => bigint }, want: bigint): bigint {
  let notional = want;
  const room = state.weightRoom(SYMBOL);
  if (room < notional) notional = room;
  if (state.cash < notional) notional = state.cash;
  return notional;
}

await runBars({
  onBatch(state, batch) {
    // ---------------------------------------------------------------- 1. settle the last reply
    // The batch carries the fills of the orders sent on the previous one, so the account it
    // reports already includes them. Only our own ids are read; _flatten_* are the harness's.
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) continue;
      if (fill.client_id === sentBuyId) {
        if (fill.status === 'filled') {
          entries++;
          if (fill.client_id.startsWith('s')) stage++;
          const px = BigInt(fill.price);
          if (px > peak) peak = px;
        }
        sentBuyId = null;
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        stopped = true;
        exitPrice = BigInt(fill.price);
        exitBar = batch.seq;
        peak = 0n;
      }
    }

    const close = state.close(SYMBOL);
    if (close === null || state.warmingUp) return [];

    // ---------------------------------------------------------------- 2. in a position: trail the peak,
    // and finish the staged plan while its second tranche is still unspent
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    if (held > 0n) {
      if (close > peak) peak = close;
      if (peak > 0n && close * BPS <= peak * (BPS - TRAIL_BPS)) {
        const order: SellInput = {
          side: 'sell',
          client_id: nextId('x'),
          symbol: SYMBOL,
          qty: held,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        return [order];
      }
      if (!stopped && stage < TRANCHE_BPS.length && sentBuyId === null) {
        const start = BigInt(state.hello.capital.quote_units);
        const notional = buySize(state, (start * TRANCHE_BPS[stage]!) / BPS);
        if (notional < minNotional(state)) return [];
        const id = nextId('s');
        sentBuyId = id;
        const order: BuyInput = {
          side: 'buy',
          client_id: id,
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        };
        return [order];
      }
      return [];
    }

    // ---------------------------------------------------------------- 3. flat: staged accumulation first
    if (!stopped && stage < TRANCHE_BPS.length) {
      if (sentBuyId !== null) return [];
      const start = BigInt(state.hello.capital.quote_units);
      const notional = buySize(state, (start * TRANCHE_BPS[stage]!) / BPS);
      if (notional < minNotional(state)) return [];
      const id = nextId('s');
      sentBuyId = id;
      const order: BuyInput = {
        side: 'buy',
        client_id: id,
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      };
      return [order];
    }

    // ---------------------------------------------------------------- 4. flat after a stop: one re-entry
    if (stopped && entries < MAX_ENTRIES && exitBar >= 0 && batch.seq - exitBar >= COOLDOWN_BARS) {
      if (exitPrice > 0n && close * BPS >= exitPrice * (BPS + REENTRY_MARGIN_BPS)) {
        const notional = buySize(state, state.cash);
        if (notional < minNotional(state)) return [];
        const id = nextId('r');
        sentBuyId = id;
        const order: BuyInput = {
          side: 'buy',
          client_id: id,
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        };
        return [order];
      }
    }
    return [] as OrderInput[];
  },
});
