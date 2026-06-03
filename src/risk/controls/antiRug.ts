/**
 * Anti-Rug Monitor
 *
 * Monitors top holder wallets for suspicious large dumps during active
 * positions. Uses getTokenLargestAccounts to periodically snapshot holder
 * balances and compares with the previous snapshot.
 *
 * If any holder's balance decreased by more than the configured threshold
 * percentage of the total supply, an emergency exit is triggered.
 *
 * Design:
 *   - Only polls while a position is active (start/stop per mint)
 *   - Uses setInterval for efficient polling
 *   - Per-mint state tracking (snapshot + interval)
 *   - No business logic — pure monitoring + callback
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  DEFAULT_ANTI_RUG_ENABLED,
  DEFAULT_RUG_DUMP_THRESHOLD_PCT,
  DEFAULT_RUG_CUMULATIVE_DUMP_THRESHOLD_PCT,
  DEFAULT_RUG_CHECK_INTERVAL_MS,
} from '../../core/constants/defaults.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:antiRug');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-mint monitoring state. */
interface MintMonitorState {
  readonly mint: string;
  /** Previous holder balance snapshot (address → token balance as string). */
  lastSnapshot: Map<string, bigint>;
  /** Total supply from the last poll (for threshold calculation). */
  lastTotalSupply: bigint;
  /** setInterval handle. */
  intervalId: ReturnType<typeof setInterval>;
}

/** Configuration for AntiRugMonitor. */
export interface AntiRugConfig {
  /** Whether the monitor is enabled. Default: true. */
  readonly enabled?: boolean;
  /** Emergency exit — single holder dump > this % of total supply. Default: 10. */
  readonly thresholdPct?: number;
  /** Emergency exit — ALL top holders combined dump > this % of total supply. Default: 15. */
  readonly cumulativeDumpThresholdPct?: number;
  /** Polling interval in ms. Default: 5000. */
  readonly checkIntervalMs?: number;
}

/** Callback when a rug is detected. */
export type RugDetectedCallback = (mint: string, details: string) => void;

// ---------------------------------------------------------------------------
// AntiRugMonitor
// ---------------------------------------------------------------------------

export class AntiRugMonitor {
  private readonly connection: Connection;
  private readonly enabled: boolean;
  private readonly thresholdPct: number;
  private readonly cumulativeDumpThresholdPct: number;
  private readonly checkIntervalMs: number;

  /** Active monitoring state per mint. */
  private readonly monitors = new Map<string, MintMonitorState>();

  constructor(connection: Connection, config?: AntiRugConfig) {
    this.connection = connection;
    this.enabled = config?.enabled ?? DEFAULT_ANTI_RUG_ENABLED;
    this.thresholdPct = config?.thresholdPct ?? DEFAULT_RUG_DUMP_THRESHOLD_PCT;
    this.cumulativeDumpThresholdPct = config?.cumulativeDumpThresholdPct ?? DEFAULT_RUG_CUMULATIVE_DUMP_THRESHOLD_PCT;
    this.checkIntervalMs = config?.checkIntervalMs ?? DEFAULT_RUG_CHECK_INTERVAL_MS;
  }

  /**
   * Start monitoring a mint for suspicious top-holder dumps.
   * No-op if disabled or already monitoring this mint.
   */
  startMonitoring(mint: string, onRugDetected: RugDetectedCallback): void {
    if (!this.enabled) {
      logger.debug('Anti-rug monitor disabled, skipping', { mint });
      return;
    }

    if (this.monitors.has(mint)) {
      logger.warn('Already monitoring mint for anti-rug', { mint });
      return;
    }

    logger.info('Starting anti-rug monitoring', {
      mint,
      thresholdPct: this.thresholdPct,
      cumulativeDumpThresholdPct: this.cumulativeDumpThresholdPct,
      checkIntervalMs: this.checkIntervalMs,
    });

    // Take an initial snapshot before starting the interval
    const intervalId = setInterval(async () => {
      await this.pollMint(mint, onRugDetected);
    }, this.checkIntervalMs);

    // Store with empty snapshot — first poll will populate it
    this.monitors.set(mint, {
      mint,
      lastSnapshot: new Map(),
      lastTotalSupply: 0n,
      intervalId,
    });

    // Fire the first poll immediately to establish baseline
    void this.pollMint(mint, onRugDetected).catch((err: unknown) => {
      logger.error('Initial anti-rug poll failed', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Stop monitoring a mint. Clears the polling interval.
   */
  stopMonitoring(mint: string): void {
    const state = this.monitors.get(mint);
    if (state === undefined) {
      return;
    }

    clearInterval(state.intervalId);
    this.monitors.delete(mint);
    logger.info('Stopped anti-rug monitoring', { mint });
  }

  /**
   * Stop all active monitoring. Called during shutdown.
   */
  stopAll(): void {
    for (const [mint, state] of this.monitors) {
      clearInterval(state.intervalId);
      logger.info('Stopped anti-rug monitoring (stopAll)', { mint });
    }
    this.monitors.clear();
  }

  /**
   * Check if a mint is currently being monitored.
   */
  isMonitoring(mint: string): boolean {
    return this.monitors.has(mint);
  }

  /**
   * Get the count of active monitors (for diagnostics).
   */
  getActiveMonitorCount(): number {
    return this.monitors.size;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Poll a single mint: fetch current top holders, compare with snapshot.
   */
  private async pollMint(
    mint: string,
    onRugDetected: RugDetectedCallback,
  ): Promise<void> {
    const state = this.monitors.get(mint);
    if (state === undefined) {
      // Monitoring was stopped while async poll was in-flight
      return;
    }

    try {
      // getTokenLargestAccounts returns the top 20 token holders
      const largestAccounts = await this.connection.getTokenLargestAccounts(
        new PublicKey(mint),
      );

      // Build current snapshot
      const currentSnapshot = new Map<string, bigint>();
      for (const account of largestAccounts.value) {
        currentSnapshot.set(account.address.toBase58(), BigInt(account.amount));
      }

      // Fetch total supply BEFORE comparison so first poll can detect dumps
      try {
        const supply = await this.connection.getTokenSupply(
          new PublicKey(mint),
        );
        if (supply?.value?.amount) {
          state.lastTotalSupply = BigInt(supply.value.amount);
        }
      } catch (supplyErr: unknown) {
        logger.debug('Failed to fetch token supply for anti-rug', {
          mint,
          error: supplyErr instanceof Error ? supplyErr.message : String(supplyErr),
        });
      }

      // If we have a previous snapshot, compare balances
      if (state.lastSnapshot.size > 0 && state.lastTotalSupply > 0n) {
        const dumpThreshold = (state.lastTotalSupply * BigInt(this.thresholdPct)) / 100n;
        const cumulativeThreshold = (state.lastTotalSupply * BigInt(this.cumulativeDumpThresholdPct)) / 100n;
        let totalDecrease = 0n;

        for (const [address, currentBalance] of currentSnapshot) {
          const previousBalance = state.lastSnapshot.get(address);
          if (previousBalance === undefined) {
            // New holder appeared — not a concern
            continue;
          }

          const decrease = previousBalance - currentBalance;
          if (decrease > 0n) {
            totalDecrease += decrease;
          }

          // Check 1: Single holder dump > threshold
          if (decrease > dumpThreshold) {
            const decreasePct = Number((decrease * 10000n) / state.lastTotalSupply) / 100;
            const details =
              `Top holder ${address.slice(0, 8)}... dumped ${decreasePct.toFixed(2)}% of supply ` +
              `(${decrease.toString()} tokens, threshold: ${this.thresholdPct}%)`;

            logger.warn('ANTI-RUG DETECTED (single holder dump)', {
              mint,
              address: address.slice(0, 12),
              decreaseTokens: decrease.toString(),
              decreasePct: decreasePct.toFixed(2),
              thresholdPct: this.thresholdPct,
              previousBalance: previousBalance.toString(),
              currentBalance: currentBalance.toString(),
            });

            // Stop monitoring this mint before triggering callback
            this.stopMonitoring(mint);
            onRugDetected(mint, details);
            return;
          }
        }

        // Check 2: Cumulative dump from ALL top holders > threshold
        if (totalDecrease > cumulativeThreshold) {
          const totalDecreasePct = Number((totalDecrease * 10000n) / state.lastTotalSupply) / 100;
          const details =
            `Top 20 holders cumulatively dumped ${totalDecreasePct.toFixed(2)}% of supply ` +
            `(${totalDecrease.toString()} tokens, cumulative threshold: ${this.cumulativeDumpThresholdPct}%)`;

          logger.warn('ANTI-RUG DETECTED (cumulative dump)', {
            mint,
            totalDecreaseTokens: totalDecrease.toString(),
            totalDecreasePct: totalDecreasePct.toFixed(2),
            cumulativeThresholdPct: this.cumulativeDumpThresholdPct,
            holderCount: currentSnapshot.size,
          });

          this.stopMonitoring(mint);
          onRugDetected(mint, details);
          return;
        }
      }

      // Update snapshot for next poll
      state.lastSnapshot = currentSnapshot;

      logger.debug('Anti-rug poll completed (no dump detected)', {
        mint,
        holderCount: currentSnapshot.size,
        totalSupply: state.lastTotalSupply.toString(),
      });
    } catch (err: unknown) {
      logger.error('Anti-rug poll failed', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't stop monitoring on transient errors — just skip this poll
    }
  }
}
