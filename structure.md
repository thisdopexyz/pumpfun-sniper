# Project Structure

```
src/
├── main.ts                              # Bootstrap + WS wiring (~470 lines)
│
├── app/                                 # Orchestration & DI
│   ├── bootstrap.ts                     # Config loading + container creation
│   ├── container.ts                     # DI container (lazy singletons)
│   ├── lifecycle.ts                     # SIGINT/SIGTERM handlers
│   ├── dataProvider.ts                  # StrategyDataProvider (RPC fetch)
│   ├── entryCheckEvaluator.ts           # Raw data → boolean evaluation
│   ├── executionDelegate.ts             # StrategyExecutionDelegate facade
│   ├── solPriceOracle.ts                # SOL/USD price (Jupiter → CoinGecko → fallback)
│   ├── wsManager.ts                     # WebSocket with auto-reconnect
│   ├── positionRecovery.ts              # Startup DB recovery + live balance check
│   ├── positionReconciler.ts            # Periodic DB ↔ wallet position sync
│   ├── heliusHolderCount.ts             # Real holder count via Helius API (rate limited, cached)
│   ├── realVolumeFetcher.ts             # Real 1h volume via DexScreener (rate limited, cached)
│   └── execution/
│       ├── buyExecutor.ts               # BUY orchestration (quote → TX → confirm)
│       ├── sellExecutor.ts              # SELL orchestration (Pumpfun/Jupiter)
│       ├── riskGuardRunner.ts           # Risk guards check (shared)
│       ├── tradeRecorder.ts             # DB persistence (shared)
│       ├── pnlRecorder.ts               # P&L + risk state updates (shared)
│       ├── onChainAccounting.ts         # On-chain SOL accounting for P&L
│       ├── rentReclaimer.ts             # Close empty token accounts for rent
│       └── runtime.ts                   # ExecutionRuntime interface
│
├── core/                                # Pure types, constants, interfaces
│   ├── config/
│   │   └── env.ts                       # .env loader
│   ├── constants/
│   │   ├── defaults.ts                  # Barrel re-export → defaults/*
│   │   ├── defaults/
│   │   │   ├── trading.ts               # Position sizing, TP/SL, trailing, scale-out
│   │   │   ├── detection.ts             # Momentum, creator history, entry checks
│   │   │   ├── infrastructure.ts        # RPC, DB, WebSocket, compute budget, SOL price
│   │   │   ├── risk.ts                  # Daily kill switch, cooldown, anti-rug
│   │   │   └── jito.ts                  # Jito MEV tip
│   │   ├── programs.ts                  # Solana program IDs
│   │   └── timeouts.ts                  # RPC/shutdown timeouts
│   ├── errors/
│   │   └── rpc.error.ts                 # RpcError, RpcTimeoutError
│   ├── interfaces/
│   │   ├── detector.ts                  # IDetector, SignalHandler
│   │   ├── signer.ts                    # ISigner
│   │   ├── storage.ts                   # IRepository
│   │   └── strategy.ts                  # IStrategy
│   ├── state/
│   │   └── positionRegistry.ts          # Active positions (single source of truth)
│   ├── types/
│   │   ├── execution.ts                 # ExecutionVenue, SwapDirection, ComputeBudgetParams
│   │   ├── position.ts                  # Position, PositionStatus
│   │   ├── signal.ts                    # Signal union (12 signal types)
│   │   ├── strategy.ts                  # ExitReason, SkipReason
│   │   ├── telemetry.ts                 # LogLevel
│   │   ├── token.ts                     # MintAddress, TokenMetadata, BondingCurveState
│   │   ├── trade.ts                     # TradeRecord, TradeId
│   │   └── wallet.ts                    # WalletAddress, TokenAccount
│   └── utils/
│       ├── boundedMap.ts                # Generic bounded map with eviction
│       ├── dedupe.ts                    # Deduplication helpers
│       ├── lruCache.ts                  # LRU cache
│       ├── serialization.ts             # ID generation
│       ├── time.ts                      # nowMs(), elapsedMs()
│       └── unionFind.ts                 # Union-Find for wallet clustering
│
├── strategies/                          # Business logic (NO IO)
│   └── filteredSniper/
│       ├── filteredSniperStrategy.ts    # Main strategy class (entry + exit)
│       ├── filteredSniperRules.ts       # Re-exports from defaults.ts
│       ├── entryDecision.ts             # 18 entry checks evaluation
│       ├── exitDecision.ts              # TP/SL/timeout evaluation
│       ├── positionSizer.ts             # Dynamic position sizing by market cap
│       ├── candleAnalyzer.ts            # Candle data tracking
│       └── compoundManager.ts           # Profit compounding logic
│
├── detectors/                           # Signal detection
│   ├── launch/
│   │   └── launchDetector.ts            # WS launch event → LaunchSignal
│   ├── momentum/
│   │   └── momentumDetector.ts          # Buy count + volume → MomentumSignal
│   ├── lifecycle/
│   │   └── migrationDetector.ts         # Bonding curve → Raydium migration
│   ├── bundle/
│   │   └── bundleDetector.ts            # Clustered wallet buys → BundleSignal
│   ├── washTrade/
│   │   └── washTradeDetector.ts         # Wash trade patterns → WashTradeSignal
│   ├── holderConcentration/             # [REMOVED 2026-06-23 — dead code]
│   └── smartMoney/
│       └── smartMoneyDetector.ts        # Smart wallet activity → SmartMoneySignal
│
├── risk/                                # Risk guards & controls
│   ├── blacklist/
│   │   ├── creatorBlacklist.ts          # Creator wallet blacklist (BoundedMap)
│   │   └── tokenBlacklist.ts            # Token blacklist (BoundedMap)
│   ├── controls/
│   │   ├── emergencyKillSwitch.ts       # Global on/off
│   │   ├── dailyLossGuard.ts            # Daily loss limit
│   │   ├── cooldownManager.ts           # Cooldown after SL
│   │   ├── tradeThrottle.ts             # Rate limiting
│   │   └── antiRug.ts                   # Rug pull monitor
│   └── exposure/
│       └── maxExposureGuard.ts          # Max concurrent positions
│
├── execution/                           # TX infrastructure
│   ├── venues/
│   │   ├── pumpfunVenue.ts              # Pump.fun bonding curve swaps
│   │   └── jupiterVenue.ts              # Jupiter graduated token swaps
│   ├── tx/
│   │   ├── txBuilder.ts                 # Transaction assembly
│   │   ├── txComposer.ts                # Instruction composition
│   │   ├── ataBuilder.ts                # ATA creation (Token-2022 aware)
│   │   ├── computeBudgetBuilder.ts      # Priority fees
│   │   └── cuEstimator.ts               # Dynamic CU estimation (EMA)
│   ├── sender/
│   │   ├── sendCoordinator.ts           # Dedup + sign + send
│   │   └── rpcSender.ts                 # Raw RPC send
│   ├── signing/
│   │   └── keypairSigner.ts             # Wallet signing
│   ├── jito/
│   │   └── jitoClient.ts                # Jito bundle submission
│   ├── multiWallet/
│   │   └── walletDistributor.ts         # Multi-wallet distribution
│   └── lifecycle/
│       └── tradeLifecycleManager.ts     # Position state machine
│
├── adapters/                            # Protocol integration
│   ├── dex/
│   │   ├── jupiterProvider.ts           # Jupiter V6 API
│   │   └── routingProvider.ts           # IRoutingProvider interface
│   └── protocols/pumpfun/
│       ├── shared.ts                    # PDA derivation, borsh helpers
│       ├── tokenParser.ts               # Mint/bonding curve buffer parsing
│       ├── authorityInspector.ts        # Mint/freeze authority check
│       ├── eventDecoder.ts              # Pump.fun log event decoder
│       ├── launchParser.ts              # CREATE instruction parser
│       ├── migrationDetector.ts         # MIGRATION log detector (detectFromLogs only)
│       ├── pumpfunTradeBuilder.ts       # BUY/SELL instruction builder
│       ├── officialPumpSdk.ts           # @pump-fun/pump-sdk CJS wrapper
│       └── officialPumpfunQuote.ts      # SDK quote/fee math
│
├── ingestion/                           # Data ingestion
│   ├── wsMessageHandler.ts              # WS message parsing + routing
│   ├── pipeline/
│   │   ├── eventNormalizer.ts           # Raw events → NormalizedEvent
│   │   └── eventDispatcher.ts           # Event routing
│   └── rpc/
│       ├── rpcClient.ts                 # RPC client with rate limiting
│       ├── rpcPool.ts                   # Multi-endpoint pool
│       ├── rpcFailover.ts               # Failover logic
│       └── rateLimiter.ts               # Token bucket rate limiter
│
├── storage/                             # Persistence
│   ├── postgres/
│   │   └── postgresClient.ts            # PostgreSQL pool
│   ├── redis/
│   │   └── redisClient.ts               # Redis client
│   ├── repositories/
│   │   ├── tradeRepository.ts           # Trade CRUD
│   │   ├── signalRepository.ts          # Signal CRUD (12 signal types)
│   │   ├── creatorStatsRepository.ts    # Creator statistics
│   │   └── riskStateRepository.ts       # Risk state persistence
│   └── backfill/
│       └── pnlBackfill.ts               # On-chain P&L backfill script
│
├── telemetry/                           # Observability
│   ├── logging/
│   │   └── logger.ts                    # Structured logger (pino)
│   └── metrics/
│       ├── prometheus.ts                # Prometheus registry + counters
│       ├── httpServer.ts                # /metrics HTTP endpoint
│       └── ingestionMetrics.ts          # RPC/event metric wrappers
│
├── backtest/                            # Backtesting engine
│   ├── cli.ts                           # Backtest CLI entry point
│   ├── replayEngine.ts                  # Event replay engine
│   ├── eventRecorder.ts                 # Backtest event storage
│   └── analytics.ts                     # P&L analytics + reporting
│
└── tests/                               # Test suite (Vitest)
    ├── unit/
    │   ├── strategy/                    # Entry/exit decision tests
    │   ├── risk/                        # Risk guard tests
    │   ├── execution/                   # TX building tests
    │   ├── lifecycle/                   # Migration/lifecycle tests
    │   ├── detectors/                   # Detector tests
    │   └── *.test.ts                    # Misc unit tests
    └── integration/
        ├── pipelineIntegrationTest.ts   # Full pipeline harness
        └── pipelineIntegration.test.ts  # Pipeline E2E test
```

## Architecture Layers

| Layer | Directory | Responsibility | External Deps |
|---|---|---|---|
| **Core** | `core/` | Types, constants, interfaces, utils | None |
| **Strategy** | `strategies/` | Business logic (entry/exit) | None (pure) |
| **Detectors** | `detectors/` | Signal detection (12 detectors) | None (pure) |
| **Risk** | `risk/` | Risk guards & controls | None (pure) |
| **App** | `app/` | Orchestration, DI, wiring | All layers |
| **Execution** | `execution/` | TX building, sending | Solana |
| **Adapters** | `adapters/` | Protocol integration | Pump.fun, Jupiter |
| **Ingestion** | `ingestion/` | RPC, WebSocket | Solana RPC |
| **Storage** | `storage/` | PostgreSQL, Redis | pg, redis |
| **Telemetry** | `telemetry/` | Logging, metrics | pino, prom-client |

## Signal Types (12)

| Detector | Signal Type | Trigger |
|---|---|---|
| LaunchDetector | `LAUNCH` | New token creation on Pump.fun |
| MomentumDetector | `MOMENTUM` | Buy count + volume threshold |
| MigrationSignalDetector | `MIGRATION` | Bonding curve → Raydium graduation |
| BundleDetector | `BUNDLE` | Clustered wallet buys |
| WashTradeDetector | `WASH_TRADE` | Wash trade patterns |
| ConcentrationAnalyzer | `CONCENTRATION` | [REMOVED 2026-06-23 — dead code, Check 8 uses evaluateConcentration directly] |
| SmartMoneyDetector | `SMART_MONEY` | Smart wallet activity |
| (LiquidityPhase) | `LIQUIDITY_PHASE` | Bonding/graduated phase |

## Data Flow

```
WebSocket → wsMessageHandler → eventDecoder/launchParser
  → launchDetector → LAUNCH signal
  → momentumDetector → MOMENTUM signal
  → bundleDetector → BUNDLE signal
  → washTradeDetector → WASH_TRADE signal
  → ... (8 detectors total)
    → strategy.onSignal()
      → dataProvider.getEntryCheckData() [RPC fetch]
      → entryCheckEvaluator [boolean evaluation]
      → evaluateEntry() [18 checks]
        → ALL PASS → riskGuardRunner → buyExecutor → TX → chain
        → ANY FAIL → reject (log reason)

Exit monitoring (1s poll):
  → dataProvider.getPositionData() [RPC fetch]
  → evaluateExit() [TP/SL/trailing/timeout/scale-out]
    → TRIGGER → sellExecutor → TX → chain
```

## Key Files

- **Config source of truth**: `core/constants/defaults.ts` → `defaults/*.ts`
- **Entry rules**: `strategies/filteredSniper/entryDecision.ts` (18 checks)
- **Exit rules**: `strategies/filteredSniper/exitDecision.ts`
- **Entry check evaluation**: `app/entryCheckEvaluator.ts`
- **Data fetching**: `app/dataProvider.ts`
- **Risk guards**: `app/execution/riskGuardRunner.ts`
- **Bonding curve parsing**: `adapters/protocols/pumpfun/tokenParser.ts`
- **Authority checking**: `adapters/protocols/pumpfun/authorityInspector.ts`
- **Bounded map utility**: `core/utils/boundedMap.ts`
