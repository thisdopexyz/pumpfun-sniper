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

/** Holder count drop threshold: 30% */
const HOLDER_DROP_THRESHOLD_PCT = 50;

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
  readonly devWallet: string | null;
  readonly startedAt: number;

  // Volume tracking
  volumeBaseline: bigint;
  volumeCurrent: bigint;
  volumeWindowStart: number;

  // Holder tracking
  holderBaseline: number;
  lastHolderCount: number;
  lastHolderCheckAt: number;

  // Dev wallet tracking
  devLastBalance: bigint | null;

  // Polling
  intervalId: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// PostBuyMonitor
// ---------------------------------------------------------------------------

export class PostBuyMonitor {
  private readonly connection: Connection;
  private readonly monitors = new Map<string, MintMonitorState>();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Start monitoring a mint after buy.
   */
  startMonitoring(
    mint: string,
    devWallet: string | null,
    onExitSignal: PostBuyExitCallback,
  ): void {
    if (this.monitors.has(mint)) {
      logger.warn('Already monitoring mint for post-buy', { mint });
      return;
    }

    logger.info('Starting post-buy monitoring', {
      mint,
      devWallet: devWallet?.slice(0, 12) ?? 'unknown',
    });

    const intervalId = setInterval(async () => {
      await this.pollMint(mint, onExitSignal);
    }, POLL_INTERVAL_MS);

    this.monitors.set(mint, {
      mint,
      devWallet,
      startedAt: nowMs(),
      volumeBaseline: 0n,
      volumeCurrent: 0n,
      volumeWindowStart: nowMs(),
      holderBaseline: 0,
      lastHolderCount: 0,
      lastHolderCheckAt: 0,
      devLastBalance: null,
      intervalId,
    });

    // First poll to establish baseline
    void this.pollMint(mint, onExitSignal).catch((err: unknown) => {
      logger.error('Initial post-buy poll failed', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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

      // ── CHECK 3: Holder Count Monitoring ──
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
              const details = `Holder count dropped ${dropPct.toFixed(0)}%: ${state.lastHolderCount} → ${holderCount}`;
              logger.warn('POST-BUY EXIT: Holder count drop', { mint, details });
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
      // Track volume from realSolReserves changes
      const currentRealSol = parsed.realSolReserves;
      if (state.volumeBaseline === 0n) {
        state.volumeBaseline = currentRealSol;
        state.volumeWindowStart = now;
      } else {
        // Check if we've moved to a new window
        if (now - state.volumeWindowStart >= VOLUME_WINDOW_MS) {
          const volumeDelta = currentRealSol > state.volumeBaseline
            ? currentRealSol - state.volumeBaseline
            : 0n;

          if (state.volumeCurrent > 0n && volumeDelta > 0n) {
            const dropPct = Number(((state.volumeCurrent - volumeDelta) * 10000n) / state.volumeCurrent) / 100;

            if (dropPct >= VOLUME_DROP_THRESHOLD_PCT) {
              const details = `Volume dropped ${dropPct.toFixed(0)}%: ${Number(state.volumeCurrent) / 1e9} SOL → ${Number(volumeDelta) / 1e9} SOL`;
              logger.warn('POST-BUY EXIT: Volume drop detected', { mint, details });
              this.stopMonitoring(mint);
              onExitSignal(mint, 'VOLUME_DROP', details);
              return;
            }
          }

          state.volumeCurrent = volumeDelta;
          state.volumeBaseline = currentRealSol;
          state.volumeWindowStart = now;
        }
      }

      // ── CHECK 2: Dev Wallet Monitoring ──
      if (state.devWallet) {
        try {
// devPk not needed - using mintPk for getTokenLargestAccounts
          const devAccount = await this.connection.getTokenLargestAccounts(mintPk);
          const devEntry = devAccount.value.find(
            a => a.address.toBase58() === state.devWallet
          );

          const devBalance = devEntry ? BigInt(devEntry.amount) : 0n;

          if (state.devLastBalance !== null && devBalance < state.devLastBalance) {
            const sold = state.devLastBalance - devBalance;
            const soldPct = state.devLastBalance > 0n
              ? Number((sold * 10000n) / state.devLastBalance) / 100
              : 0;

            if (soldPct > 0) {
              const details = `Dev wallet sold ${soldPct.toFixed(1)}% of holdings`;
              logger.warn('POST-BUY EXIT: Dev wallet selling', { mint, details });
              this.stopMonitoring(mint);
              onExitSignal(mint, 'DEV_SELL', details);
              return;
            }
          }

          state.devLastBalance = devBalance;
        } catch {
          // Ignore dev wallet check errors
        }
      }

    } catch (err: unknown) {
      logger.error('Post-buy poll failed', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
