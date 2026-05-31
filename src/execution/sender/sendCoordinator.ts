/**
 * Send Coordinator
 *
 * Coordinates the full send flow: build → sign → send → track.
 * Handles duplicate prevention (no double-sends for same trade).
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import type { VersionedTransaction } from '@solana/web3.js';
import type { ISigner } from '../../core/interfaces/signer.js';
import type { SendResult } from '../../core/types/execution.js';
import type { RpcSender } from './rpcSender.js';
import type { JitoSender } from './jitoSender.js';
import { DedupeSet } from '../../core/utils/dedupe.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:sendCoordinator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique trade identifier for deduplication. */
export type TradeId = string;

/** Send request. */
export interface SendRequest {
  /** Unique trade ID for deduplication. */
  readonly tradeId: TradeId;
  /** Unsigned transaction to sign and send. */
  readonly transaction: VersionedTransaction;
}

/** Send coordinator result. */
export interface SendCoordinatorResult {
  readonly sendResult: SendResult | null;
  readonly tradeId: TradeId;
  /** Whether this was a duplicate (already sent). */
  readonly isDuplicate: boolean;
  /** Error if send failed. */
  readonly error: string | null;
}

/** Configuration. */
export interface SendCoordinatorConfig {
  /** Dedupe TTL in ms. Default: 30_000 (30 seconds). */
  readonly dedupeTtlMs?: number;
}

// ---------------------------------------------------------------------------
// SendCoordinator
// ---------------------------------------------------------------------------

export class SendCoordinator {
  private readonly signer: ISigner;
  private readonly sender: RpcSender | JitoSender;
  private readonly fallbackSender: RpcSender | null;
  private readonly dedupe: DedupeSet;

  constructor(
    signer: ISigner,
    sender: RpcSender | JitoSender,
    config?: SendCoordinatorConfig,
    fallbackSender?: RpcSender,
  ) {
    this.signer = signer;
    this.sender = sender;
    this.fallbackSender = fallbackSender ?? null;
    this.dedupe = new DedupeSet(config?.dedupeTtlMs ?? 30_000);
  }

  /**
   * Sign and send a transaction with deduplication.
   *
   * Flow:
   *   1. Check deduplication (skip if already sent)
   *   2. Sign transaction
   *   3. Send via RPC
   *   4. Return result
   */
  async signAndSend(request: SendRequest): Promise<SendCoordinatorResult> {
    // Dedup check
    if (this.dedupe.isDuplicate(request.tradeId)) {
      logger.warn('Duplicate trade detected, skipping', {
        tradeId: request.tradeId,
      });
      return {
        sendResult: null,
        tradeId: request.tradeId,
        isDuplicate: true,
        error: `Duplicate trade detected for ${request.tradeId}`,
      };
    }

    try {
      // Sign
      const signed = await this.signer.signVersionedTransaction(request.transaction);

      // Try primary sender (Jito)
      try {
        // JitoSender needs signer to sign the tip transaction
        const sendResult = await this.sender.send(signed, this.signer);

        logger.info('Trade sent successfully', {
          tradeId: request.tradeId,
          signature: sendResult.signature,
          sender: this.sender.constructor.name,
        });

        return {
          sendResult,
          tradeId: request.tradeId,
          isDuplicate: false,
          error: null,
        };
      } catch (primaryError: unknown) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        
        // If primary sender (Jito) fails and fallback exists, try fallback
        if (this.fallbackSender) {
          logger.warn('Primary sender failed, trying fallback', {
            tradeId: request.tradeId,
            primaryError: primaryMessage,
            fallbackSender: this.fallbackSender.constructor.name,
          });

          try {
            const sendResult = await this.fallbackSender.send(signed);

            logger.info('Trade sent via fallback', {
              tradeId: request.tradeId,
              signature: sendResult.signature,
              sender: 'RpcSender (fallback)',
            });

            return {
              sendResult,
              tradeId: request.tradeId,
              isDuplicate: false,
              error: null,
            };
          } catch (fallbackError: unknown) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            throw new Error(`Both senders failed. Primary: ${primaryMessage}, Fallback: ${fallbackMessage}`);
          }
        }

        // No fallback available, re-throw primary error
        throw primaryError;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to sign and send', {
        tradeId: request.tradeId,
        err: message,
      });
      return {
        sendResult: null,
        tradeId: request.tradeId,
        isDuplicate: false,
        error: message,
      };
    }
  }

  /**
   * Destroy the coordinator (cleanup dedupe timer).
   */
  destroy(): void {
    this.dedupe.destroy();
  }
}
