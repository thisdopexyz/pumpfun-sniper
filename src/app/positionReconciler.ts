/**
 * Position Reconciler
 *
 * Periodically checks if DB OPEN positions still have live token balance.
 * If wallet has 0 tokens but DB says OPEN → record SELL to close the gap.
 * Fixes: manual sells, bot crashes during sell, sell TX confirmed but DB not updated.
 */

import { PublicKey, type Connection } from '@solana/web3.js';
import type { PositionRegistry } from '../core/state/positionRegistry.js';
import { createLogger } from '../telemetry/logging/logger.js';
import { nowMs } from '../core/utils/time.js';
import type { OpenBuyTradeRepository } from './positionRecovery.js';
import { hasLiveTokenBalance } from './positionRecovery.js';
import { saveTrade } from './execution/tradeRecorder.js';
import type { ServiceContainer } from './container.js';

const logger = createLogger('app:reconciler');

const RECONCILE_INTERVAL_MS = 60_000; // Check every 60 seconds

export interface ReconcilerConfig {
  readonly container: ServiceContainer;
  readonly connection: Connection;
  readonly wallet: PublicKey;
  readonly positionRegistry: PositionRegistry;
  readonly tradeRepository: OpenBuyTradeRepository;
  readonly monitorTrade: (tradeId: string, mint?: string) => void;
  readonly monitoredTrades: Set<string>;
  /** Cleanup callback when a position is reconciled (manual sell detected). */
  readonly cleanupMint?: (tradeId: string, mint: string) => void;
}

export class PositionReconciler {
  private readonly config: ReconcilerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  /** Prevents overlapping reconcile runs when RPC > RECONCILE_INTERVAL_MS. */
  private reconcileInFlight = false;

  constructor(config: ReconcilerConfig) {
    this.config = config;
  }

  start(): void {
    // Run once immediately, then periodically
    void this.reconcile();
    this.intervalHandle = setInterval(() => {
      // Skip if previous reconcile still in flight — prevents duplicate DB writes
      // when RPC latency exceeds RECONCILE_INTERVAL_MS.
      if (this.reconcileInFlight) return;
      this.reconcileInFlight = true;
      void this.reconcile().finally(() => {
        this.reconcileInFlight = false;
      });
    }, RECONCILE_INTERVAL_MS);
    logger.info('Position reconciler started', { intervalMs: RECONCILE_INTERVAL_MS });
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Reconcile DB OPEN positions with actual wallet token balance.
   * If wallet has 0 tokens but DB says OPEN → record SELL to close.
   */
  private async reconcile(): Promise<void> {
    try {
      const { container, connection, wallet, positionRegistry, tradeRepository, monitoredTrades } = this.config;

      // Get all OPEN buys from DB
      const openBuys = await tradeRepository.findOpenConfirmedBuys();
      let reconciled = 0;

      for (const trade of openBuys) {
        const mintPk = new PublicKey(trade.mint);

        // Check if wallet still holds this token
        const hasBalance = await hasLiveTokenBalance(connection, wallet, mintPk);

        if (!hasBalance) {
          // Token is gone from wallet but DB says OPEN
          // Check if sell executor already saved a record (any confirmed sell for this trade)
          const existingSells = await container.tradeRepository.findConfirmedSellsByTradeId(trade.id);
          if (existingSells.length > 0) {
            // Sell executor already recorded this — don't overwrite with null
            logger.info('Reconciler skipped — sell executor already recorded', {
              tradeId: trade.id,
              mint: trade.mint,
              existingSellId: existingSells[0]!.id,
              existingSignature: existingSells[0]!.signature,
            });
            // Still remove from position registry
            const pos = positionRegistry.get(trade.id);
            if (pos) {
              positionRegistry.transition(trade.id, 'EXITED', 'RECONCILED');
            }
            // Remove from monitoring + cleanup strategy-level state
            monitoredTrades.delete(trade.id);
            try { this.config.cleanupMint?.(trade.id, trade.mint); } catch { /* best-effort */ }
            continue;
          }

          logger.warn('Reconciling stale position — token gone from wallet', {
            tradeId: trade.id,
            mint: trade.mint,
          });

          // Save a synthetic SELL trade to DB
          await saveTrade(container, {
            id: `sell-${trade.id}`,
            mint: trade.mint,
            side: 'SELL',
            status: 'CONFIRMED',
            amountSol: 0n, // Unknown actual amount
            amountTokens: 0n,
            signature: null,
            slot: null,
            submittedAt: nowMs(),
            confirmedAt: nowMs(),
            failureReason: 'RECONCILED: token balance 0 in wallet (manual sell or stale DB)',
            exitReason: 'RECONCILED',
          });

          // Remove from position registry if present
          const pos = positionRegistry.get(trade.id);
          if (pos) {
            positionRegistry.transition(trade.id, 'EXITED', 'RECONCILED');

            // Record PnL (loss) and activate cooldown — prevents immediate re-buy
            try {
              const entrySolLamports = pos.entryAmountSol ?? 0n;
              const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
              const pnlUsd = -Number(entrySolLamports) / 1e9 * solPriceUsd; // 0 exit = full loss
              container.cooldownManager.activateCooldown();
              logger.info('Reconciler — cooldown activated after manual sell detection', {
                tradeId: trade.id,
                pnlUsd: pnlUsd.toFixed(4),
              });
            } catch {
              container.cooldownManager.activateCooldown();
            }
          }

          // Remove from monitoring + cleanup strategy-level state
          monitoredTrades.delete(trade.id);
          try { this.config.cleanupMint?.(trade.id, trade.mint); } catch { /* best-effort */ }

          reconciled += 1;
        }
      }

      if (reconciled > 0) {
        logger.info('Position reconciliation complete', { reconciled, total: openBuys.length });
      }
    } catch (err: unknown) {
      logger.error('Position reconciliation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
