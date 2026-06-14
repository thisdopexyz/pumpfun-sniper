/**
 * Exit Decision
 *
 * Evaluates whether a position should be exited based on:
 *   - Take profit (from constants)
 *   - Stop loss (from constants)
 *   - Trailing stop (activation + drop from constants)
 *   - Scale-out (tiered partial profit taking)
 *   - Anti-rug (suspicious holder dump)
 *   - Timeout (from constants)
 *
 * All values are LOCKED in filteredSniperRules.ts.
 *
 * Strategy = business logic ONLY. No RPC, no DB, no protocol decoding.
 */

import {
  TAKE_PROFIT_PERCENT,
  STOP_LOSS_PERCENT,
  TRAILING_STOP_PCT,
  TRAILING_ACTIVATION_PCT,
  TIMEOUT_MS,
  SCALE_OUT_ENABLED,
  SCALE_OUT_TIERS,
} from './filteredSniperRules.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('strategy:exitDecision');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Exit reason. */
// ExitReason: import for local use + re-export for downstream consumers
import type { ExitReason } from '../../core/types/strategy.js';
export type { ExitReason } from '../../core/types/strategy.js';

/** Position data for exit evaluation. */
export interface PositionData {
  readonly mint: MintAddress;
  readonly tradeId: string;
  /** Entry price in lamports per token (BigInt). */
  readonly entryPriceLamports: bigint;
  /** Current price in lamports per token (BigInt). */
  readonly currentPriceLamports: bigint;
  /** When the position was opened (ms epoch). */
  readonly openedAt: number;
  /** Whether the global kill switch is active. */
  readonly killSwitchActive: boolean;
  /** Whether the token has graduated from bonding curve (migrated to Raydium/Orca). */
  readonly graduated?: boolean;
  /** Highest price seen since entry (for trailing stop). Updated each poll. */
  readonly highestPriceLamports?: bigint;
  /** Anti-rug monitor detected a suspicious dump by a top holder. */
  readonly antiRugTriggered?: boolean;
  /** Post-buy monitor: volume drop detected. */
  readonly volumeDropTriggered?: boolean;
  /** Post-buy monitor: dev wallet selling detected. */
  readonly devSellTriggered?: boolean;
  /** Post-buy monitor: holder count drop detected. */
  readonly holderDropTriggered?: boolean;
  /** Which scale-out tiers have already been sold (by index). */
  readonly scaleOutTiersCompleted?: readonly number[];
}

/** Exit decision result. */
export interface ExitDecisionResult {
  /** Whether the position should be exited. */
  readonly shouldExit: boolean;
  /** Exit reason (if shouldExit is true). */
  readonly reason: ExitReason | null;
  /** Current P&L in percent (can be negative). */
  readonly pnlPercent: number;
  /** Time elapsed since position opened, in ms. */
  readonly elapsedMs: number;
  /** Human-readable explanation. */
  readonly explanation: string;
  /** Percentage of current balance to sell (default 100). Used by SCALE_OUT. */
  readonly sellPct?: number;
  /** Scale-out tier index (0-based). Used to track completed tiers. */
  readonly tierIndex?: number;
}

// ---------------------------------------------------------------------------
// Exit Decision
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a position should be exited.
 *
 * Priority order:
 *   1. Kill switch (highest priority — immediate exit)
 *   2. Scale-out (partial profit taking)
 *   3. Trailing stop (lock profits from high)
 *   4. Anti-rug (suspicious dump detected)
 *   5. Stop loss (protect capital)
 *   6. Take profit (lock gains)
 *   7. Timeout (prevent stale positions)
 *
 * P&L calculation uses BigInt to avoid floating point errors.
 * pnlPercent = ((current - entry) * 10000 / entry) / 100
 *            = basis points / 100 → percentage
 */
export function evaluateExit(data: PositionData): ExitDecisionResult {
  const now = nowMs();
  const elapsedMs = now - data.openedAt;

  // GRADUATED tokens: no longer auto-sell. After graduation to Raydium,
  // dataProvider fetches real Jupiter price so trailing/SL/TP work normally.
  // This lets us ride post-graduation pumps instead of selling immediately.

  // Calculate P&L in basis points using BigInt
  // pnlBps = (current - entry) * 10000n / entry
  let pnlBps: bigint;
  if (data.entryPriceLamports === 0n) {
    pnlBps = 0n;
  } else {
    pnlBps =
      ((data.currentPriceLamports - data.entryPriceLamports) * 10000n) /
      data.entryPriceLamports;
  }

  // Convert to percentage (float, for display/comparison only)
  const pnlPercent = Number(pnlBps) / 100;

  // --- Check 1: Kill switch ---
  if (data.killSwitchActive) {
    logger.warn('Exit decision: KILL SWITCH active', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'KILL_SWITCH',
      pnlPercent,
      elapsedMs,
      explanation: 'Emergency kill switch is active — exiting immediately',
    };
  }

  // --- Check 1.5: Scale-out (partial profit taking) ---
  // Highest priority after kill switch. Checks if any tier trigger has been
  // reached and not yet completed. Returns partial sell percentage.
  if (SCALE_OUT_ENABLED && SCALE_OUT_TIERS.length > 0 && data.entryPriceLamports > 0n) {
    const completedTiers = new Set(data.scaleOutTiersCompleted ?? []);
    for (let i = 0; i < SCALE_OUT_TIERS.length; i++) {
      const tier = SCALE_OUT_TIERS[i]!;
      if (completedTiers.has(i)) continue;
      const triggerBps = BigInt(tier.triggerPct * 100);
      if (pnlBps >= triggerBps) {
        logger.info('Exit decision: SCALE_OUT triggered', {
          tradeId: data.tradeId,
          mint: data.mint,
          tierIndex: i,
          triggerPct: tier.triggerPct,
          sellPct: tier.sellPct,
          pnlPercent: pnlPercent.toFixed(2),
        });
        return {
          shouldExit: true,
          reason: 'SCALE_OUT',
          pnlPercent,
          elapsedMs,
          sellPct: tier.sellPct,
          tierIndex: i,
          explanation: `Scale-out tier ${i + 1}: P&L ${pnlPercent.toFixed(2)}% >= +${tier.triggerPct}% — sell ${tier.sellPct}% of position`,
        };
      }
    }
  }

  // --- Check 1.7: Breakeven SL after scale-out tier 0 (BEFORE trailing stop) ---
  // After tier 0 partial sell, remaining position should ride with BE at entry.
  // Without this, trailing stop (priority 2) would fire ABOVE entry, overriding
  // the user's intent that BE = entry price after securing partial profit.
  const allScaleOutTiersDone = !SCALE_OUT_ENABLED || (data.scaleOutTiersCompleted?.length ?? 0) >= SCALE_OUT_TIERS.length;
  const tier0DoneForBE = data.scaleOutTiersCompleted?.includes(0) ?? false;
  if (tier0DoneForBE && data.entryPriceLamports > 0n && pnlPercent <= 0) {
    logger.warn('Exit decision: BREAKEVEN_SL triggered (pre-trailing, after tier 0)', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'BREAKEVEN_SL',
      pnlPercent,
      elapsedMs,
      explanation: `Breakeven SL triggered: P&L ${pnlPercent.toFixed(2)}% <= 0% (entry protection after scale-out)`,
    };
  }

  // --- Check 2: Trailing stop (activates after TRAILING_ACTIVATION_PCT profit) ---
  // Trails from highest price seen. Dynamic tightening as profit increases.
  // Trailing stop is INDEPENDENT of scale-out tiers — it protects remaining position
  // from large drops even when next tier threshold hasn't been reached.
  // Scale-out (priority 1.5) fires first if a tier trigger is hit; trailing (priority 2)
  // catches the fall when no tier triggers but price drops significantly from peak.
  if (TRAILING_STOP_PCT > 0 && data.highestPriceLamports && data.entryPriceLamports > 0n) {
    const highestPnlBps = ((data.highestPriceLamports - data.entryPriceLamports) * 10000n) / data.entryPriceLamports;
    const activationBps = BigInt(TRAILING_ACTIVATION_PCT * 100);
    // Only trail if highest exceeded activation threshold
    if (highestPnlBps >= activationBps) {
      // Dynamic trailing: tighten as profit increases
      const highestPnlPercent = Number(highestPnlBps) / 100;
      let dynamicTrailingPct: number;
      if (highestPnlPercent >= 1000) {
        dynamicTrailingPct = 15; // At 1000%+, trail by 15%
      } else if (highestPnlPercent >= 500) {
        dynamicTrailingPct = 20; // At 500%+, trail by 20%
      } else if (highestPnlPercent >= 200) {
        dynamicTrailingPct = 25; // At 200%+, trail by 25%
      } else {
        dynamicTrailingPct = TRAILING_STOP_PCT; // Default (30%)
      }
      // Trailing stop price = highest * (100 - trailingPct) / 100
      const trailingStopPrice = (data.highestPriceLamports * BigInt(100 - dynamicTrailingPct)) / 100n;
      if (data.currentPriceLamports <= trailingStopPrice) {
        const trailingPnlBps = ((data.currentPriceLamports - data.entryPriceLamports) * 10000n) / data.entryPriceLamports;
        const trailingPnlPercent = Number(trailingPnlBps) / 100;
        logger.warn('Exit decision: TRAILING STOP triggered', {
          tradeId: data.tradeId,
          mint: data.mint,
          highestPrice: data.highestPriceLamports.toString(),
          currentPrice: data.currentPriceLamports.toString(),
          trailingStopPrice: trailingStopPrice.toString(),
          pnlPercent: trailingPnlPercent.toFixed(2),
          dynamicTrailingPct,
          highestPnlPercent: highestPnlPercent.toFixed(2),
        });
        return {
          shouldExit: true,
          reason: 'TRAILING_STOP',
          pnlPercent: trailingPnlPercent,
          elapsedMs,
          explanation: `Trailing stop triggered: price dropped ${dynamicTrailingPct}% from ${highestPnlPercent.toFixed(0)}% high (PNL ${trailingPnlPercent.toFixed(2)}%)`,
        };
      }
    }
  }

  // --- Check 2.5: Anti-rug (detected by AntiRugMonitor) ---
  if (data.antiRugTriggered) {
    logger.warn('Exit decision: ANTI_RUG triggered — top holder dump detected', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'ANTI_RUG',
      pnlPercent,
      elapsedMs,
      explanation: 'Anti-rug triggered: suspicious large dump detected by top holder',
    };
  }

  // --- Check 2.6: Post-buy monitors ---
  if (data.volumeDropTriggered) {
    logger.warn('Exit decision: VOLUME_DROP triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'ANTI_RUG',
      pnlPercent,
      elapsedMs,
      explanation: 'Post-buy: volume dropped 80%+ — likely rug',
    };
  }

  if (data.devSellTriggered) {
    logger.warn('Exit decision: DEV_SELL triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'ANTI_RUG',
      pnlPercent,
      elapsedMs,
      explanation: 'Post-buy: dev wallet selling — exit immediately',
    };
  }

  if (data.holderDropTriggered) {
    logger.warn('Exit decision: HOLDER_DROP triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'ANTI_RUG',
      pnlPercent,
      elapsedMs,
      explanation: 'Post-buy: holder count dropped 30%+ — mass exodus',
    };
  }

  // --- Check 3: Stop loss (base -50% for positions without tier 0 completed) ---
  // Breakeven after tier 0 is handled in Check 1.7 (before trailing stop).
  if (pnlPercent <= STOP_LOSS_PERCENT) {
    logger.warn('Exit decision: STOP LOSS triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
      threshold: STOP_LOSS_PERCENT,
    });
    return {
      shouldExit: true,
      reason: 'STOP_LOSS',
      pnlPercent,
      elapsedMs,
      explanation: `Stop loss triggered: P&L ${pnlPercent.toFixed(2)}% <= ${STOP_LOSS_PERCENT}%`,
    };
  }

  // --- Check 4: Take profit (only after all scale-out tiers completed) ---
  if (pnlPercent >= TAKE_PROFIT_PERCENT && allScaleOutTiersDone) {
    logger.info('Exit decision: TAKE PROFIT triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
      threshold: TAKE_PROFIT_PERCENT,
    });
    return {
      shouldExit: true,
      reason: 'TAKE_PROFIT',
      pnlPercent,
      elapsedMs,
      explanation: `Take profit triggered: P&L ${pnlPercent.toFixed(2)}% >= +${TAKE_PROFIT_PERCENT}%`,
    };
  }

  // --- Check 5: Timeout ---
  if (elapsedMs >= TIMEOUT_MS) {
    logger.info('Exit decision: TIMEOUT triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
      elapsedMs,
      timeoutMs: TIMEOUT_MS,
    });
    return {
      shouldExit: true,
      reason: 'TIMEOUT',
      pnlPercent,
      elapsedMs,
      explanation: `Timeout triggered: ${Math.round(elapsedMs / 1000)}s >= ${TIMEOUT_MS / 1000}s`,
    };
  }

  // --- No exit condition met ---
  return {
    shouldExit: false,
    reason: null,
    pnlPercent,
    elapsedMs,
    explanation: `Holding: P&L ${pnlPercent.toFixed(2)}%, elapsed ${Math.round(elapsedMs / 1000)}s`,
  };
}
