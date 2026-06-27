/**
 * Filtered Sniper Strategy
 *
 * The main strategy class that orchestrates:
 *   1. Entry evaluation (all 27 checks, soft-fail tolerance: 2)
 *   2. Position monitoring
 *   3. Exit evaluation (TP/SL/timeout)
 *
 * This is PURE BUSINESS LOGIC. It does NOT:
 *   - Make RPC calls
 *   - Query databases
 *   - Decode protocol data
 *   - Build transactions
 *
 * All external data is provided via interfaces (dependency injection).
 * All execution is delegated to the execution layer.
 *
 * Strategy = business logic ONLY.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { Signal } from '../../core/types/signal.js';
import type { EntryCheckData, EntryDecisionResult } from './entryDecision.js';
import type { PositionData, ExitReason } from './exitDecision.js';
import { evaluateEntry } from './entryDecision.js';
import { evaluateExit } from './exitDecision.js';
import {
  ENTRY_VENUE,
  MAX_CONCURRENT_POSITIONS,
  POSITION_SIZE_USD,
  SLIPPAGE_BPS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  SCALE_OUT_TIERS,
} from './filteredSniperRules.js';
import type { IStrategy } from '../../core/interfaces/strategy.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import type { DynamicPositionSizer } from './positionSizer.js';
import { DEFAULT_EXIT_MONITOR_POLL_MS } from '../../core/constants/defaults/infrastructure.js';
import type { RiskStateRepository } from '../../storage/repositories/riskStateRepository.js';
import type { MaxExposureGuard } from '../../risk/exposure/maxExposureGuard.js';
import { getHighestPricesForPersist, restoreHighestPrices, cleanupHighestPriceTracking } from '../../app/dataProvider.js';

const logger = createLogger('strategy:filteredSniper');

const EXPECTED_BUY_BLOCK_PATTERNS = [
  'cooldown active',
  'kill switch',
  'daily loss limit',
  'throttled',
  'max exposure',
] as const;

export function isExpectedBuyBlock(error: string | null): boolean {
  if (error === null) {
    return false;
  }

  const normalized = error.toLowerCase();
  return EXPECTED_BUY_BLOCK_PATTERNS.some((pattern) => normalized.includes(pattern));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data provider interface — strategy asks for data, doesn't fetch it. */
export interface StrategyDataProvider {
  /** Get entry check data for a detector signal. */
  getEntryCheckData(signal: Signal): Promise<EntryCheckData>;
  /** Get current position data for exit evaluation. */
  getPositionData(tradeId: string): Promise<PositionData | null>;
  /** Get current active position count. */
  getActivePositionCount(): number;
  /** Check if a token is blacklisted (e.g., after stop-loss exit). */
  isTokenBlacklisted(mint: string): boolean;
  /**
   * DB-backed source-of-truth check for in-flight positions.
   * Returns true if DB has any unmatched (open) BUY trade.
   * Used as defense in depth against in-memory state desync.
   */
  hasOpenPositionInDb(): Promise<boolean>;
  /** Start anti-rug monitoring for a mint (no-op if disabled). */
  startAntiRugMonitoring(mint: string): void;
  /** Stop anti-rug monitoring for a mint and clear triggered flag. */
  stopAntiRugMonitoring(mint: string): void;
  /** Start post-buy monitoring for a mint (volume drop + holder drop detection). */
  startPostBuyMonitoring(mint: string): void;
  /** Stop post-buy monitoring for a mint. */
  stopPostBuyMonitoring(mint: string): void;
  /** Transition a position to a new status in the registry. */
  transitionPosition(tradeId: string, to: string, reason: string): void;
}

/** Execution delegate — strategy tells what to do, doesn't do it. */
export interface StrategyExecutionDelegate {
  /** Execute a buy order. */
  executeBuy(params: BuyParams): Promise<BuyResult>;
  /** Execute a sell order. */
  executeSell(params: SellParams): Promise<SellResult>;
}

/** Buy parameters (strategy → execution layer). */
export interface BuyParams {
  readonly mint: MintAddress;
  readonly venue: typeof ENTRY_VENUE;
  readonly positionSizeUsd: number;
  readonly slippageBps: number;
  readonly entryDecision: EntryDecisionResult;
}

/** Buy result (execution layer → strategy). */
export interface BuyResult {
  readonly success: boolean;
  readonly tradeId: string | null;
  readonly signature: string | null;
  readonly error: string | null;
}

/** Sell parameters (strategy → execution layer). */
export interface SellParams {
  readonly tradeId: string;
  readonly mint: MintAddress;
  readonly reason: ExitReason;
  readonly slippageBps: number;
  /** Percentage of current token balance to sell (1-100). Default: 100 (full sell). */
  readonly sellPct?: number;
}

/** Sell result (execution layer → strategy). */
export interface SellResult {
  readonly success: boolean;
  readonly signature: string | null;
  readonly error: string | null;
}

/** Strategy state. */
type StrategyState = 'IDLE' | 'RUNNING' | 'STOPPED';

// ---------------------------------------------------------------------------
// FilteredSniperStrategy
// ---------------------------------------------------------------------------

export class FilteredSniperStrategy implements IStrategy {
  private readonly dataProvider: StrategyDataProvider;
  private readonly executionDelegate: StrategyExecutionDelegate;
  private readonly positionSizer: DynamicPositionSizer | null;
  private readonly maxExposureGuard: MaxExposureGuard | null;
  private state: StrategyState = 'IDLE';

  /** Active trade IDs being monitored for exit. */
  private readonly monitoredTrades = new Set<string>();

  /** Trade IDs with an exit execution currently in-flight. */
  private readonly exitingTrades = new Set<string>();

  /** Track completed scale-out tiers per trade (in-memory). */
  private readonly completedScaleOutTiers = new Map<string, Set<number>>();

  /** Active mints being held (prevents double-buy on restart or re-entry). */
  private readonly activeMints = new Set<string>();
  /** Trade ID → mint lookup (for cleanup when positionData is null). */
  private readonly tradeIdToMint = new Map<string, string>();
  /** Mints with a buy currently in-flight (prevents same-mint race condition). */
  private readonly pendingMints = new Set<string>();
  /** Number of buys currently in-flight (between capacity check and registration). */
  private pendingBuyCount = 0;
  /**
   * Mutex flag: true while a buy is being evaluated (from onSignal entry to
   * completion/failure). Prevents setInterval overlap in exit monitor from
   * allowing 2 concurrent buys past the capacity check.
   */
  private buySlotClaimed = false;
  /** Track consecutive sell failures per trade to prevent infinite retry. */
  private readonly sellFailureCounts = new Map<string, number>();
  /** Track stuck positions — skip N cycles before retrying sell. */
  private readonly stuckPositionSkipCounts = new Map<string, number>();
  /** Track timestamp (ms) of last sell attempt per trade. Enforce cooldown to avoid spam on 429. */
  private readonly lastSellAttemptAt = new Map<string, number>();
  /** Min ms between sell attempts for same trade. Prevents rapid-fire 429 spam. */
  private static readonly SELL_RETRY_COOLDOWN_MS = 30_000;
  /** After this many fails, exponential backoff up to SELL_RETRY_COOLDOWN_MAX_MS. */
  private static readonly MAX_SELL_FAILURES = 3;
  /** After MAX_SELL_FAILURES, wait this many cycles before retrying (exponential backoff). */
  private static readonly STUCK_POSITION_BACKOFF_MULTIPLIER = 3;
  /** Hard cap on consecutive sell failures before marking trade STUCK (manual intervention). */
  private static readonly STUCK_TRADE_FAIL_THRESHOLD = 10;

  /**
   * Signal queue for when all position slots are full.
   * Instead of dropping signals, we queue them and process when a slot opens.
   * This prevents missing good tokens while holding existing positions.
   */
  private readonly signalQueue = new Map<string, { signal: Signal; queuedAt: number }>();
  private static readonly SIGNAL_QUEUE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly SIGNAL_QUEUE_MAX_SIZE = 10;

  /** Risk state repo for persisting scale-out tiers across restarts. */
  private readonly riskStateRepo: RiskStateRepository | null;

  /** Exit monitoring interval handle. */
  private monitorIntervalHandle: ReturnType<typeof setInterval> | null = null;
  /** Prevents setInterval callback overlap — if previous tick is still running, skip. */
  private monitorRunning = false;

  /** Exit monitor poll interval in ms. */
  private readonly monitorPollMs: number;

  constructor(
    dataProvider: StrategyDataProvider,
    executionDelegate: StrategyExecutionDelegate,
    positionSizer?: DynamicPositionSizer,
    monitorPollMs: number = DEFAULT_EXIT_MONITOR_POLL_MS,
    riskStateRepo?: RiskStateRepository,
    maxExposureGuard?: MaxExposureGuard,
  ) {
    this.dataProvider = dataProvider;
    this.executionDelegate = executionDelegate;
    this.positionSizer = positionSizer ?? null;
    this.monitorPollMs = monitorPollMs;
    this.riskStateRepo = riskStateRepo ?? null;
    this.maxExposureGuard = maxExposureGuard ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the strategy. Begins exit monitoring loop.
   */
  start(): void {
    if (this.state === 'RUNNING') {
      logger.warn('Strategy already running');
      return;
    }

    this.state = 'RUNNING';
    this.startExitMonitor();
    logger.info('Filtered sniper strategy started');
  }

  /**
   * Stop the strategy. Stops exit monitoring.
   */
  stop(): void {
    this.state = 'STOPPED';
    this.stopExitMonitor();
    logger.info('Filtered sniper strategy stopped');
  }

  /**
   * Get current strategy state.
   */
  getState(): StrategyState {
    return this.state;
  }

  /**
   * Add an already-confirmed/open trade to exit monitoring.
   * Used for startup DB recovery after a bot restart.
   */
  monitorTrade(tradeId: string, mint?: string): void {
    this.monitoredTrades.add(tradeId);
    if (mint) {
      this.activeMints.add(mint);
      this.tradeIdToMint.set(tradeId, mint);
    }
    logger.info('Trade added to exit monitor', { tradeId, mint });
  }

  /**
   * Clean up strategy-level state for a mint.
   * Called by reconciler when a manual sell is detected.
   */
  cleanupMint(tradeId: string, mint: string): void {
    this.activeMints.delete(mint);
    this.tradeIdToMint.delete(tradeId);
    this.completedScaleOutTiers.delete(tradeId);
    this.sellFailureCounts.delete(tradeId);
    this.stuckPositionSkipCounts.delete(tradeId);
    this.dataProvider.stopAntiRugMonitoring(mint);
    this.dataProvider.stopPostBuyMonitoring(mint);
    cleanupHighestPriceTracking(tradeId);
    void this.persistCompletedTiers();
    logger.info('Strategy cleanup after reconciled exit', { tradeId, mint });
  }

  /**
   * Restore completed scale-out tiers for a trade from persisted state.
   * Called during position recovery after bot restart.
   */
  restoreCompletedTiers(tradeId: string, tiers: number[]): void {
    if (tiers.length > 0) {
      this.completedScaleOutTiers.set(tradeId, new Set(tiers));
      logger.info('Restored completed scale-out tiers', { tradeId, tiers });
    }
  }

  /**
   * Persist completed scale-out tiers to risk_state table.
   * Survives bot restarts.
   */
  private async persistCompletedTiers(): Promise<void> {
    if (!this.riskStateRepo) return;
    try {
      const data: Record<string, number[]> = {};
      for (const [tradeId, tiers] of this.completedScaleOutTiers) {
        if (tiers.size > 0) {
          data[tradeId] = [...tiers];
        }
      }
      await this.riskStateRepo.saveState('scale_out_tiers', data);

      // Persist max positions bonus (from tier 0 completions)
      if (this.maxExposureGuard) {
        await this.riskStateRepo.saveState('max_positions_bonus', {
          maxPositions: this.maxExposureGuard.maxConcurrentPositions,
        });
      }

      // Persist highest prices (for trailing stop across restarts)
      const highestPrices = getHighestPricesForPersist();
      if (Object.keys(highestPrices).length > 0) {
        await this.riskStateRepo.saveState('highest_prices', highestPrices);
      }
    } catch (err: unknown) {
      logger.warn('Failed to persist scale-out tiers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load completed scale-out tiers from risk_state table.
   * Called on startup.
   */
  async loadCompletedTiers(): Promise<void> {
    if (!this.riskStateRepo) return;
    try {
      const data = await this.riskStateRepo.loadState<Record<string, number[]>>('scale_out_tiers');
      if (data) {
        for (const [tradeId, tiers] of Object.entries(data)) {
          this.completedScaleOutTiers.set(tradeId, new Set(tiers));
        }
        logger.info('Loaded completed scale-out tiers from DB', {
          tradeCount: Object.keys(data).length,
        });
      }

      // Restore max positions bonus from persisted state
      if (this.maxExposureGuard) {
        const bonus = await this.riskStateRepo.loadState<{ maxPositions: number }>('max_positions_bonus');
        if (bonus?.maxPositions) {
          this.maxExposureGuard.setMaxPositions(bonus.maxPositions);
          logger.info('Restored max positions from DB', { maxPositions: bonus.maxPositions });
        }
      }

      // Restore highest prices for trailing stop across restarts
      const highestPrices = await this.riskStateRepo.loadState<Record<string, string>>('highest_prices');
      if (highestPrices && Object.keys(highestPrices).length > 0) {
        restoreHighestPrices(highestPrices);
        logger.info('Restored highest prices from DB', { count: Object.keys(highestPrices).length });
      }
    } catch (err: unknown) {
      logger.warn('Failed to load scale-out tiers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Entry Flow
  // -------------------------------------------------------------------------

  /**
   * Handle a new token signal (launch detected + momentum).
   *
   * Flow:
   *   1. Check if strategy is running
   *   2. Check if we have capacity (max concurrent positions)
   *   3. Fetch entry check data from provider
   *   4. Evaluate all 27 entry checks
   *   5. If allowed (within soft-fail tolerance) → execute buy
   *   6. If rejected → log reason
   */
  async onSignal(signal: Signal): Promise<EntryDecisionResult | null> {
    const mint = signal.mint;

    logger.debug('onSignal called', { mint, signalType: signal.type, state: this.state });

    // Guard: strategy must be running
    if (this.state !== 'RUNNING') {
      logger.info('Signal ignored: strategy not running', { mint, signalType: signal.type, state: this.state });
      return null;
    }

    // Guard: BUY entries are momentum-triggered only. Launch signals seed
    // provenance/history; migration signals are exit/liquidity lifecycle data.
    if (signal.type !== 'MOMENTUM') {
      logger.debug('Signal ignored: not a momentum entry signal', {
        mint,
        signalType: signal.type,
      });
      return null;
    }

    // Guard (DEFENSE IN DEPTH): DB-backed open-position check.
    // The in-memory `positionRegistry` is a cache; if it desyncs (e.g. after
    // an ungraceful restart, missed transition, or partial state update),
    // `getActivePositionCount()` can under-report. DB is authoritative.
    // If DB shows an open position, block regardless of in-memory state.
    if (await this.dataProvider.hasOpenPositionInDb()) {
      logger.warn('Signal blocked by DB open-position check (defense in depth)', {
        mint,
        inMemoryActive: this.dataProvider.getActivePositionCount(),
      });
      // Queue for after the open position closes — same as capacity check below
      if (!this.signalQueue.has(mint) && this.signalQueue.size < FilteredSniperStrategy.SIGNAL_QUEUE_MAX_SIZE) {
        this.signalQueue.set(mint, { signal, queuedAt: nowMs() });
        logger.info('Signal queued (DB has open position)', { mint });
      }
      return null;
    }

    // Guard: check capacity (includes in-flight buys to prevent race condition)
    const activeCount = this.dataProvider.getActivePositionCount();
    const totalCount = activeCount + this.pendingBuyCount;
    const effectiveMax = this.maxExposureGuard?.maxConcurrentPositions ?? MAX_CONCURRENT_POSITIONS;
    if (totalCount >= effectiveMax || this.buySlotClaimed) {
      // Instead of dropping the signal, queue it for when a slot opens.
      // This prevents missing good tokens while holding existing positions.
      if (!this.signalQueue.has(mint) && this.signalQueue.size < FilteredSniperStrategy.SIGNAL_QUEUE_MAX_SIZE) {
        this.signalQueue.set(mint, { signal, queuedAt: nowMs() });
        logger.info('Signal queued (slots full)', {
          mint,
          activeCount,
          pendingBuys: this.pendingBuyCount,
          max: effectiveMax,
          queueSize: this.signalQueue.size,
        });
      }
      return null;
    }

    // Guard: check if we already hold this mint (prevents double-buy on restart)
    if (this.activeMints.has(mint)) {
      logger.debug('Signal ignored: already holding this mint', { mint });
      return null;
    }

    // Guard: check if this mint already has a buy in-flight (prevents same-mint race condition)
    if (this.pendingMints.has(mint)) {
      logger.debug('Signal ignored: buy already in-flight for this mint', { mint });
      return null;
    }

    // Guard: check if token is blacklisted (e.g., after stop-loss exit)
    if (this.dataProvider.isTokenBlacklisted(mint)) {
      logger.info('Signal ignored: token is blacklisted', { mint });
      return { allowed: false, passedCount: 0, failedCount: 1, firstFailure: 'Token blacklisted (stop-loss)', checks: [] };
    }

    // Reserve slot — increment BEFORE any async to prevent race condition
    // where multiple signals pass capacity check before any buy registers.
    this.pendingBuyCount += 1;
    this.buySlotClaimed = true;
    this.pendingMints.add(mint);

    try {
      // Safety-net timeout: getEntryCheckData has per-fetch timeouts inside
      // (rpcFailover, pump.fun API, DB), but if a fetch races past its
      // own AbortSignal or a new code path is added without a timeout, the
      // outer await could hang indefinitely. That would leak the slot
      // reservation (pendingBuyCount never decrements) and freeze all
      // subsequent signals behind it in the queue. Cap total time at
      // 20s — sum of worst-case path is 8s (mintAccount) + 6s (parallel
      // fetches via Promise.allSettled) + 3-6s for sequential post-fetch
      // awaits. 20s gives 1.5x headroom for a transient slow node.
      const ENTRY_CHECK_TOTAL_TIMEOUT_MS = 20_000;
      let checkData: Awaited<ReturnType<typeof this.dataProvider.getEntryCheckData>>;
      try {
        checkData = await Promise.race([
          this.dataProvider.getEntryCheckData(signal),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`getEntryCheckData total timeout after ${ENTRY_CHECK_TOTAL_TIMEOUT_MS}ms`)),
              ENTRY_CHECK_TOTAL_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (fetchErr: unknown) {
        // Fetch-layer failure (timeout, RPC error, etc.) — log explicitly
        // so a hung data provider is visible in logs, release the slot
        // HERE (not via outer catch — we return cleanly without throwing
        // to keep this an expected, handled failure rather than an
        // unhandled exception in the caller), and skip this signal.
        logger.error('Entry check fetch failed — releasing slot', {
          mint,
          error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        });
        this.pendingBuyCount -= 1;
        this.buySlotClaimed = false;
        this.pendingMints.delete(mint);
        return {
          allowed: false,
          passedCount: 0,
          failedCount: 1,
          firstFailure: `entry check fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          checks: [],
        };
      }

      // Evaluate all 27 checks
      const decision = evaluateEntry(checkData);

      if (!decision.allowed) {
        logger.info('Token rejected by entry checks', {
          mint,
          passedCount: decision.passedCount,
          failedCount: decision.failedCount,
          firstFailure: decision.firstFailure,
        });
        this.pendingBuyCount -= 1;
        this.buySlotClaimed = false;
        this.pendingMints.delete(mint);
        return decision;
      }

      // ALL CHECKS PASSED — execute buy
      // Calculate dynamic position size if sizer available
      let positionSizeUsd: number = POSITION_SIZE_USD;
      if (this.positionSizer !== null) {
        positionSizeUsd = this.positionSizer.calculateSize({
          momentumVolumeLamports: checkData.volumeLamports,
          momentumMinVolumeLamports: MOMENTUM_MIN_VOLUME_LAMPORTS,
          creatorScore: checkData.creatorScore ?? null,
          secondsSinceLaunch: checkData.secondsSinceLaunch ?? 0,
          marketCapUsd: checkData.marketCapUsd ?? null,
        });
        const mcapTier = this.positionSizer.getTier(checkData.marketCapUsd ?? null);
        logger.info('Dynamic position size calculated', {
          mint,
          positionSizeUsd,
          marketCapTier: mcapTier,
          marketCapUsd: checkData.marketCapUsd,
        });
      }

      logger.info('ALL entry checks passed — executing buy', {
        mint,
        passedCount: decision.passedCount,
        positionSizeUsd,
      });

      const buyResult = await this.executionDelegate.executeBuy({
        mint,
        venue: ENTRY_VENUE,
        positionSizeUsd,
        slippageBps: SLIPPAGE_BPS,
        entryDecision: decision,
      });

      if (buyResult.success && buyResult.tradeId !== null) {
        this.monitoredTrades.add(buyResult.tradeId);
        this.activeMints.add(mint);
        this.tradeIdToMint.set(buyResult.tradeId, mint);
        this.pendingBuyCount -= 1;
        this.buySlotClaimed = false; // Position now tracked by registry (activeCount)
        this.pendingMints.delete(mint);
        // Start anti-rug monitoring for this mint
        this.dataProvider.startAntiRugMonitoring(mint);
        this.dataProvider.startPostBuyMonitoring(mint);
        logger.info('Buy executed, monitoring for exit', {
          mint,
          tradeId: buyResult.tradeId,
          signature: buyResult.signature,
        });
      } else {
        // Buy failed — release reserved slot
        this.pendingBuyCount -= 1;
        this.buySlotClaimed = false;
        this.pendingMints.delete(mint);
        if (isExpectedBuyBlock(buyResult.error)) {
          logger.warn('Buy skipped by risk guard', {
            mint,
            error: buyResult.error,
          });
        } else {
          logger.error('Buy execution failed', {
            mint,
            error: buyResult.error,
          });
        }
      }

      return decision;
    } catch (err: unknown) {
      // Unexpected error — release reserved slot
      this.pendingBuyCount -= 1;
        this.buySlotClaimed = false;
      this.pendingMints.delete(mint);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Exit Flow
  // -------------------------------------------------------------------------

  /**
   * Evaluate exit for a single trade.
   */
  private async evaluateTradeExit(tradeId: string): Promise<void> {
    if (this.exitingTrades.has(tradeId)) {
      logger.debug('Exit evaluation skipped: sell already in-flight', { tradeId });
      return;
    }

    const positionData = await this.dataProvider.getPositionData(tradeId);
    if (positionData === null) {
      // Trade no longer exists — remove from monitoring
      this.monitoredTrades.delete(tradeId);
      this.completedScaleOutTiers.delete(tradeId);
      this.sellFailureCounts.delete(tradeId);
      this.stuckPositionSkipCounts.delete(tradeId);
      // Clean up activeMints using tradeId→mint lookup
      const mint = this.tradeIdToMint.get(tradeId);
      if (mint) {
        this.activeMints.delete(mint);
        this.tradeIdToMint.delete(tradeId);
        this.dataProvider.stopAntiRugMonitoring(mint);
        this.dataProvider.stopPostBuyMonitoring(mint);
    this.dataProvider.stopPostBuyMonitoring(mint);
        logger.info('Position no longer exists — cleaned up mint', { tradeId, mint });
      } else {
        logger.info('Position no longer exists — removed from monitoring', { tradeId });
      }
      void this.persistCompletedTiers(); // Cleanup persisted state
      return;
    }

    // Merge strategy-level scale-out tracking into position data
    const completedTiers = this.completedScaleOutTiers.get(tradeId);
    const mergedPositionData = completedTiers && completedTiers.size > 0
      ? { ...positionData, scaleOutTiersCompleted: [...completedTiers] }
      : positionData;

    const exitDecision = evaluateExit(mergedPositionData);

    if (exitDecision.shouldExit && exitDecision.reason !== null) {
      logger.info('Exit triggered', {
        tradeId,
        mint: positionData.mint,
        reason: exitDecision.reason,
        pnlPercent: exitDecision.pnlPercent.toFixed(2),
        elapsedMs: exitDecision.elapsedMs,
      });

      // Cooldown: skip if we just attempted sell for this trade within cooldown window.
      // Prevents 429 spam — bot would otherwise retry every 1s and get rate-limited.
      const lastAttempt = this.lastSellAttemptAt.get(tradeId);
      const now = nowMs();
      if (lastAttempt !== undefined && now - lastAttempt < FilteredSniperStrategy.SELL_RETRY_COOLDOWN_MS) {
        const waitSec = Math.ceil((FilteredSniperStrategy.SELL_RETRY_COOLDOWN_MS - (now - lastAttempt)) / 1000);
        logger.debug('Sell cooldown active — skipping this cycle', {
          tradeId,
          mint: positionData.mint,
          waitSec,
          reason: exitDecision.reason,
        });
        this.monitoredTrades.add(tradeId);
        return;
      }

      // Remove from monitoring BEFORE executing to prevent double-exit.
      // Also mark in-flight because setInterval callbacks may overlap when an
      // earlier sell is still waiting for chain confirmation.
      this.monitoredTrades.delete(tradeId);
      this.exitingTrades.add(tradeId);
      this.lastSellAttemptAt.set(tradeId, now);

      let sellResult;
      try {
        // Hard timeout: if executeSell hangs (e.g. RPC connection dead, no response),
        // reject after 60s so the strategy's failure counter increments and the
        // cooldown/backoff kicks in. Without this, a hung RPC could leave a
        // position "stuck" forever with no log entry.
        const SELL_HARD_TIMEOUT_MS = 60_000;
        const sellPromise = this.executionDelegate.executeSell({
          tradeId,
          mint: positionData.mint,
          reason: exitDecision.reason,
          slippageBps: SLIPPAGE_BPS,
          sellPct: exitDecision.sellPct,
        });
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`SELL TIMEOUT after ${SELL_HARD_TIMEOUT_MS}ms`));
          }, SELL_HARD_TIMEOUT_MS);
        });
        sellResult = await Promise.race([sellPromise, timeoutPromise]);
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      } catch (sellErr: unknown) {
        const msg = sellErr instanceof Error ? sellErr.message : String(sellErr);
        logger.error('SELL execution threw exception or timed out', {
          tradeId,
          mint: positionData.mint,
          error: msg,
        });
        sellResult = { success: false, signature: null, error: msg };
      } finally {
        this.exitingTrades.delete(tradeId);
      }

      if (sellResult.success) {
        // For SCALE_OUT: record completed tier and re-add to monitoring
        if (exitDecision.reason === 'SCALE_OUT') {
          // Record which tier was just sold so evaluateExit skips it next poll
          const tierIndex = exitDecision.tierIndex ?? -1;
          let completed = this.completedScaleOutTiers.get(tradeId) ?? new Set<number>();
          if (tierIndex >= 0) {
            completed.add(tierIndex);
            this.completedScaleOutTiers.set(tradeId, completed);
            this.sellFailureCounts.delete(tradeId); // Reset failures — fresh start for next tier
            this.lastSellAttemptAt.delete(tradeId); // Reset cooldown on success
            await this.persistCompletedTiers(); // MUST await — crash safety for tier recovery

            // After tier 0 (+100% sell 50%): unlock +1 concurrent position
            // Capital is now freer — we've recouped half the position
            if (tierIndex === 0 && this.maxExposureGuard) {
              this.maxExposureGuard.addMaxPositions(1);
              logger.info('Tier 0 complete — unlocked +1 max position', {
                tradeId,
                newMax: this.maxExposureGuard.maxConcurrentPositions,
              });
            }
          }

          // Check if ALL tiers are completed
          const tiersNeeded = SCALE_OUT_TIERS.length;
          if (completed && completed.size >= tiersNeeded) {
            // All scale-out tiers done — but DON'T mark as full exit yet!
            // 30% of position still rides with trailing stop / SL / TP.
            // (50% sold at tier 0, 20% at tier 1, remaining 30%)
            // Keep monitoring so trailing stop can lock remaining profits.
            this.dataProvider.transitionPosition(tradeId, 'SCALE_OUT_PARTIAL', 'SCALE_OUT_ALL_TIERS');
            this.monitoredTrades.add(tradeId);
            logger.info('All scale-out tiers complete — remaining position rides trailing stop', {
              tradeId,
              remainingPct: '40%',
              completedTiers: completed.size,
              totalTiers: tiersNeeded,
            });
          } else {
            // More tiers remaining — keep monitoring but mark as partially exited
            // This BLOCKS getActivePositionCount() from opening new buys
            this.dataProvider.transitionPosition(tradeId, 'SCALE_OUT_PARTIAL', 'SCALE_OUT_PARTIAL');
            this.monitoredTrades.add(tradeId);
            logger.info('Scale-out partial sell complete, re-monitoring for next tier', {
              tradeId,
              sellPct: exitDecision.sellPct,
              tierIndex,
              completedTiers: completed?.size ?? 0,
              totalTiers: tiersNeeded,
            });
          }
        } else {
          // Full exit — remove mint from active tracking
          this.activeMints.delete(positionData.mint);
          this.tradeIdToMint.delete(tradeId);
          // Stop anti-rug monitoring and clear triggered flag
          this.dataProvider.stopAntiRugMonitoring(positionData.mint);
          this.dataProvider.stopPostBuyMonitoring(positionData.mint);
          // Check if this position had tier 0 BEFORE deleting (needed for max positions reclaim)
          const hadTier0 = this.completedScaleOutTiers.get(tradeId)?.has(0) ?? false;
          this.completedScaleOutTiers.delete(tradeId);
          this.sellFailureCounts.delete(tradeId);
          this.stuckPositionSkipCounts.delete(tradeId);
          void this.persistCompletedTiers(); // Cleanup persisted state

          // Reclaim +1 max position ONLY if tier 0 was actually completed
          if (hadTier0 && this.maxExposureGuard) {
            this.maxExposureGuard.removeMaxPositions(1);
            logger.info('Full exit — reclaimed +1 max position (tier 0 was completed)', {
              tradeId,
              newMax: this.maxExposureGuard.maxConcurrentPositions,
            });
          }

          logger.info('Exit executed successfully', {
            tradeId,
            reason: exitDecision.reason,
            signature: sellResult.signature,
          });
        }
      } else {
        const failCount = (this.sellFailureCounts.get(tradeId) ?? 0) + 1;
        this.sellFailureCounts.set(tradeId, failCount);

        // HARD CAP: if a single trade has failed to sell 10 times consecutively,
        // mark it STUCK and stop trying. User must intervene manually.
        // Without this, a chain of 429s + bad RPCs would loop forever.
        if (failCount >= FilteredSniperStrategy.STUCK_TRADE_FAIL_THRESHOLD) {
          this.stuckPositionSkipCounts.delete(tradeId);
          this.completedScaleOutTiers.delete(tradeId);
          this.sellFailureCounts.delete(tradeId);
          this.lastSellAttemptAt.delete(tradeId);
          try {
            this.dataProvider.transitionPosition(tradeId, 'STUCK', 'SELL_STUCK_MANUAL_REQUIRED');
          } catch {
            // transition may be invalid for current state — log but don't crash
          }
          this.activeMints.delete(positionData.mint);
          this.tradeIdToMint.delete(tradeId);
          this.dataProvider.stopAntiRugMonitoring(positionData.mint);
          this.dataProvider.stopPostBuyMonitoring(positionData.mint);
          logger.error('SELL STUCK — manual intervention required, bot giving up on this trade', {
            tradeId,
            mint: positionData.mint,
            consecutiveFailures: failCount,
            lastError: sellResult.error,
            action: 'MANUAL_SELL_REQUIRED',
          });
          return;
        }

        if (failCount >= FilteredSniperStrategy.MAX_SELL_FAILURES) {
          // Don't give up! Keep position in monitoring with exponential backoff.
          // Token is still in wallet — must keep trying to sell.
          // Backoff is in MONITOR POLLS (1s each). Combined with SELL_RETRY_COOLDOWN_MS
          // (30s), the effective rate-limit on retry is ~30s.
          const backoffCycles = Math.min(
            failCount * FilteredSniperStrategy.STUCK_POSITION_BACKOFF_MULTIPLIER,
            60, // max 60 cycles (~60s) backoff
          );
          this.stuckPositionSkipCounts.set(tradeId, backoffCycles);
          this.monitoredTrades.add(tradeId);
          logger.warn('SELL FAILED — stuck position, will retry with backoff', {
            tradeId,
            mint: positionData.mint,
            consecutiveFailures: failCount,
            backoffCycles,
            lastError: sellResult.error,
          });
        } else {
          // Cooldown (30s) is the primary rate-limit guard for fails 1-2.
          // Re-add to monitor and let cooldown block rapid re-fire.
          logger.error('Exit execution failed — re-adding to monitor (cooldown will gate retry)', {
            tradeId,
            error: sellResult.error,
            consecutiveFailures: failCount,
            maxFailures: FilteredSniperStrategy.MAX_SELL_FAILURES,
          });
          this.monitoredTrades.add(tradeId);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Exit Monitor
  // -------------------------------------------------------------------------

  private startExitMonitor(): void {
    this.monitorIntervalHandle = setInterval(async () => {
      try {
        if (this.state !== 'RUNNING') return;
        if (this.monitorRunning) return; // Skip if previous tick still running
        this.monitorRunning = true;

        // Process queued signals if a slot is available
        await this.processSignalQueue();

        if (this.monitoredTrades.size === 0) return;

        // Evaluate each trade sequentially (bounded by max concurrent positions)
        for (const tradeId of [...this.monitoredTrades]) {
          if (!this.monitoredTrades.has(tradeId) || this.exitingTrades.has(tradeId)) {
            continue;
          }

          // Stuck position backoff — skip N cycles before retrying sell
          const skipCount = this.stuckPositionSkipCounts.get(tradeId);
          if (skipCount !== undefined && skipCount > 0) {
            this.stuckPositionSkipCounts.set(tradeId, skipCount - 1);
            continue;
          }

          try {
            await this.evaluateTradeExit(tradeId);
          } catch (err: unknown) {
            logger.error('Exit monitor error', {
              tradeId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err: unknown) {
        logger.error('Exit monitor top-level error', {
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.monitorRunning = false;
      }
    }, this.monitorPollMs);
  }

  /**
   * Process queued signals when a position slot opens.
   * Evicts expired signals, then tries to buy the oldest queued signal.
   */
  private async processSignalQueue(): Promise<void> {
    if (this.signalQueue.size === 0) return;

    const activeCount = this.dataProvider.getActivePositionCount();
    const effectiveMax = this.maxExposureGuard?.maxConcurrentPositions ?? MAX_CONCURRENT_POSITIONS;
    if (activeCount + this.pendingBuyCount >= effectiveMax || this.buySlotClaimed) return;

    const now = nowMs();

    // Evict expired signals
    for (const [mint, entry] of this.signalQueue) {
      if (now - entry.queuedAt > FilteredSniperStrategy.SIGNAL_QUEUE_TTL_MS) {
        this.signalQueue.delete(mint);
        logger.debug('Queued signal expired', { mint, ageMs: now - entry.queuedAt });
      }
    }

    if (this.signalQueue.size === 0) return;

    // Process the oldest signal (FIFO)
    const oldest = [...this.signalQueue.entries()]
      .sort((a, b) => a[1].queuedAt - b[1].queuedAt)[0];

    if (!oldest) return;

    const [mint, { signal }] = oldest;
    this.signalQueue.delete(mint);

    logger.info('Processing queued signal (slot now available)', {
      mint,
      signalType: signal.type,
      queueSize: this.signalQueue.size,
    });

    // Re-evaluate the signal through the normal flow
    try {
      await this.onSignal(signal);
    } catch (err: unknown) {
      logger.error('Failed to process queued signal', {
        mint,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private stopExitMonitor(): void {
    if (this.monitorIntervalHandle !== null) {
      clearInterval(this.monitorIntervalHandle);
      this.monitorIntervalHandle = null;
    }
  }
}
