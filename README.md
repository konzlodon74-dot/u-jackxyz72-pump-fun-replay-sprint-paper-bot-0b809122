# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/konzlodon74-dot/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/konzlodon74-dot/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty: it trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins.

## Strategy: Near-Completion Hunter

A pump.fun curve migrates when its real SOL reserves reach 85 SOL. This bot buys a coin exactly once, late in its curve life:

- **Tier A** — real reserves first reach **55 SOL**: buy **0.30 SOL**.
- **Tier C** — real reserves first reach **45 SOL** on the back of one very large buy (**≥ 5 SOL** in a single batch): buy **0.10 SOL**.

Crossings are detected trade by trade inside each batch: a coin can cross a tier mid-batch and fall back before the batch ends, and judging only by batch-end reserves would miss it. (Note: a coin that jumps straight from below 55 SOL to migration — 85 SOL — inside a single slot cannot be bought: by the time any bot can act, the curve has already completed.)

It deliberately does **not** chase the first-trade spike and does **not** buy momentum breakouts: with 2 slots of latency a fill lands after the move.

## Exits

- Take-profit **+25%**, stop-loss **−10%** (mark-to-market vs. cost, fees included in cost).
- Or after at most **120 further trades** / **40,000 slots**, whichever comes first.
- A curve that migrates is closed by the harness itself.

## Risk controls

- At most 5 open positions; one position per mint, one entry per mint per run.
- Every buy capped at 1% of the coin's real reserves and at free cash.
- Every order carries a 5% max-slippage guard.
- No shorts, no leverage. No randomness, no clock, no network, no files: every decision is a pure function of the hello/batch messages, so two runs produce identical action logs.

## Layout

- `main.ts` — the bot (runs as `node /bot/main.ts` under the grader).
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 SDK shim, byte-identical to `sdk/ts/makefun-bot.ts`.
- `LICENSE` — MIT.

## Local grading

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this directory> --driver process
```
