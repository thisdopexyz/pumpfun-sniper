/**
 * Transaction Builder
 *
 * Low-level transaction construction: creates a VersionedTransaction
 * with instructions, recent blockhash, and fee payer.
 *
 * CRITICAL: uses VersionedTransaction (v0) for all txs.
 * Legacy Transaction is NOT used — v0 supports ALTs and is required
 * for Jupiter swap instructions.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:txBuilder');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Blockhash provider — abstracts RPC getLatestBlockhash. */
export interface BlockhashProvider {
  getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

/** Build transaction params. */
export interface BuildTransactionParams {
  /** Fee payer public key. */
  readonly feePayer: PublicKey;
  /** Instructions to include. Order matters! */
  readonly instructions: readonly TransactionInstruction[];
  /** Recent blockhash. If null, fetched from provider. */
  readonly recentBlockhash?: string;
  /** Last valid block height for expiry tracking. */
  readonly lastValidBlockHeight?: number;
}

/** Build result. */
export interface BuildTransactionResult {
  readonly transaction: VersionedTransaction;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

// ---------------------------------------------------------------------------
// TxBuilder
// ---------------------------------------------------------------------------

export class TxBuilder {
  private readonly blockhashProvider: BlockhashProvider;

  constructor(blockhashProvider: BlockhashProvider) {
    this.blockhashProvider = blockhashProvider;
  }

  /**
   * Build a VersionedTransaction (v0) from instructions.
   *
   * Steps:
   *   1. Fetch latest blockhash (if not provided)
   *   2. Create TransactionMessage (v0)
   *   3. Compile to VersionedTransaction
   *
   * The returned transaction is UNSIGNED — call signer.signVersionedTransaction() next.
   */
  async build(params: BuildTransactionParams): Promise<BuildTransactionResult> {
    if (params.instructions.length === 0) {
      throw new Error('Cannot build transaction with 0 instructions');
    }

    let blockhash: string;
    let lastValidBlockHeight: number;

    if (params.recentBlockhash !== undefined && params.lastValidBlockHeight !== undefined) {
      blockhash = params.recentBlockhash;
      lastValidBlockHeight = params.lastValidBlockHeight;
    } else {
      const result = await this.blockhashProvider.getLatestBlockhash();
      blockhash = result.blockhash;
      lastValidBlockHeight = result.lastValidBlockHeight;
    }

    // Note: Jito tip is handled as a SEPARATE transaction in the bundle
    // by JitoSender, NOT as an instruction in the main TX.
    // This is the correct approach per Jito SDK documentation.

    // Create V0 message
    const messageV0 = new TransactionMessage({
      payerKey: params.feePayer,
      recentBlockhash: blockhash,
      instructions: params.instructions as TransactionInstruction[],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    logger.debug('Transaction built', {
      feePayer: params.feePayer.toBase58(),
      instructionCount: params.instructions.length,
      blockhash,
      lastValidBlockHeight,
    });

    return {
      transaction,
      blockhash,
      lastValidBlockHeight,
    };
  }
}
