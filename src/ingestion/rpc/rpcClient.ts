/**
 * RPC Client — thin wrapper around @solana/web3.js Connection.
 * Ingestion layer only: no strategy / business logic.
 */

import {
  Connection,
  type AccountInfo,
  type Commitment,
  PublicKey,
} from '@solana/web3.js';

import { RpcError, RpcTimeoutError } from '../../core/errors/rpc.error.js';
import { recordRpcCall, recordRpcError } from '../../telemetry/metrics/ingestionMetrics.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import { RateLimiter } from './rateLimiter.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RpcClientConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly commitment: 'processed' | 'confirmed' | 'finalized';
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('rpc.client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnaborted');
  }
  return false;
}

function classifyError(err: unknown): string {
  if (isTimeoutError(err)) return 'timeout';
  if (err instanceof Error && err.message.toLowerCase().includes('rate')) return 'rate_limit';
  return 'unknown';
}

function wrapError(method: string, err: unknown): never {
  if (err instanceof RpcError) {
    throw err;
  }
  if (isTimeoutError(err)) {
    throw new RpcTimeoutError(`RPC timeout in ${method}: ${String(err)}`, { method });
  }
  throw new RpcError(
    `RPC error in ${method}: ${String(err)}`,
    'RPC_CALL_FAILED',
    { method },
  );
}

// -------------------------------------------------------------------
// Cache TTL for getLatestBlockhash. Blockhash is valid until
// lastValidBlockHeight (~60-90s on Solana), so a 15s cache is safe and
// cuts RPC call volume by ~10x during burst buy attempts.
// -------------------------------------------------------------------
const BLOCKHASH_CACHE_TTL_MS = 15_000;

// ---------------------------------------------------------------------------
// RpcClient
// ---------------------------------------------------------------------------

export class RpcClient {
  /** Blockhash cache TTL — applied per-instance. */
  static readonly BLOCKHASH_CACHE_TTL_MS = BLOCKHASH_CACHE_TTL_MS;

  private readonly connection: Connection;
  private readonly rateLimiter: RateLimiter;
  public readonly config: Readonly<RpcClientConfig>;

  // Blockhash cache — see getLatestBlockhash() for rationale.
  private cachedBlockhash: string | null = null;
  private cachedBlockhashAt: number = 0;
  private cachedBlockhashLastValidHeight: number = 0;
  private cachedBlockhashLastValidAt: number = 0;

  constructor(config: RpcClientConfig) {
    this.config = Object.freeze({ ...config });
    this.connection = new Connection(config.url, {
      commitment: config.commitment as Commitment,
      confirmTransactionInitialTimeout: config.timeoutMs,
    });
    this.rateLimiter = new RateLimiter();
  }

  /** Expose underlying Connection for advanced usage (websocket subscriptions etc.) */
  get raw(): Connection {
    return this.connection;
  }

  /** URL of this RPC endpoint. */
  get endpoint(): string {
    return this.config.url;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async getBalance(pubkey: PublicKey): Promise<bigint> {
    const method = 'getBalance';
    const start = nowMs();
    try {
      const lamports = await this.rateLimiter.execute(() =>
        this.connection.getBalance(pubkey, this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getBalance', { method, pubkey: pubkey.toBase58(), lamports });
      return BigInt(lamports);
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getBalance failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getSlot(): Promise<number> {
    const method = 'getSlot';
    const start = nowMs();
    try {
      const slot = await this.rateLimiter.execute(() =>
        this.connection.getSlot(this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getSlot', { method, slot });
      return slot;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getSlot failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getLatestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: number }> {
    const method = 'getLatestBlockhash';
    const start = nowMs();
    try {
      // Cache blockhash for BLOCKHASH_CACHE_TTL_MS. Solana blockhashes
      // are valid for ~60-90s (until lastValidBlockHeight), so a 15s
      // cache is safe and dramatically reduces RPC call volume during
      // burst buy attempts (e.g., 3 momentum signals within seconds).
      // Without this, the Helius free tier 429s because every buy
      // attempt triggers a fresh getLatestBlockhash + 6 other RPC
      // calls (mint/BC/metadata/largestAccounts/supply/slot).
      if (
        this.cachedBlockhash !== null &&
        nowMs() - this.cachedBlockhashAt < RpcClient.BLOCKHASH_CACHE_TTL_MS &&
        nowMs() < this.cachedBlockhashLastValidAt
      ) {
        return {
          blockhash: this.cachedBlockhash,
          lastValidBlockHeight: this.cachedBlockhashLastValidHeight,
        };
      }
      const result = await this.rateLimiter.execute(() =>
        this.connection.getLatestBlockhash(this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getLatestBlockhash', { method, blockhash: result.blockhash });
      // Only cache if lastValidBlockHeight gives us >= 30s of validity
      // (Solana produces ~2.5 slots/sec, so ~75 slots = 30s).
      this.cachedBlockhash = result.blockhash;
      this.cachedBlockhashAt = nowMs();
      this.cachedBlockhashLastValidHeight = result.lastValidBlockHeight;
      this.cachedBlockhashLastValidAt = result.lastValidBlockHeight * 400; // ~400ms/slot
      return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight };
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getLatestBlockhash failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async sendRawTransaction(tx: Buffer | Uint8Array): Promise<string> {
    const method = 'sendRawTransaction';
    const start = nowMs();
    try {
      const signature = await this.rateLimiter.execute(() =>
        this.connection.sendRawTransaction(tx, {
          skipPreflight: true,
          maxRetries: 0,
        }),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('sendRawTransaction', { method, signature });
      return signature;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('sendRawTransaction failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async confirmTransaction(
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
  ): Promise<boolean> {
    const method = 'confirmTransaction';
    const start = nowMs();
    try {
      const result = await this.rateLimiter.execute(() =>
        this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this.config.commitment as Commitment,
        ),
      );
      recordRpcCall(method, nowMs() - start);
      const confirmed = result.value.err === null;
      logger.debug('confirmTransaction', { method, signature, confirmed });
      return confirmed;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('confirmTransaction failed', { method, signature, err: String(err) });
      wrapError(method, err);
    }
  }

  async getAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    const method = 'getAccountInfo';
    const start = nowMs();
    try {
      const info = await this.rateLimiter.execute(() =>
        this.connection.getAccountInfo(pubkey, this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
logger.debug('getAccountInfo', { method, pubkey: pubkey.toBase58(), found: info !== null });
      return info;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getAccountInfo failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getTokenLargestAccounts(
    mint: PublicKey,
  ): Promise<{ readonly value: readonly { readonly address: PublicKey; readonly amount: string; readonly uiAmount: number | null; readonly uiAmountString?: string; readonly decimals: number }[] } | null> {
    const method = 'getTokenLargestAccounts';
    const start = nowMs();
    try {
      const result = await this.rateLimiter.execute(() =>
        this.connection.getTokenLargestAccounts(mint, this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      return result;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getTokenLargestAccounts failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getTokenSupply(
    mint: PublicKey,
  ): Promise<{ readonly context: { readonly slot: number }; readonly value: { readonly amount: string; readonly decimals: number; readonly uiAmount: number | null; readonly uiAmountString?: string } } | null> {
    const method = 'getTokenSupply';
    const start = nowMs();
    try {
      const result = await this.rateLimiter.execute(() =>
        this.connection.getTokenSupply(mint, this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      return result;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getTokenSupply failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getMultipleAccountsInfo(
    pubkeys: readonly PublicKey[],
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const method = 'getMultipleAccountsInfo';
    const start = nowMs();
    try {
      const mutableKeys = [...pubkeys];
      const infos = await this.rateLimiter.execute(() =>
        this.connection.getMultipleAccountsInfo(
          mutableKeys,
          this.config.commitment as Commitment,
        ),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getMultipleAccountsInfo', { method, count: pubkeys.length });
      return infos;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getMultipleAccountsInfo failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  async isHealthy(): Promise<boolean> {
    try {
      await this.rateLimiter.execute(() =>
        this.connection.getSlot(this.config.commitment as Commitment),
      );
      return true;
    } catch (_err: unknown) {
      logger.warn('Health check failed', { endpoint: this.endpoint });
      return false;
    }
  }
}
