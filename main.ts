// Pump.fun Replay Sprint — Paper Bot: "Near-Completion Hunter".
//
// Strategy, in plain words:
//   A pump.fun bonding curve migrates when its real SOL reserves reach 85 SOL.
//   This bot buys a coin exactly once, late in its curve life, in one of two ways:
//     Tier A — the coin's real reserves first reach 55 SOL: buy 0.30 SOL.
//     Tier C — the coin's real reserves first reach 45 SOL on the back of one
//              very large buy (>= 5 SOL) inside a single batch: buy 0.10 SOL.
//   It deliberately does NOT chase the first-trade spike and does NOT buy
//   momentum breakouts: with 2 slots of latency a fill lands after the move.
//   Crossings are detected trade by trade inside each batch: a coin can cross
//   a tier mid-batch and fall back before the batch ends, and only the
//   batch-end reserves would miss it. It exits on take-profit +25%, stop-loss
//   -10%, or after at most 120 further trades / 40,000 slots, whichever comes
//   first. A curve that migrates is closed by the harness itself.
//
// Risk controls:
//   - at most 5 open positions; one position per mint, one entry per mint per run
//   - every buy capped at 1% of the coin's real reserves and at free cash
//   - every order carries a 5% max-slippage guard
//   - no shorts, no leverage
//
// Determinism: every decision is a pure function of the hello/batch messages
// (no clock, no randomness, no network, no files), so two runs produce
// identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry tiers (real SOL reserves, lamports) ----
const TIER_A_RESERVE = 55n * SOL;
const TIER_A_STAKE = 300_000_000n; // 0.30 SOL
const TIER_C_RESERVE = 45n * SOL;
const TIER_C_WHALE_BUY = 5n * SOL; // one buy of >= 5 SOL in a single batch
const TIER_C_STAKE = 100_000_000n; // 0.10 SOL

// ---- exits ----
const TAKE_PROFIT_BPS = 12_500n; // position value >= 125% of cost
const STOP_LOSS_BPS = 9_000n; // position value <= 90% of cost
const MAX_TRADES_HELD = 120; // further trades on the mint after entry
const MAX_SLOTS_HELD = 40_000; // slots after the entry decision
const MAX_SLIPPAGE_BPS = 500; // 5% guard on every order
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip floor

interface EntryInfo {
  entrySlot: number;
  entryTrades: number;
}

// Mints already entered (or decided and skipped): one entry per mint per run.
const decided = new Set<string>();
// Live entries, for the age-based exits.
const entries = new Map<string, EntryInfo>();
// Real SOL reserves last seen for each mint, to detect a first crossing.
const prevReal = new Map<string, bigint>();

// Mark-to-market value of `tokens` at the curve's current virtual reserves.
function markValueLamports(tokens: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (tokens * virtualQuote) / virtualToken;
}

// Diagnostics only (stderr never enters the action log).
const stats = {
  tierA: 0,
  tierC: 0,
  skippedNoSlot: 0,
  skippedNoCash: 0,
  buysSent: 0,
  sellsSent: 0,
  buysRejected: 0,
  sellsRejected: 0,
};

await runBot({
  onBatch(state: BotState, batch: Batch) {
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') stats.buysRejected += 1;
      if (f.status === 'rejected' && f.side === 'sell') stats.sellsRejected += 1;
    }
    const orders: Array<BuyInput | SellInput> = [];
    const tx = state.txFeeLamports();
    const caps = state.hello.caps;

    // ---- exits first: take-profit, stop-loss, or aged out ----
    const selling = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') selling.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Never exit blind: without current virtual reserves there is no price.
      if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) continue;
      const value = markValueLamports(
        pos.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      const ratioBps = pos.cost_lamports > 0n ? (value * 10_000n) / pos.cost_lamports : 0n;
      const info = entries.get(mint);
      const agedOut =
        info !== undefined &&
        (state.slot - info.entrySlot >= MAX_SLOTS_HELD ||
          curve.trades - info.entryTrades >= MAX_TRADES_HELD);
      if (ratioBps >= TAKE_PROFIT_BPS || ratioBps <= STOP_LOSS_BPS || agedOut) {
        if (orders.length >= caps.max_orders_per_batch) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        selling.add(mint);
        stats.sellsSent += 1;
      }
    }

    // ---- prune entry records whose buy never filled / position is gone ----
    const buying = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') buying.add(p.order.mint);
    }
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint) && !buying.has(mint)) entries.delete(mint);
    }

    // ---- entries: first crossing of a tier, decided once per mint ----
    // Replay this batch's trades in order: a coin can cross a tier mid-batch
    // and fall back before the batch ends, so crossings are detected trade by
    // trade, not from the batch-end reserves. A tier-C crossing only counts
    // when the whale buy itself is the trade that pushes reserves over 45.
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const touched: string[] = [];
    const seenTouched = new Set<string>();
    const crossed = new Map<string, { tier: 'A' | 'C' }>();
    const running = new Map<string, bigint>();
    for (const e of batch.events) {
      if (!seenTouched.has(e.mint)) {
        seenTouched.add(e.mint);
        touched.push(e.mint);
      }
      if (e.event !== 'TradeEvent' || crossed.has(e.mint)) continue;
      const before = running.get(e.mint) ?? prevReal.get(e.mint) ?? 0n;
      const after = BigInt(e.real_quote_reserves);
      running.set(e.mint, after);
      if (before < TIER_A_RESERVE && after >= TIER_A_RESERVE) {
        crossed.set(e.mint, { tier: 'A' });
        stats.tierA += 1;
      } else if (
        before < TIER_C_RESERVE &&
        after >= TIER_C_RESERVE &&
        e.is_buy &&
        BigInt(e.sol_amount) >= TIER_C_WHALE_BUY
      ) {
        crossed.set(e.mint, { tier: 'C' });
        stats.tierC += 1;
      }
    }
    for (const mint of touched) {
      const cross = crossed.get(mint);
      if (cross === undefined || decided.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const stake = cross.tier === 'A' ? TIER_A_STAKE : TIER_C_STAKE;
      decided.add(mint);
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) {
        stats.skippedNoSlot += 1;
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      let amount = stake < cap ? stake : cap;
      if (amount + tx > free) amount = free - tx;
      if (amount < MIN_BUY_LAMPORTS) {
        stats.skippedNoCash += 1;
        continue;
      }
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      stats.buysSent += 1;
      entries.set(mint, { entrySlot: state.slot, entryTrades: curve.trades });
      free -= amount + tx;
      slots -= 1;
    }
    // Remember this batch's reserves so the next batch can spot a first crossing.
    for (const mint of touched) {
      const curve = state.curves.get(mint);
      if (curve !== undefined) prevReal.set(mint, curve.real_quote_reserves);
    }
    return orders;
  },
  onDone(state) {
    console.error(
      `[near-completion-hunter] tierA=${stats.tierA} tierC=${stats.tierC} ` +
        `skippedNoSlot=${stats.skippedNoSlot} skippedNoCash=${stats.skippedNoCash} ` +
        `buysSent=${stats.buysSent} buysRejected=${stats.buysRejected} ` +
        `sellsSent=${stats.sellsSent} sellsRejected=${stats.sellsRejected} ` +
        `finalCash=${state.cash.toString()}`,
    );
  },
});
