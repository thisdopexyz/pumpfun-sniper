/**
 * main.ts — Application Entry Point
 *
 * This is THE entry point. Run with:
 *   Development:  npm run dev        (tsx src/main.ts)
 *   Production:   npm run build && node dist/main.js
 *
 * Startup flow:
 *   1. bootstrap() → ServiceContainer (config, infra, RPC)
 *   2. Wire strategy (FilteredSniperStrategy with data + execution providers)
 *   3. Register signal handlers (graceful shutdown)
 *   4. Connect WebSocket to Helius
 *   5. Subscribe to Pump.fun program logs
 *   6. Enter event loop: parse → detect → filter → decide → execute
 *
 * This file = orchestration ONLY. All business logic lives in the
 * respective layers (detectors, heuristics, strategy, execution).
 */

import { bootstrap } from './app/bootstrap.js';
import { setupLifecycle } from './app/lifecycle.js';
import { createDataProvider } from './app/dataProvider.js';
import { createExecutionDelegate } from './app/executionDelegate.js';
import { FilteredSniperStrategy } from './strategies/filteredSniper/filteredSniperStrategy.js';
import { PositionRegistry } from './core/state/positionRegistry.js';
import { LaunchDetector } from './detectors/launch/launchDetector.js';
import { MomentumDetector } from './detectors/momentum/momentumDetector.js';
import { MigrationSignalDetector } from './detectors/lifecycle/migrationDetector.js';
import { BundleDetector } from './detectors/bundle/bundleDetector.js';
import { WashTradeDetector } from './detectors/washTrade/washTradeDetector.js';
import { DexPaidDetector } from './detectors/dexPaid/dexPaidDetector.js';
import { RevokeAnalyzer } from './detectors/revoke/revokeAnalyzer.js';
import { AntiRugMonitor } from './risk/controls/antiRug.js';
import { SmartMoneyDetector } from './detectors/smartMoney/smartMoneyDetector.js';
import { CabalDetector } from './detectors/cabal/cabalDetector.js';
import { ConcentrationAnalyzer } from './detectors/holderConcentration/concentrationAnalyzer.js';
import { DayPhaseDetector } from './detectors/dayPhase/dayPhaseDetector.js';
import { CandleAnalyzer } from './strategies/filteredSniper/candleAnalyzer.js';
import { CompoundManager } from './strategies/filteredSniper/compoundManager.js';
import { EventDispatcher } from './ingestion/pipeline/eventDispatcher.js';
import { EventNormalizer } from './ingestion/pipeline/eventNormalizer.js';
import type { PositionProvider } from './risk/exposure/maxExposureGuard.js';
import { createLogger } from './telemetry/logging/logger.js';
import { startMetricsServer } from './telemetry/metrics/httpServer.js';
import { PUMPFUN_PROGRAM_ID, RAYDIUM_LAUNCHLAB_PROGRAM_ID } from './core/constants/programs.js';
import { nowMs } from './core/utils/time.js';
import { generateId } from './core/utils/serialization.js';
import { WsManager } from './app/wsManager.js';
import { restoreOpenPositionsFromDb, hasLiveTokenBalance } from './app/positionRecovery.js';
import { PositionReconciler } from './app/positionReconciler.js';
import { handleWsMessage } from './ingestion/wsMessageHandler.js';
import { reclaimAllEmptyAccounts } from './app/execution/rentReclaimer.js';
import { startSolFloorMonitor } from './app/solFloorMonitor.js';
import type { TradeRecord } from './core/types/trade.js';
import { EventRecorder } from './backtest/eventRecorder.js';
import {
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_SECONDS,
} from './strategies/filteredSniper/filteredSniperRules.js';
import { PublicKey } from '@solana/web3.js';

const logger = createLogger('main');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║       PUMPFUN SNIPER — STARTING          ║');
  logger.info('╚══════════════════════════════════════════╝');

  // Step 1: Bootstrap (config + container + infra)
  const container = await bootstrap();

  // Step 2: Wire strategy with data + execution providers
  logger.info('Wiring strategy...');
  const positionRegistry = new PositionRegistry();
  const executionDelegate = createExecutionDelegate(container, positionRegistry);
  // dataProvider + strategy created AFTER detectors (needs bundle/wash data)
  let dataProvider!: ReturnType<typeof createDataProvider>;
  let strategy!: FilteredSniperStrategy;
  const walletPublicKey = container.signer.getPublicKey();
  // Position recovery moved to after strategy creation (see below)

  // Wire Risk Guards
  container.dailyLossGuard.onKill((state) => {
    container.killSwitch.kill(
      `Daily loss limit breached: $${state.dailyPnlUsd.toFixed(2)}`,
      'daily-loss-guard',
    );
  });

  const positionProvider: PositionProvider = {
    getOpenPositionCount: async () => positionRegistry.getActiveCount(),
    getTotalExposureLamports: async () => {
      let total = 0n;
      for (const pos of positionRegistry.getActive()) {
        total += pos.entryPriceSol ?? 0n;
      }
      return total;
    },
  };
  container.setMaxExposurePositionProvider(positionProvider);
  logger.info('Risk guards wired (kill switch, daily loss, cooldown, throttle, exposure)');

  // Restore risk state from DB (survives restarts)
  await Promise.all([
    container.dailyLossGuard.restore(),
    container.cooldownManager.restore(),
    container.creatorBlacklist.restore(),
  ]);
  logger.info('Risk state restored from DB');

  // Step 2.5: Start Prometheus metrics server
  startMetricsServer();
  logger.info('Prometheus metrics server started');

  // Step 2.6: Reclaim rent from stale empty token accounts (fire-and-forget)
  const walletForReclaim = container.signer.getPublicKey();
  reclaimAllEmptyAccounts({
    connection: container.connection,
    owner: walletForReclaim,
    txBuilder: container.txBuilder,
    sendCoordinator: container.sendCoordinator,
  }).then((result) => {
    if (result.reclaimed > 0) {
      logger.info('Startup rent reclaim complete', {
        reclaimed: result.reclaimed,
        totalLamports: result.totalLamports.toString(),
        errors: result.errors.length,
      });
    }
  }).catch((err: unknown) => {
    logger.warn('Startup rent reclaim failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Step 3: Register signal handlers (graceful shutdown)
  setupLifecycle(container);
  logger.info('Lifecycle handlers registered');

  // Step 4: Initialize detection pipeline
  logger.info('Initializing detection pipeline...');
  const normalizer = new EventNormalizer();
  const dispatcher = new EventDispatcher();
  const launchDetector = new LaunchDetector();
  const momentumDetector = new MomentumDetector({
    windowSeconds: MOMENTUM_WINDOW_SECONDS,
    minBuyCount: MOMENTUM_MIN_BUYS,
    minVolumeLamports: MOMENTUM_MIN_VOLUME_LAMPORTS,
  });
  const migrationDetector = new MigrationSignalDetector();
  const bundleDetector = new BundleDetector({
    windowSeconds: 60,
    maxBundlePct: 30,
    minBuyCount: 5,
  });
  const washTradeDetector = new WashTradeDetector({
    windowSeconds: 30,
    minTradeCount: 10,
  });

  // New analytics-only detectors (Phase 3.3–5.3) — declared early for dataProvider
  const dexPaidDetector = new DexPaidDetector();
  const rpcClient = container.rpcPool.getBest()!;
  const revokeAnalyzer = new RevokeAnalyzer(rpcClient);
  const smartMoneyDetector = new SmartMoneyDetector();
  const cabalDetector = new CabalDetector();
  const concentrationAnalyzer = new ConcentrationAnalyzer();
  const dayPhaseDetector = new DayPhaseDetector();
  const candleAnalyzer = new CandleAnalyzer();
  const compoundManager = new CompoundManager();

  // Create dataProvider now that detectors exist (needs bundle + wash + smartMoney data)
  const antiRugMonitor = new AntiRugMonitor(container.connection);
  dataProvider = createDataProvider(container, positionRegistry, { bundleDetector, washTradeDetector, smartMoneyDetector }, antiRugMonitor);
  strategy = new FilteredSniperStrategy(dataProvider, executionDelegate, undefined, undefined, container.riskStateRepository, container.maxExposureGuard);
  container.setStrategy(strategy);

  // Load persisted scale-out tiers from DB
  await strategy.loadCompletedTiers();

  // Position recovery (AFTER strategy creation — needs strategy.monitorTrade)
  const recoveryResult = await restoreOpenPositionsFromDb({
    tradeRepository: container.tradeRepository,
    positionRegistry,
    monitorTrade: (tradeId: string, mint?: string) => strategy.monitorTrade(tradeId, mint),
    hasTokenBalance: (trade: TradeRecord) => hasLiveTokenBalance(container.connection, walletPublicKey, new PublicKey(trade.mint)),
  });
  logger.info('DB open-position recovery complete', {
    restored: recoveryResult.restored,
    skipped: recoveryResult.skipped,
  });

  // Wire detector signal handlers → strategy.onSignal() + save to DB
  launchDetector.onSignal((signal) => {
    logger.info('Launch signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').LaunchSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'LAUNCH' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, creator: s.creator ?? '', signature: s.signature ?? '',
    }).catch(() => {});
    strategy.onSignal(signal).catch((err: unknown) => {
      logger.error('Launch signal processing failed', {
        mint: signal.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Analytics: check dex paid timing after launch detection
    void dexPaidDetector.checkDexPaid(s.mint, s.timestamp ?? nowMs()).then((result) => {
      logger.info('DexPaid check after launch', {
        mint: s.mint,
        isPaid: result.isPaid,
        isLate: result.isLate,
        gapMinutes: result.gapMinutes.toFixed(1),
      });
    }).catch(() => {});
  });

  momentumDetector.onSignal((signal) => {
    logger.debug('Momentum signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').MomentumSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'MOMENTUM' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, buyCount: s.buyCount ?? 0,
      windowSeconds: s.windowSeconds ?? MOMENTUM_WINDOW_SECONDS, volumeSol: s.volumeSol ?? 0n,
    }).catch(() => {});
    strategy.onSignal(signal).catch((err: unknown) => {
      logger.error('Momentum signal processing failed', {
        mint: signal.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  migrationDetector.onSignal((signal) => {
    logger.info('Migration signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').MigrationSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'MIGRATION' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, migrationSignature: s.migrationSignature ?? '',
    }).catch(() => {});
  });

  bundleDetector.onSignal((signal) => {
    logger.info('Bundle signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').BundleSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'BUNDLE' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, bundlePct: s.bundlePct,
      clusteredWalletCount: s.clusteredWalletCount, totalBuyCount: s.totalBuyCount, windowMs: s.windowMs,
    }).catch(() => {});
    // Bundle signals don't trigger buys — they are logged for analytics
  });

  washTradeDetector.onSignal((signal) => {
    logger.info('Wash trade signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').WashTradeSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'WASH_TRADE' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, washScore: s.washScore, washReasons: s.washReasons,
    }).catch(() => {});
    // Wash trade signals don't trigger buys — they are logged for analytics
  });

  // Wire new analytics-only detectors — save signals to DB, don't trigger buys
  dexPaidDetector.onSignal((signal) => {
    logger.info('DexPaid signal detected', { mint: signal.mint });
    void container.signalRepository.save(signal).catch(() => {});
  });

  revokeAnalyzer.onSignal((signal) => {
    logger.info('Revoke signal detected', { mint: signal.mint });
    void container.signalRepository.save(signal).catch(() => {});
  });

  smartMoneyDetector.onSignal((signal) => {
    logger.info('SmartMoney signal detected', { mint: signal.mint });
    void container.signalRepository.save(signal).catch(() => {});
  });

  cabalDetector.onSignal((signal) => {
    logger.info('Cabal signal detected', { mint: signal.mint });
    void container.signalRepository.save(signal).catch(() => {});
  });

  concentrationAnalyzer.onSignal((signal) => {
    logger.info('Concentration signal detected', { mint: signal.mint });
    void container.signalRepository.save(signal).catch(() => {});
  });

  dayPhaseDetector.onSignal((signal) => {
    logger.info('DayPhase signal detected', { mint: signal.mint });
    void container.signalRepository.save(signal).catch(() => {});
  });

  // Register event dispatcher handlers → feed events to detectors
  dispatcher.on('launch', (event) => {
    launchDetector.handleLaunchEvent({
      mint: event.mint ?? '', creator: (event.data['creator'] as string) ?? '',
      name: (event.data['name'] as string) ?? '', symbol: (event.data['symbol'] as string) ?? '',
      uri: (event.data['uri'] as string) ?? '', slot: event.slot ?? 0,
      signature: (event.data['signature'] as string) ?? '', timestamp: event.receivedAt,
    });
  });

  dispatcher.on('trade', (event) => {
    const isBuy = (event.data['isBuy'] as boolean) ?? true;
    const solAmount = typeof event.data['solAmount'] === 'bigint' ? event.data['solAmount'] as bigint : BigInt((event.data['solAmount'] as string) ?? '0');
    const tokenAmount = typeof event.data['tokenAmount'] === 'bigint' ? event.data['tokenAmount'] as bigint : BigInt((event.data['tokenAmount'] as string) ?? '0');
    const slot = event.slot ?? 0;
    const timestamp = event.receivedAt;
    const wallet = (event.data[isBuy ? 'buyer' : 'seller'] as string) ?? undefined;
    const mint = event.mint ?? '';

    momentumDetector.handleTrade({
      mint, isBuy, solAmount, slot, timestamp, wallet,
    });

    // Feed buy events to bundle detector
    if (isBuy && wallet) {
      bundleDetector.handleBuy({ mint, wallet, tokenAmount, slot, timestamp });
    }

    // Feed all trade events to wash trade detector
    washTradeDetector.handleTrade({ mint, solAmount, slot, timestamp });

    // Feed trade events to smart money detector
    if (wallet) {
      smartMoneyDetector.recordTrade(mint, wallet, isBuy, timestamp);
    }

    // Feed buy events to cabal detector
    if (isBuy && wallet) {
      cabalDetector.recordTrade(mint, wallet, timestamp);
    }

    // Record candle data for exit analysis (approximate OHLC from individual trades)
    const priceApprox = Number(solAmount) / 1e9;
    candleAnalyzer.recordCandle(mint, {
      open: priceApprox, high: priceApprox, low: priceApprox, close: priceApprox,
      volume: priceApprox, timestamp,
    });
  });

  dispatcher.on('migration', (event) => {
    migrationDetector.handleTransaction({
      mint: event.mint ?? '', logs: (event.data['logs'] as readonly string[]) ?? [],
      slot: event.slot ?? 0, signature: (event.data['signature'] as string) ?? '',
    });
  });

  logger.info('Detection pipeline ready (launch + momentum + migration + bundle + washTrade + dexPaid + revoke + smartMoney + cabal + concentration + dayPhase + candleAnalyzer + compoundManager)');
  const cs = compoundManager.getCompoundStats();
  logger.info('Compound manager ready', { coldWalletPct: cs.coldWalletPct, tradingWalletPct: cs.tradingWalletPct });
  await launchDetector.start();
  await momentumDetector.start();
  await migrationDetector.start();
  await bundleDetector.start();
  await washTradeDetector.start();
  await dexPaidDetector.start();
  await revokeAnalyzer.start();
  await smartMoneyDetector.start();
  await cabalDetector.start();
  await concentrationAnalyzer.start();
  await dayPhaseDetector.start();

  // Step 4.5: Initialize EventRecorder for backtest replay
  const eventRecorder = new EventRecorder(container.pgPool);
  await eventRecorder.start();
  logger.info('Event recorder started (backtest)');

  // Record raw events in dispatcher handlers (after existing detector wiring)
  dispatcher.on('launch', (event) => {
    void eventRecorder.record({
      eventType: 'launch',
      mint: event.mint ?? null,
      slot: event.slot ?? null,
      timestamp: event.receivedAt,
      data: event.data,
    });
  });

  dispatcher.on('trade', (event) => {
    void eventRecorder.record({
      eventType: 'trade',
      mint: event.mint ?? null,
      slot: event.slot ?? null,
      timestamp: event.receivedAt,
      data: event.data,
    });
  });

  dispatcher.on('migration', (event) => {
    void eventRecorder.record({
      eventType: 'migration',
      mint: event.mint ?? null,
      slot: event.slot ?? null,
      timestamp: event.receivedAt,
      data: event.data,
    });
  });

  // Step 5: Start strategy before opening WebSocket so early signals are not ignored.
  strategy.start();

  // Step 5.5: Start position reconciler (syncs DB with wallet every 60s)
  const reconciler = new PositionReconciler({
    container,
    connection: container.connection,
    wallet: walletPublicKey,
    positionRegistry,
    tradeRepository: container.tradeRepository,
    monitorTrade: (tradeId: string, mint?: string) => strategy.monitorTrade(tradeId, mint),
    monitoredTrades: (strategy as any).monitoredTrades as Set<string>,
    cleanupMint: (tradeId: string, mint: string) => strategy.cleanupMint(tradeId, mint),
  });
  reconciler.start();

  // Step 5.6: SOL liquidity floor monitor (force sell if SOL in curve < 32)
  startSolFloorMonitor({
    container,
    positionRegistry,
    executeSell: executionDelegate.executeSell,
  });

  // Step 6: Connect WebSocket (using WsManager with auto-reconnect)
  logger.info('Connecting to Helius WebSocket...');
  const wsUrl = container.wsUrl;

  const wsManager = new WsManager({
    url: wsUrl,
    onOpen: () => {
      // Subscribe to Pump.fun program logs
      logger.info('Subscribing to pump.fun program logs...');
      wsManager.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMPFUN_PROGRAM_ID.toBase58()] }, { commitment: 'confirmed' }],
      }));
      logger.info('PumpFun subscription sent');
    },
    onMessage: (raw: Buffer) => {
      void handleWsMessage(raw.toString(), normalizer, dispatcher, container.connection, 'pumpfun');
    },
    onFatal: () => {
      logger.fatal('WebSocket connection lost permanently — shutting down');
      process.exit(1);
    },
  });

  // Separate WS connection for LaunchLab/BonkFun
  // Helius may silently drop a second logsSubscribe on the same connection
  const launchLabWsManager = new WsManager({
    url: wsUrl,
    onOpen: () => {
      logger.info('Subscribing to LaunchLab program logs (BonkFun) — separate connection...');
      launchLabWsManager.send(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'logsSubscribe',
        params: [{ mentions: [RAYDIUM_LAUNCHLAB_PROGRAM_ID.toBase58()] }, { commitment: 'confirmed' }],
      }));
      logger.info('LaunchLab subscription sent');
    },
    onMessage: (raw: Buffer) => {
      void handleWsMessage(raw.toString(), normalizer, dispatcher, container.connection, 'launchlab');
    },
    onFatal: () => {
      logger.error('LaunchLab WebSocket connection lost — will NOT shutdown, PumpFun still running');
    },
  });

  await Promise.all([wsManager.connect(), launchLabWsManager.connect()]);

  // Step 7: Strategy is already running before the WebSocket connection opens.

  const walletPubkey = container.signer.getPublicKey().toBase58();
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║       PUMPFUN SNIPER — LIVE              ║');
  logger.info('╚══════════════════════════════════════════╝');
  logger.info('Bot is now listening for new token launches', {
    wallet: walletPubkey, strategy: 'FilteredSniper',
    entryVenue: 'Pump.fun', exitVenues: 'Pump.fun (bonding) / Jupiter (graduated)', mode: 'LIVE',
  });

  // Keep alive — process stays running via WebSocket connection
  await new Promise<void>(() => {
    // Never resolves — process stays alive until signal received
    // LifecycleManager.shutdown() will call process.exit()
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.fatal('Fatal error in main', {
    error: msg,
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
