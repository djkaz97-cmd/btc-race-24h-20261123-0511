[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/djkaz97-cmd/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/djkaz97-cmd/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# cbBTC staged-hold racer

A long-only bot for make.fun's 24-hour cbBTC race. It trades one symbol (CBBTC) on the
`agent-fun/bars-replay/v1` line protocol: it reads one JSON line per minute on stdin —
`hello` once, then a `batch` carrying the bar that just closed, the fills of the previous
reply and the account — and answers each `batch` with exactly one `reply` line of
`orders`, echoing its `seq`.

The market charges about 26–45 bps for a full-size round trip (4 bps fee on each fill,
2 bps modelled slippage, and constant-product price impact against the bar's pool depth),
so the bot trades rarely by design:

1. **Staged entry.** On the first two batches it can trade, it spends 55% and then 45% of
   the starting capital on CBBTC. Two buys keep the average entry price from resting on a
   single minute's open, and both are sized from `hello.capital.quote_units`, the account's
   cash and `weightRoom()` so the position never passes `caps.max_weight_bps`.
2. **Hold.** No signal, no churn: a 24-hour window of one asset has no reliable faster
   edge that survives the round-trip cost.
3. **Wide trailing stop.** If a close gives back 650 bps of the highest close since entry
   (or the entry fill, if that is higher), the whole position is sold at the next open.
   6.5% is several daily sigma of BTC: ordinary chop never reaches it, while a real crash
   exits far above the 25% drawdown guardrail.
4. **One recovery re-entry.** After a stop-out the bot waits 60 bars, and if the close has
   recovered 300 bps above the exit fill price it buys back once with all its cash. If the
   bounce fails, the same trailing stop caps the second loss too; there is never a third
   entry.

Orders carry `max_slippage_bps` of 500 on buys and 1,000 on sells, measured from the
latest close, so a pathological gap rejects the order instead of filling it at any price.
All arithmetic is BigInt; there is no clock, no randomness and no environment read, so two
executions on the same bars emit byte-identical orders.

`vendor/makefun-bars.ts` is a byte-for-byte copy of the kit's `sdk/makefun-bars.ts`; it
owns the wire, the state and the protocol checks. Everything else in this repository is
the strategy.

## Dev window result

Graded with the kit's own harness on the published 1,440-bar dev window
(`node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process`):

| metric | value |
| --- | --- |
| net PnL | **+33.100125 USDC** (return +3.310013%) |
| trades | 2 (both buys; the harness closes the position at the last close) |
| max drawdown | 1.978% |
| fees | 0.813406 USDC |
| rejected orders | 0 |
| guardrails | met (trades ok, symbols ok, drawdown ok) |
| determinism | L1 regrade reproduced byte for byte |

The dev window rallies about 3.6% from the first open to the last close; the staged entry
buys the second tranche slightly below the first, which is where the extra ~0.9 USDC over
a plain buy-and-hold comes from. The trailing stop never fires on it — by construction it
sits outside the window's 1.98% peak-to-close drawdown.

## Run it

```
node main.ts
```

The bot speaks the `agent-fun/bars-replay/v1` protocol on stdin/stdout: the harness writes
`hello`, one `batch` per minute and `done`; the bot answers one `reply` per batch. It needs
Node 22.18+ (TypeScript type stripping, imports with the `.ts` extension) and no
dependencies, no build step and no network.
