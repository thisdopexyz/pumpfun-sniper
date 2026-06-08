# PumpFun Sniper Bot

Production-grade Solana bonding curve sniper bot for Pump.fun and BonkFun (Raydium LaunchLab).

## Quick Start

```bash
# Start bot (screen session 'bot')
start-bot

# Stop bot
stop-bot

# Check status
status-bot

# Restart
restart-bot

# Tail logs
tail-bot

# Force sell a position
sell <MINT_ADDRESS>

# Build
cd ~/workspace/pumpfun && npm run build

# Run directly
cd ~/workspace/pumpfun && node dist/main.js
```

## Architecture

10-layer TypeScript architecture with 120+ source files:

- **Core**: Types, interfaces, constants (LOCKED values), utils
- **App**: DI container, bootstrap, data provider, entry checks, execution delegates
- **Strategy**: Filtered sniper (23 entry checks, exit logic, position sizing)
- **Detectors**: 11 detectors (launch, momentum, bundle, wash trade, migration, etc.)
- **Risk**: Kill switch, daily loss guard, cooldown, anti-rug, max exposure, blacklists
- **Execution**: TX building, signing, sending (RPC), venue-specific executors
- **Adapters**: PumpFun protocol (SDK), BonkFun/LaunchLab, Jupiter DEX
- **Ingestion**: WebSocket handler, RPC pool (Helius > PublicNode > Alchemy), event pipeline
- **Storage**: PostgreSQL (trades, signals, risk_state, creator_stats), Redis (optional)
- **Telemetry**: Pino logger, Prometheus metrics

## Pipeline Flow

```
Helius WS → wsMessageHandler → EventDispatcher → Detectors
  → MomentumSignal → FilteredSniperStrategy
  → DataProvider (7 parallel RPC calls)
  → EntryCheckEvaluator (23 checks, ALL must pass)
  → BuyExecutor → TX build → Sign → Send → Confirm
  → ExitMonitor (1s poll) → ExitDecision
  → SellExecutor → Confirm → PnL → Cooldown
```

## 23 Entry Checks

ALL must pass before buy:

1. Launch detected
2. Creator not blacklisted
3. Creator history OK (≤3 launches/1hr, score ≥ 30)
4. Mint authority revoked
5. Freeze authority revoked
6. Metadata sane (name 1-50 chars, symbol 1-12 chars, no scam patterns)
7. Liquidity sane (SOL reserves ≥ 0.1 SOL)
8. Wallet concentration OK (top 5 < 75%)
9. Momentum threshold (≥15 buys, ≥10 SOL volume, 30s window)
10. Price impact ≤ 700 bps (7%)
11. Bundle ≤ 40% (BLOCK if no data)
12. Wash trade score ≤ 60 (BLOCK if no data)
13. Unique wallets ≥ 10
14. Sell pressure ≤ 60% in 60s window
15. Liquidity depth ≥ 0.5 SOL
16. Holder-bundle ratio OK
17. Holder-MCap ratio OK (dynamic by tier)
18. Volume-MCap ratio ≤ 5x
19. Smart money present (boost only)
20. Token age ≥ 1800s (30 min)
21. MCap ≤ $20,000
22. Avg buy size ≥ 0.1 SOL
23. Holder count ≥ 20

## Exit Priority

1. KILL SWITCH — emergency 100% sell
2. SCALE-OUT — +100%→sell 50%, +300%→sell 20%
3. BREAKEVEN SL — after tier 0, if PnL ≤ 0% → sell 100%
4. TRAILING STOP — activates at +200%, 30% drop from high
5. ANTI-RUG — top holder dump detected (5s poll)
6. STOP LOSS — PnL ≤ -50%
7. TAKE PROFIT — PnL ≥ +100,000% (effectively disabled)
8. TIMEOUT — 6 hours

## Key Parameters

| Parameter | Value |
|-----------|-------|
| Position size | $1.00 fixed |
| Stop loss | -50% |
| Trailing activation | +200% |
| Trailing stop | 30% drop (dynamic tightening) |
| Scale-out | +100%→50%, +300%→20% |
| Max concurrent | 1 |
| Slippage | 500 bps (5%) |
| Max price impact | 700 bps (7%) |
| Daily kill | -$40 |
| Cooldown | 10s |
| Anti-rug single dump | > 10% supply |
| Anti-rug cumulative | > 15% top 20 |
| SOL floor | 35 SOL |
| Priority fee | 350k µlamports/CU |
| Momentum | 15 buys / 30s / 10 SOL |
| Token age min | 30 min |
| Max mcap | $20,000 |

## Venues

| Phase | Venue | Method |
|-------|-------|--------|
| Entry (PumpFun) | Bonding curve | @pump-fun/pump-sdk |
| Entry (BonkFun) | LaunchLab | buy_exact_in instruction |
| Exit (pre-grad) | Bonding curve | SDK + instruction |
| Exit (post-grad) | Jupiter V6 | Swap API |

## Risk Components

1. **EmergencyKillSwitch** — global halt
2. **DailyLossGuard** — $40/day limit
3. **CooldownManager** — 10s post-exit
4. **TradeThrottle** — rate limit
5. **MaxExposureGuard** — 1 concurrent position
6. **AntiRugMonitor** — 5s poll, 10%/15% thresholds
7. **CreatorBlacklist** — persisted in DB
8. **TokenBlacklist** — in-memory
9. **SOLFloorMonitor** — force-sell if BC SOL < 35 SOL

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Entry point |
| `src/app/container.ts` | DI container (~40 services) |
| `src/app/dataProvider.ts` | On-chain data for 23 checks |
| `src/app/entryCheckEvaluator.ts` | Pure evaluation logic |
| `src/strategies/filteredSniper/entryDecision.ts` | Entry decision |
| `src/strategies/filteredSniper/exitDecision.ts` | Exit decision |
| `src/strategies/filteredSniper/filteredSniperRules.ts` | All LOCKED constants |
| `src/app/execution/buyExecutor.ts` | Buy execution |
| `src/app/execution/sellExecutor.ts` | Sell execution |
| `src/app/solFloorMonitor.ts` | SOL floor monitor |
| `src/risk/controls/antiRug.ts` | Anti-rug monitor |
| `src/detectors/momentum/momentumDetector.ts` | Momentum detection |
| `src/core/constants/defaults/trading.ts` | Trading constants |
| `src/core/constants/defaults/detection.ts` | Detection constants |
| `src/core/constants/defaults/risk.ts` | Risk constants |

## Aliases (in ~/.bashrc)

```bash
start-bot     # screen -dmS bot + npm start
stop-bot      # kill bot process + screen cleanup
status-bot    # check if running + PID + resource usage
restart-bot   # stop + start
tail-bot      # tail latest log file
sell <MINT>   # force sell via scripts/force-sell.mjs
```

## Pitfalls

1. **Priority fee too low** → TX expires (block height exceeded). Use 350k µlamports/CU.
2. **Constants propagation** — `defaults/` is source of truth. After changes, grep for old values.
3. **Custom 6002 retry** — First buy may fail with fee drift. Bot auto-retries with fresh blockhash.
4. **Exit monitor silence** — Polls every 1s but only logs on trigger. Silence = holding.
5. **Scale-out partial exits** — Sells partial at tiers, remaining rides trailing stop. No cooldown after scale-out.
6. **Token-2022 metadata** — New mints use Token-2022 extensions, not Metaplex PDA.
7. **Graduated token** — Bonding curve complete → price=0 → false SL. Bot checks `complete` flag first.
8. **SOL floor** — Force-sells if BC reserves < 35 SOL (catches dying pools).
9. **Anti-rug** — Monitors top 20 holders every 5s. Dumps > 10% single or > 15% cumulative trigger emergency exit.
10. **Jito bundles** — DISABLED. Bundles not landing in blocks before TX expires.

## Database

PostgreSQL required (fails startup if unavailable):
- `trades` — BUY/SELL records with status, amounts, signatures
- `signals` — All detector signals (LAUNCH, MOMENTUM, BUNDLE, etc.)
- `risk_state` — Key-value store for scale-out tiers, highest prices
- `creator_stats` — Creator performance scores

Redis optional (lazy connect, non-critical).

## Environment

- VPS: Ubuntu 24.04, 2GB RAM
- PostgreSQL: user=pumpfun, db=pumpfun, localhost:5432
- Redis: localhost:6379 (optional)
- RPC: Helius (primary) + PublicNode (fallback)
- WS: Helius WebSocket (2 connections: PumpFun + LaunchLab)
- SOL price: Jupiter → CoinGecko → fallback $150
