/**
 * RPC Sender
 *
 * Low-level transaction sending via Solana RPC.
 * Handles sendRawTransaction with proper options.
 *
 * CRITICAL: skipPreflight, maxRetries, and commitment settings
 * directly affect snipe speed and success rate.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import type { Connection, VersionedTransaction } from '@solana/web3.js';
import type { SendResult } from '../../core/types/execution.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:rpcSender');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** RPC send options. */
export interface RpcSendOptions {
  /**
   * Skip preflight simulation. Default: true for speed.
   * WARNING: setting true means you won't catch errors before tx lands on-chain.
   * For sniping, speed > safety, so we skip preflight.
   */
  readonly skipPreflight?: boolean;
  /** Max retries by the RPC node. Default: 3 (keeps exits from expiring before landing). */
  readonly maxRetries?: number;
  /** Preflight commitment. Default: 'processed'. */
  readonly preflightCommitment?: 'processed' | 'confirmed' | 'finalized';
}

/** Default send options optimized for speed. */
const DEFAULT_SEND_OPTIONS: Required<RpcSendOptions> = {
  skipPreflight: true,
  maxRetries: 3,
  preflightCommitment: 'processed',
};

// ---------------------------------------------------------------------------
// RpcSender
// ---------------------------------------------------------------------------

export class RpcSender {
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Send a signed transaction to the network.
   *
   * Returns the signature immediately (does NOT wait for confirmation).
   * Use ConfirmationTracker to wait for confirmation separately.
   */
  async send(
    tx: VersionedTransaction,
    _signer?: any, // Ignored — RpcSender doesn't need signer
    options?: RpcSendOptions,
  ): Promise<SendResult> {
    const opts = { ...DEFAULT_SEND_OPTIONS, ...options };
    const sentAt = nowMs();

    const serialized = tx.serialize();

    logger.debug('Sending transaction', {
      skipPreflight: opts.skipPreflight,
      maxRetries: opts.maxRetries,
      txSizeBytes: serialized.length,
    });

    const signature = await this.connection.sendRawTransaction(serialized, {
      skipPreflight: opts.skipPreflight,
      maxRetries: opts.maxRetries,
      preflightCommitment: opts.preflightCommitment,
    });

    logger.info('Transaction sent', {
      signature,
      sentAt,
      txSizeBytes: serialized.length,
    });

    return {
      signature,
      sentAt,
      slot: null, // Slot is only known after confirmation
    };
  }
}
