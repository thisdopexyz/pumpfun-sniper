# PumpFun Sniper Bot

> Production-grade Solana bonding curve sniper — Pump.fun + BonkFun (Raydium LaunchLab).
> Selective momentum-based execution with 23 entry checks, multi-venue support, and comprehensive risk management.

## Overview

TypeScript bot that monitors Pump.fun token launches via Helius WebSocket, detects momentum signals, runs 23 entry checks, executes buys on bonding curves, and manages exits with trailing stops, scale-out, and anti-rug protection.

Supports classic SPL and Token-2022 mints. Entry via Pump.fun or BonkFun bonding curves. Exit via bonding curve (pre-graduation) or Jupiter aggregator (post-graduation).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        APP LAYER                              │
│           DI Container • Bootstrap • Lifecycle                 │
│   dataProvider • entryCheckEvaluator • solPriceOracle          │
│   solFloorMonitor • positionRecovery • positionReconciler      │
│   venueDetector • wsManager • heliusHolderCount                │
├──────────────────────────────────────────────────────────────┤
│                      STRATEGY LAYER                           │
│        Filtered Sniper • Entry/Exit Decisions                  │
│        Position Sizer • Candle Analyzer • Compound Manager     │
├──────────────────────────────────────────────────────────────┤
│                      EXECUTION LAYER                          │
│   buyExecutor • sellExecutor • bonkfunBuyExecutor              │
│   riskGuardRunner • tradeRecorder • pnlRecorder               │
│   onChainAccounting • rentReclaimer                           │
├──────────────────────────────────────────────────────────────┤
│                       RISK LAYER                              │
│   Emergency Kill Switch • Daily Loss Guard ($40)              │
│   Cooldown Manager (10s) • Trade Throttle                     │
│   Max Exposure Guard (1 concurrent)                           │
│   Anti-Rug Monitor (5s poll, 10%/15% thresholds)              │
│   Creator Blacklist • Token Blacklist                         │
├──────────────────────────────────────────────────────────────┤
│                     DETECTORS LAYER                           │
│   Launch • Momentum • Bundle • Wash Trade • Migration         │
│   DexPaid • Revoke • Smart Money • Cabal                      │
│   Holder Concentration • Day Phase                            │
├──────────────────────────────────────────────────────────────┤
│                     ADAPTERS LAYER                            │
│   PumpFun Protocol (SDK, trade builder, event decoder)        │
│   BonkFun / LaunchLab (trade builder, parser)                 │
│   Jupiter DEX (quote + swap API)                              │
├──────────────────────────────────────────────────────────────┤
│                     INGESTION LAYER                           │
│           WebSocket • RPC Pool • Event Pipeline               │
│           Rate Limiter • Failover (Helius > PublicNode)       │
├──────────────────────────────────────────────────────────────┤
│                     TELEMETRY LAYER                           │
│           Pino Logger • Prometheus Metrics • HTTP Server      │
├──────────────────────────────────────────────────────────────┤
│                      STORAGE LAYER                            │
│                  PostgreSQL • Redis (optional)                 │
├──────────────────────────────────────────────────────────────┤
│                       CORE LAYER                              │
│           Types • Interfaces • Constants • Utils               │
│           Position Registry • Error Types                     │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

```
Helius WS (PumpFun + LaunchLab)
  → wsMessageHandler (parse + decode events)
  → EventNormalizer → EventDispatcher
  → Detectors (launch, momentum, bundle, wash trade, etc.)
  → FilteredSniperStrategy.onSignal()
  → DataProvider (7 parallel RPC calls + DB queries)
  → EntryCheckEvaluator (23 checks)
  → If ALL pass → BuyExecutor → TX build → Sign → Send → Confirm
  → PositionRegistry (track active position)
  → ExitMonitor (1s poll) → ExitDecision (TP/SL/trailing/scale-out/anti-rug)
  → SellExecutor → TX build → Sign → Send → Confirm
  → PnLRecorder → CooldownManager → Cleanup
```

## 23 Entry Checks

Every token must pass **ALL** 23 checks before a buy is executed:

### Basic Safety (1–6)
1. Launch detected (Pump.fun bonding curve creation)
2. Creator not blacklisted
3. Creator history acceptable (≤3 launches in 1hr, score ≥ 30)
4. Mint authority revoked
5. Freeze authority revoked
6. Metadata sane (name 1-50 chars, symbol 1-12 chars, no scam patterns)

### Liquidity & Concentration (7–8)
7. Liquidity sane (virtual SOL reserves ≥ 0.1 SOL)
8. Wallet concentration OK (top 5 holders < 75%)

### Momentum (9)
9. Momentum threshold met (≥15 buys + ≥10 SOL volume in 30s window)

### On-Chain Analysis (10–16)
10. Price impact acceptable (≤ 700 bps / 7%)
11. Bundle check (≤ 40% — BLOCK if data unavailable)
12. Wash trade score OK (≤ 60/100 — BLOCK if data unavailable)
13. Unique wallets ≥ 10 in momentum window
14. Sell pressure OK (sells ≤ 60% of trades in 60s window)
15. Liquidity depth ≥ 0.5 SOL real reserves
16. Holder-bundle ratio OK (not < 100 holders AND > 30% bundled)

### Volume & Holders (17–19)
17. Holder-MCap ratio OK (dynamic thresholds by mcap tier)
18. Volume-MCap ratio OK (≤ 5x — catches wash trade)
19. Smart money present (BOOST only, never blocks)

### Final Filters (20–23)
20. Min token age ≥ 1800s (30 minutes)
21. Max buy mcap ≤ $20,000
22. Min avg buy size ≥ 0.1 SOL (anti micro-buy spam)
23. Min holder count ≥ 20

## Exit Logic (Priority Order)

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | KILL SWITCH | Emergency 100% sell |
| 2 | SCALE-OUT | Partial sell at tiers: +100%→50%, +300%→20% |
| 3 | BREAKEVEN SL | After tier 0: if PnL ≤ 0%, sell 100% |
| 4 | TRAILING STOP | Activates at +200%, drops 30% from high (dynamic tightening) |
| 5 | ANTI-RUG | Top holder dump detected (5s poll) |
| 6 | STOP LOSS | PnL ≤ -50% |
| 7 | TAKE PROFIT | PnL ≥ +100,000% (effectively disabled, scale-out handles) |
| 8 | TIMEOUT | Position open > 6 hours |

**Additional monitors:**
- SOL Floor Monitor: Force-sell if bonding curve SOL < 35 SOL (10s poll)
- Position Reconciler: Auto-close if wallet has 0 tokens but DB says OPEN (60s poll)

## Risk Parameters

| Parameter | Value |
|-----------|-------|
| Position size | $1.00 USD (fixed) |
| Take profit | +100,000% |
| Stop loss | -50% |
| Trailing activation | +200% from entry |
| Trailing stop | 30% drop from highest (dynamic tightening) |
| Scale-out | +100% → sell 50%, +300% → sell 20% |
| Timeout | 6 hours (21,600s) |
| Max concurrent | 1 position |
| Slippage | 500 bps (5%) |
| Max price impact | 700 bps (7%) |
| Daily kill switch | -$40 |
| Cooldown after exit | 10 seconds |
| Anti-rug single dump | > 10% of supply |
| Anti-rug cumulative dump | > 15% of top 20 holders |
| Anti-rug poll interval | 5 seconds |
| SOL floor | 35 SOL (force-sell threshold) |
| Priority fee | 350k micro-lamports/CU |
| Compute budget | 200k CU |

## Detection Parameters

| Parameter | Value |
|-----------|-------|
| Momentum min buys | 15 buys |
| Momentum window | 30 seconds |
| Momentum min volume | 10 SOL |
| Momentum cooldown | 60s per mint |
| Max tracked tokens | 500 |
| Sell pressure window | 60 seconds |
| Creator history window | 1 hour (3600s) |
| Max creator launches | 3 per window |
| Min token age | 1800s (30 min) |
| Max buy mcap | $20,000 |
| Max wallet concentration | 75% top 5 holders |
| Min SOL reserves | 0.1 SOL |
| Min holder count | 20 |
| Min avg buy size | 0.1 SOL |

## Execution Model

| Phase | Venue | Method |
|-------|-------|--------|
| **Entry (PumpFun)** | Pump.fun bonding curve | Official @pump-fun/pump-sdk |
| **Entry (BonkFun)** | Raydium LaunchLab | buy_exact_in instruction |
| **Exit (bonding)** | Pump.fun / BonkFun bonding curve | SDK + instruction |
| **Exit (graduated)** | Jupiter V6 | Swap API |

**Send pipeline:**
- SendCoordinator → KeypairSigner → RpcSender
- Retry: up to 2 attempts with 1s delay
- Jito bundles: DISABLED (not landing in blocks)

## Detectors (11)

| Detector | Type | Triggers Buy? |
|----------|------|---------------|
| LaunchDetector | New token CREATE events | Yes (entry gate) |
| MomentumDetector | Sliding window buy/volume | Yes (primary trigger) |
| BundleDetector | Cluster wallet detection | Yes (blocks if ≥ 40%) |
| WashTradeDetector | Artificial volume detection | Yes (blocks if score > 60) |
| MigrationDetector | Bonding curve graduation | No (analytics) |
| DexPaidDetector | DexScreener paid listing | No (analytics) |
| RevokeAnalyzer | Authority revoke detection | No (analytics) |
| SmartMoneyDetector | Known profitable wallets | Boost only |
| CabalDetector | Coordinated wallet groups | No (analytics) |
| ConcentrationAnalyzer | Top holder % analysis | No (analytics) |
| DayPhaseDetector | Market session detection | No (analytics) |

## Tech Stack

- **Runtime:** Node.js 20+ (TypeScript, strict mode)
- **Blockchain:** Solana (@solana/web3.js)
- **Protocol:** Pump.fun (@pump-fun/pump-sdk), BonkFun (Raydium LaunchLab)
- **DEX:** Jupiter V6 API
- **Database:** PostgreSQL 16
- **Cache:** Redis (ioredis, optional)
- **Transport:** WebSocket (Helius WSS)
- **Logging:** pino structured logger
- **Metrics:** prom-client (Prometheus)
- **Testing:** vitest

## Quick Start

```bash
# Install dependencies
npm install

# Start infrastructure
sudo service postgresql start
sudo service redis-server start

# Configure .env
cp .env.example .env
# Fill in: HELIUS_API_KEY, WALLET_SECRET_KEY, DATABASE_URL

# Build
npm run typecheck && npm test -- --run && npm run build

# Run
node dist/main.js

# Or use aliases (defined in ~/.bashrc)
start-bot    # Start in screen session 'bot'
stop-bot     # Stop bot
status-bot   # Check if running
restart-bot  # Restart
tail-bot     # Tail latest log file
sell <MINT>  # Force sell a position
```

## Project Structure

```
src/
  main.ts                              — Entry point

  core/
    config/env.ts                      — Environment variable helpers
    constants/
      defaults.ts                      — Re-exports from sub-modules
      defaults/
        trading.ts                     — TP/SL/trailing/position sizing/scale-out
        detection.ts                   — Momentum/creator/metadata/concentration
        infrastructure.ts              — RPC/DB/WS/compute budget
        risk.ts                        — Daily kill switch/cooldown/anti-rug
        jito.ts                        — Jito MEV settings (disabled)
      programs.ts                      — Solana program IDs
      timeouts.ts                      — Timeout constants
    interfaces/                        — IDetector, ISigner, IStorage, IStrategy
    state/positionRegistry.ts          — In-memory position tracking
    types/                             — Pure data shapes (execution, position, signal, trade, etc.)
    utils/                             — BoundedMap, LRU cache, price, serialization, time

  app/
    bootstrap.ts                       — 6-step startup sequence
    container.ts                       — DI container (~40 lazy singletons)
    dataProvider.ts                    — On-chain data fetching for 23 entry checks
    entryCheckEvaluator.ts             — Pure evaluation logic
    executionDelegate.ts               — Strategy → Execution facade
    lifecycle.ts                       — Graceful shutdown (SIGINT/SIGTERM)
    positionRecovery.ts                — Restore open positions from DB on restart
    positionReconciler.ts              — Sync DB positions with wallet balance (60s)
    solFloorMonitor.ts                 — Force-sell if BC SOL < 35 SOL (10s)
    solPriceOracle.ts                  — SOL/USD price (Jupiter → CoinGecko → fallback)
    venueDetector.ts                   — Detect PumpFun vs BonkFun vs Jupiter
    wsManager.ts                       — Auto-reconnecting WebSocket
    heliusHolderCount.ts               — Real holder count via Helius API
    realVolumeFetcher.ts               — Real 1h volume via DexScreener
    execution/
      buyExecutor.ts                   — Full buy flow
      sellExecutor.ts                  — Full sell flow
      bonkfunBuyExecutor.ts            — BonkFun-specific buy
      bonkfunSellExecutor.ts           — BonkFun-specific sell
      onChainAccounting.ts             — Parse confirmed TX for actual amounts
      pnlRecorder.ts                   — Record PnL + activate cooldown
      riskGuardRunner.ts               — Run all risk guards before buy
      tradeRecorder.ts                 — Save trade records to Postgres
      rentReclaimer.ts                 — Reclaim rent from empty token accounts

  strategies/filteredSniper/
    filteredSniperStrategy.ts          — Main strategy orchestrator
    filteredSniperRules.ts             — All 23 entry check constants (LOCKED)
    entryDecision.ts                   — Evaluate 23 entry checks
    exitDecision.ts                    — Evaluate exit conditions
    positionSizer.ts                   — Dynamic position sizing
    candleAnalyzer.ts                  — OHLC candle data for exit analysis
    compoundManager.ts                 — Profit compounding

  detectors/
    launch/launchDetector.ts           — New token CREATE events
    momentum/momentumDetector.ts       — Sliding window buy/volume tracking
    bundle/bundleDetector.ts           — Cluster wallet detection
    washTrade/washTradeDetector.ts     — Artificial volume detection
    lifecycle/migrationDetector.ts     — Bonding curve graduation
    dexPaid/dexPaidDetector.ts         — DexScreener paid listing
    revoke/revokeAnalyzer.ts           — Authority revoke detection
    smartMoney/smartMoneyDetector.ts   — Known profitable wallets
    cabal/cabalDetector.ts             — Coordinated wallet groups
    holderConcentration/concentrationAnalyzer.ts
    dayPhase/dayPhaseDetector.ts       — Market session detection

  risk/
    controls/
      antiRug.ts                       — Top 20 holder dump monitoring (5s poll)
      cooldownManager.ts               — Post-exit cooldown (10s)
      dailyLossGuard.ts                — $40 daily loss limit → kill switch
      emergencyKillSwitch.ts           — Global halt
      tradeThrottle.ts                 — Rate limit trades
    exposure/maxExposureGuard.ts       — Max concurrent positions
    blacklist/
      creatorBlacklist.ts              — Bad creator addresses (persisted)
      tokenBlacklist.ts                — Blacklisted token mints

  execution/
    tx/                                — TX builder, composer, compute budget, ATA, CU estimator
    sender/
      rpcSender.ts                     — Standard sendRawTransaction
      jitoSender.ts                    — Jito bundles (DISABLED)
      sendCoordinator.ts               — Coordinate sign + send + retry
    signing/keypairSigner.ts           — Keypair-based signer
    venues/
      pumpfunVenue.ts                  — PumpFun bonding curve swap
      bonkfunVenue.ts                  — BonkFun/LaunchLab swap
      jupiterVenue.ts                  — Jupiter aggregator swap
    lifecycle/tradeLifecycleManager.ts — Trade state machine
    multiWallet/walletDistributor.ts   — Multi-wallet distribution

  adapters/
    dex/
      jupiterProvider.ts               — Jupiter API quote/swap
      routingProvider.ts               — DEX routing
    protocols/
      pumpfun/
        pumpfunTradeBuilder.ts         — BUY/SELL instructions (PumpFun IDL)
        officialPumpSdk.ts             — @pump-fun/pump-sdk wrapper
        officialPumpfunQuote.ts        — Quote engine
        tokenParser.ts                 — Parse bonding curve + metadata
        launchParser.ts                — Parse launch events
        eventDecoder.ts                — Decode program events from logs
        authorityInspector.ts          — Check mint/freeze authority
        migrationDetector.ts           — Detect graduation
        shared.ts                      — PDA derivation helpers
      bonkfun/
        bonkfunTradeBuilder.ts         — BUY/SELL instructions (LaunchLab IDL)
        launchLabParser.ts             — Parse LaunchLab transactions
        tokenParser.ts                 — Parse pool state accounts
        shared.ts                      — PDA derivation helpers

  storage/
    postgres/postgresClient.ts         — pg.Pool + health check
    redis/redisClient.ts               — ioredis client (optional)
    repositories/
      tradeRepository.ts               — CRUD for trades table
      signalRepository.ts              — CRUD for signals table
      riskStateRepository.ts           — Key-value risk state
      creatorStatsRepository.ts        — Creator performance scores
    backfill/pnlBackfill.ts            — Backfill PnL for historical trades

  telemetry/
    logging/logger.ts                  — Pino logger factory
    metrics/
      httpServer.ts                    — Prometheus metrics HTTP server
      prometheus.ts                    — Custom Prometheus metrics
      ingestionMetrics.ts              — Ingestion pipeline metrics

  backtest/
    cli.ts                             — Backtest CLI
    replayEngine.ts                    — Replay recorded events
    eventRecorder.ts                   — Record raw events
    analytics.ts                       — Backtest analytics
```

## Database Schema

```sql
-- trades: All BUY/SELL records
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  side TEXT NOT NULL,        -- 'BUY' | 'SELL'
  status TEXT NOT NULL,      -- 'PENDING' | 'CONFIRMED' | 'FAILED'
  amount_sol NUMERIC,
  amount_tokens NUMERIC,
  signature TEXT,
  slot BIGINT,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- signals: All detector signals
CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,        -- 'LAUNCH' | 'MOMENTUM' | 'BUNDLE' | 'WASH_TRADE' | etc.
  mint TEXT,
  timestamp TIMESTAMPTZ,
  slot BIGINT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- risk_state: Key-value store for scale-out tiers, highest prices, etc.
CREATE TABLE risk_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- creator_stats: Creator performance scores
CREATE TABLE creator_stats (
  creator TEXT PRIMARY KEY,
  score NUMERIC,
  launches INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Environment Variables

```bash
# Required
HELIUS_API_KEY=<your-helius-api-key>
WALLET_SECRET_KEY=<base64-encoded-64-byte-secret-key>
DATABASE_URL=postgresql://pumpfun:***@localhost:5432/pumpfun

# Optional
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=<key>
PUBLICNODE_RPC_URL=https://solana-rpc.publicnode.com
ALCHEMY_API_KEY=<optional>
REDIS_URL=redis://localhost:6379
LOG_LEVEL=debug|info|warn|error
NODE_ENV=production
```

## Testing

```bash
npm run typecheck   # TypeScript strict mode, 0 errors
npm test -- --run   # vitest, all tests
npm run build       # Must pass before deploy
```

## Design Principles

- **Strict TypeScript** — `noUncheckedIndexedAccess`, no `any`
- **BigInt everywhere** — zero floating-point finance math
- **Layer isolation** — each layer only depends on layers below
- **Fail-closed** — missing data = reject, not accept
- **Single source of truth** — all config in `core/constants/defaults/`
- **Dependency injection** — explicit wiring via container
- **Token-2022 aware** — supports new Pump.fun mint standard
- **Security** — private keys never logged, never serialized
- **Resilient execution** — sell retry with exponential backoff

## License

Private — All rights reserved.
