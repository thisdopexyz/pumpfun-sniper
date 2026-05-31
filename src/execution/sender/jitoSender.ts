/**
 * Jito Bundle Sender
 *
 * Low-level transaction sending via Jito block engine.
 * Submits transactions as bundles for MEV protection and faster inclusion.
 *
 * Key findings from research:
 * - Jito expects base58 encoding (NOT base64!)
 * - Tip must be a SEPARATE transaction in the bundle
 * - Bundle = [mainTx_base58, tipTx_base58]
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import {
  VersionedTransaction,
  Transaction,
  SystemProgram,
  PublicKey,
  Connection,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { SendResult } from '../../core/types/execution.js';
import type { ISigner } from '../../core/interfaces/signer.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:jitoSender');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Jito send options. */
export interface JitoSendOptions {
  /** Tip amount in lamports. Default: 100000 (0.0001 SOL). */
  readonly tipLamports?: number;
  /** Bundle submission timeout in ms. Default: 5000. */
  readonly timeoutMs?: number;
}

/** Default Jito send options. */
const DEFAULT_JITO_OPTIONS: Required<JitoSendOptions> = {
  tipLamports: 100_000,
  timeoutMs: 5_000,
};

/** Jito tip accounts (randomly selected per transaction). */
const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
];

/** Jito block engine endpoints. */
const JITO_ENDPOINTS = {
  mainnet: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  testnet: 'https://testnet.block-engine.jito.wtf/api/v1/bundles',
};

// ---------------------------------------------------------------------------
// JitoSender
// ---------------------------------------------------------------------------

export class JitoSender {
  private readonly endpoint: string;
  private readonly defaultOptions: Required<JitoSendOptions>;
  private readonly connection: Connection;

  constructor(
    connection: Connection,
    network: 'mainnet' | 'testnet' = 'mainnet',
    options?: JitoSendOptions,
  ) {
    this.connection = connection;
    this.endpoint = JITO_ENDPOINTS[network];
    this.defaultOptions = { ...DEFAULT_JITO_OPTIONS, ...options };
  }

  /**
   * Send a signed transaction via Jito bundle.
   *
   * Flow:
   * 1. Get recent blockhash
   * 2. Create tip transaction (SEPARATE from main TX)
   * 3. Sign tip transaction with the same signer
   * 4. Serialize both to base58
   * 5. Submit as bundle: [mainTx_base58, tipTx_base58]
   * 6. Return signature from main TX
   */
  async send(
    tx: VersionedTransaction,
    signer: ISigner,
    options?: JitoSendOptions,
  ): Promise<SendResult> {
    const opts = { ...this.defaultOptions, ...options };
    const sentAt = nowMs();

    // Get payer from the main transaction
    const payer = this.extractPayer(tx);
    if (!payer) {
      throw new Error('Cannot extract payer from transaction');
    }

    // Create tip transaction (SEPARATE from main TX)
    const tipTx = await this.createTipTransaction(payer, opts.tipLamports);

    // Sign tip transaction with the same signer
    const signedTipTx = await signer.signTransaction(tipTx);

    // Serialize both to base58 (NOT base64!)
    const mainBase58 = bs58.encode(tx.serialize());
    const tipBase58 = bs58.encode(signedTipTx.serialize());

    logger.debug('Sending via Jito bundle', {
      endpoint: this.endpoint,
      tipLamports: opts.tipLamports,
      mainTxSize: mainBase58.length,
      tipTxSize: tipBase58.length,
    });

    // Submit bundle
    const bundleResult = await this.submitBundle([mainBase58, tipBase58], opts);

    if (bundleResult.error) {
      logger.error('Jito bundle submission failed', {
        error: bundleResult.error,
        tipLamports: opts.tipLamports,
      });
      throw new Error(`Jito bundle failed: ${bundleResult.error}`);
    }

    const bundleId = bundleResult.bundleId;
    logger.info('Jito bundle submitted', {
      bundleId,
      tipLamports: opts.tipLamports,
      sentAt,
    });

    // Extract signature from main transaction
    const signature = this.extractSignature(tx);

    return {
      signature,
      sentAt,
      slot: null, // Slot is only known after confirmation
    };
  }

  /**
   * Create a tip transaction (separate from main TX).
   */
  private async createTipTransaction(
    payer: PublicKey,
    tipLamports: number,
  ): Promise<Transaction> {
    const tipAccount = new PublicKey(JitoSender.getRandomTipAccount());
    const { blockhash } = await this.connection.getLatestBlockhash();

    const tipTx = new Transaction();
    tipTx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    );
    tipTx.recentBlockhash = blockhash;
    tipTx.feePayer = payer;

    return tipTx;
  }

  /**
   * Submit a bundle to Jito block engine.
   */
  private async submitBundle(
    transactions: string[],
    opts: Required<JitoSendOptions>,
  ): Promise<{ bundleId: string | null; error: string | null }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [transactions],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const result = await response.json() as { error?: { message?: string }; result?: string };

      if (result.error) {
        return { bundleId: null, error: result.error.message || JSON.stringify(result.error) };
      }

      return { bundleId: result.result || null, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { bundleId: null, error: message };
    }
  }

  /**
   * Extract signature from a signed transaction.
   */
  private extractSignature(tx: VersionedTransaction): string {
    try {
      const sig = tx.signatures[0];
      if (sig) {
        return bs58.encode(sig);
      }
    } catch {
      // Fallback
    }
    return 'jito-bundle-pending';
  }

  /**
   * Extract payer public key from transaction.
   */
  private extractPayer(tx: VersionedTransaction): PublicKey | null {
    try {
      const accountKeys = tx.message.staticAccountKeys;
      if (accountKeys && accountKeys.length > 0) {
        return accountKeys[0] ?? null;
      }
    } catch {
      // Fallback
    }
    return null;
  }

  /**
   * Get a random Jito tip account.
   */
  static getRandomTipAccount(): string {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[index]!;
  }

  /**
   * Get all Jito tip accounts.
   */
  static getTipAccounts(): readonly string[] {
    return JITO_TIP_ACCOUNTS;
  }
}
