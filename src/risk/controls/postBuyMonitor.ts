/**
 * Post-Buy Monitor
 *
 * Monitors positions after buy for early exit signals:
 *   1. Volume Drop — volume drops 80%+ = rug signal
 *   2. Dev Wallet — dev wallet sells = exit immediately
 *   3. Holder Count — holder count drops 30%+ in 1 minute = exit
 *   4. Price Reversal — pump 20% then dump 10% in 30s = exit
 *
 * Design:
 *   - Polls every 2 seconds (same as anti-rug)
 *   - Per-mint state tracking
 *   - Pure monitoring + callback
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import { parseBondingCurveData } from '../../adapters/protocols/pumpfun/tokenParser.js';
import { deriveBondingCurvePDA } from '../../adapters/protocols/pumpfun/shared.js';

const logger = createLogger('risk:postBuyMonitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Polling interval: 2 seconds */
const POLL_INTERVAL_MS = 2_000;

/** Volume drop threshold: 80% */
const VOLUME_DROP_THRESHOLD_PCT = 90;

/** Holder drop threshold: 30% of top-20 must churn out within 5s windows. */
const HOLDER_DROP_THRESHOLD_PCT = 30;

/** Volume check: compare last 10s vs previous 10s */
const VOLUME_WINDOW_MS = 10_000;

/** Holder check: minimum time before checking (15s to establish baseline) */
const HOLDER_BASELINE_MS = 15_000;

/** Grace period: no monitoring for first 60 seconds after buy */
const GRACE_PERIOD_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback when a post-buy exit signal is detected. */
export type PostBuyExitCallback = (mint: string, reason: string, details: string) => void;

/** Per-mint monitoring state. */
interface MintMonitorState {
  readonly mint: string;
  readonly startedAt: number;

  // Volume tracking
  volumeBaseline: bigint;
  volumeCurrent: bigint;
  volumeWindowStart: number;

  // Holder tracking
  holderBaseline: number;
  lastHolderCount: number;
  lastHolderCheckAt: number;

  // Polling
  intervalId: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// PostBuyMonitor
// ---------------------------------------------------------------------------

export class PostBuyMonitor {
  private readonly connection: Connection;
  private readonly monitors = new Map<string, MintMonitorState>();
  /** In-flight poll guard. Prevents overlapping polls when RPC > POLL_INTERVAL_MS. */
  private readonly polling = new Set<string>();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Start monitoring a mint after buy.
   *
   * Note: `devWallet` parameter was removed (2026-06-23) — caller always
   * passed null and the implementation was broken (see class comments).
   * If dev tracking is needed later, add a `devAta: PublicKey | null`
   * param and use `getAccountInfo(devAta)` for specific balance reads.
   */
  startMonitoring(
    mint: string,
    onExitSignal: PostBuyExitCallback,
  ): void {
    if (this.monitors.has(mint)) {
      logger.warn('Already monitoring mint for post-buy', { mint });
      return;
    }

    logger.info('Starting post-buy monitoring', { mint });

    const intervalId = setInterval(() => {
      // Skip if previous poll still in flight — prevents overlapping polls
      // when RPC latency exceeds POLL_INTERVAL_MS.
      if (this.polling.has(mint)) return;
      this.polling.add(mint);
      this.pollMint(mint, onExitSignal)
        .catch((err: unknown) => {
          logger.debug('Post-buy poll threw', {
            mint,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.polling.delete(mint);
        });
    }, POLL_INTERVAL_MS);

    this.monitors.set(mint, {
      mint,
      startedAt: nowMs(),
      volumeBaseline: 0n,
      volumeCurrent: 0n,
      volumeWindowStart: nowMs(),
      holderBaseline: 0,
      lastHolderCount: 0,
      lastHolderCheckAt: 0,
      intervalId,
    });

    // First poll to establish baseline
    if (!this.polling.has(mint)) {
      this.polling.add(mint);
      void this.pollMint(mint, onExitSignal)
        .catch((err: unknown) => {
          logger.error('Initial post-buy poll failed', {
            mint,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.polling.delete(mint);
        });
    }
  }

  /**
   * Stop monitoring a mint.
   */
  stopMonitoring(mint: string): void {
    const state = this.monitors.get(mint);
    if (state === undefined) return;

    clearInterval(state.intervalId);
    this.monitors.delete(mint);
    logger.info('Stopped post-buy monitoring', { mint });
  }

  /**
   * Stop all monitoring.
   */
  stopAll(): void {
    for (const [_mint, state] of this.monitors) {
      clearInterval(state.intervalId);
    }
    this.monitors.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async pollMint(
    mint: string,
    onExitSignal: PostBuyExitCallback,
  ): Promise<void> {
    const state = this.monitors.get(mint);
    if (state === undefined) return;

    try {
      const now = nowMs();
      const elapsed = now - state.startedAt;

      // Grace period: skip monitoring for first 60 seconds
      if (elapsed < GRACE_PERIOD_MS) {
        return;
      }

      // Fetch bonding curve data for price + volume
      const mintPk = new PublicKey(mint);
      const bcPDA = deriveBondingCurvePDA(mintPk);
      const bcAccount = await this.connection.getAccountInfo(bcPDA);

      if (!bcAccount?.data || bcAccount.data.length < 49) {
        return; // Account gone or invalid
      }

      const parsed = parseBondingCurveData(bcAccount.data);
      if (!parsed) return;

      // ── CHECK 3: Top-20 Holder Churn Detection ──
      // NOTE: getTokenLargestAccounts returns at most 20 holders. This check
      // measures "top-20 churn" (count of wallets in top-20 falling out), NOT
      // total holder exodus. For total holder count, would need Helius DAS API
      // (paginated, slower — see getRealHolderCount in dataProvider).
      //
      // Threshold tuned to 30% (was 50%): more sensitive to mass dump where
      // top holders sell but new wallets enter. Even 6/20 dropping out (30%)
      // signals coordinated dump pressure worth exiting on.
      // Check every 5 seconds after baseline established
      if (elapsed > HOLDER_BASELINE_MS && now - state.lastHolderCheckAt >= 5_000) {
        try {
          const largestAccounts = await this.connection.getTokenLargestAccounts(mintPk);
          const holderCount = largestAccounts.value.length;

          if (state.holderBaseline === 0) {
            // First count = baseline
            state.holderBaseline = holderCount;
            state.lastHolderCount = holderCount;
          } else {
            const dropPct = ((state.lastHolderCount - holderCount) / state.lastHolderCount) * 100;

            if (dropPct >= HOLDER_DROP_THRESHOLD_PCT) {
              const details = `Top-20 holder churn ${dropPct.toFixed(0)}%: ${state.lastHolderCount} → ${holderCount} holders`;
              logger.warn('POST-BUY EXIT: Holder churn detected', { mint, details });
              this.stopMonitoring(mint);
              onExitSignal(mint, 'HOLDER_DROP', details);
              return;
            }

            state.lastHolderCount = holderCount;
          }

          state.lastHolderCheckAt = now;
        } catch {
          // Ignore holder check errors
        }
      }

      // ── CHECK 1: Volume Drop Detection ──
      // Track realSolReserves change across each window. Two signals:
      //   - DROP: realSolReserves decreased from previous window baseline
      //     → potential rug, holders are withdrawing SOL from curve
      //   - STALL: realSolReserves flat (no growth) after warmup
      //     → momentum dying, organic buyers gone
      const currentRealSol = parsed.realSolReserves;
      if (state.volumeBaseline === 0n) {
        state.volumeBaseline = currentRealSol;
        state.volumeWindowStart = now;
      } else {
        // Check if we've moved to a new window
        if (now - state.volumeWindowStart >= VOLUME_WINDOW_MS) {
          const prevBaseline = state.volumeBaseline;
          const solDelta = currentRealSol - prevBaseline; // signed: + = growth, - = drain
          // volumeCurrent tracks PREVIOUS window's volume for comparison
          if (state.volumeCurrent > 0n) {
            if (solDelta < 0n) {
              // RUG SIGNAL: SOL reserves decreased — holders withdrawing
              const drainAbs = -solDelta;
              const dropPct = Number((drainAbs * 10000n) / state.volumeCurrent) / 100;
              if (dropPct >= VOLUME_DROP_THRESHOLD_PCT) {
                const details = `SOL reserves drained ${dropPct.toFixed(0)}%: ` +
                  `${Number(prevBaseline) / 1e9} → ${Number(currentRealSol) / 1e9} SOL`;
                logger.warn('POST-BUY EXIT: Volume drop (SOL drain) detected', { mint, details });
                this.stopMonitoring(mint);
                onExitSignal(mint, 'VOLUME_DROP', details);
                return;
              }
            } else if (solDelta === 0n && now - state.startedAt > VOLUME_WINDOW_MS * 3) {
              // STALL: no growth for 3+ windows (30s+ with zero inflow) — momentum dead
              const details = `Volume stall: SOL flat at ${Number(currentRealSol) / 1e9} SOL for ${VOLUME_WINDOW_MS * 3 / 1000}s`;
              logger.warn('POST-BUY EXIT: Volume stall detected', { mint, details });
              this.stopMonitoring(mint);
              onExitSignal(mint, 'VOLUME_DROP', details);
              return;
            }
          }
          // Update rolling state: previous window's volume becomes "volumeCurrent" for next comparison
          state.volumeCurrent = solDelta > 0n ? solDelta : 0n;
          state.volumeBaseline = currentRealSol;
          state.volumeWindowStart = now;
        }
      }

      // ── CHECK 2: Dev Wallet Monitoring ──
      // REMOVED 2026-06-23: caller (FilteredSniperStrategy.onSignal line 574)
      // always passes devWallet=null, AND the implementation used
      // getTokenLargestAccounts which returns top-20 holders (not specific
      // wallet). Creator drops out of top-20 within seconds after launch,
      // so this check was dead code (would never fire correctly).
      //
      // If dev-wallet tracking is needed in future: use
      // `getAccountInfo(devAta)` to read dev's specific token balance.
      // Requires dev ATA derivation (getAssociatedTokenAddressSync).

    } catch (err: unknown) {
      logger.error('Post-buy poll failed', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
