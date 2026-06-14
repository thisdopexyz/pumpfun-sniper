import type { ServiceContainer } from '../container.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('app:execution:pnlRecorder');

/**
 * Record a trade's P&L with the daily loss guard and activate cooldown
 * when the exit was triggered by a stop-loss or timeout.
 *
 * This is the shared post-sell risk-recording logic used by both the
 * Jupiter and Pumpfun bonding-curve sell paths.
 *
 * @param container  Service container (dailyLossGuard + cooldownManager)
 * @param pnlUsd     Realised P&L in USD for this trade
 * @param reason     Exit reason string (e.g. 'STOP_LOSS', 'TIMEOUT', 'TAKE_PROFIT')
 * @param tradeId    Optional trade id for logging
 */
export function recordPnlAndRisk(
  container: ServiceContainer,
  pnlUsd: number,
  reason: string,
  tradeId?: string,
  mint?: string,
): void {
  const wasStopLoss = reason === 'STOP_LOSS' || reason === 'TIMEOUT' || reason === 'TRAILING_STOP' || reason === 'ANTI_RUG';
  const wasManualSell = reason === 'MANUAL_SELL' || reason === 'MANUAL';

  container.dailyLossGuard.recordTrade(pnlUsd, wasStopLoss);

  // Blacklist token on loss exits OR manual sells to prevent re-entry
  // Manual sell = user protecting capital from rug, never re-enter
  // BUT NOT for TIMEOUT if position was profitable (pnlUsd >= 0)
  //   — timeout on a profitable position (e.g., after scale-out) shouldn't blacklist
  // Note: BREAKEVEN_SL is not in wasStopLoss, so it's already excluded
  const shouldBlacklist = mint && (
    (wasStopLoss && !(reason === 'TIMEOUT' && pnlUsd >= 0)) ||
    wasManualSell
  );
  if (shouldBlacklist) {
    container.tokenBlacklist.handleStopLoss(mint);
    logger.info('Token blacklisted after exit', { tradeId, reason, mint: mint.slice(0, 12) });
  }

  // Cooldown triggers on ALL exits except SCALE_OUT (partial sell — position
  // still active, next tier should be reachable). Previously only triggered
  // for SL/TIMEOUT/TRAILING which meant GRADUATED, KILL_SWITCH, ANTI_RUG
  // exits had zero cooldown → bot immediately FOMO-bought the next token.
  if (reason !== 'SCALE_OUT') {
    // Loss exits (SL/TIMEOUT/TRAILING/ANTI_RUG): 120s cooldown
    // Win exits (TP/GRADUATED/MANUAL/etc.): 30s cooldown
    // Breakeven exits (BREAKEVEN_SL): 30s cooldown (not a real loss)
    const isBreakeven = reason === 'BREAKEVEN_SL';
    const cooldownSeconds = wasStopLoss ? 120 : 30;
    container.cooldownManager.activateCooldownForDuration(isBreakeven ? 30 : cooldownSeconds);
    logger.info('Cooldown activated after exit', { tradeId, reason, cooldownSeconds: isBreakeven ? 30 : cooldownSeconds, pnlUsd: pnlUsd.toFixed(4) });
  }
}
