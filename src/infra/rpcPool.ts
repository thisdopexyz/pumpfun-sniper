/**
 * Multi-RPC Pool with Round-Robin Selection
 *
 * Distributes RPC calls across multiple Helius endpoints to avoid
 * rate limiting and reduce per-endpoint load.
 *
 * Usage:
 *   const pool = new RpcPool(rpcUrls);
 *   const conn = pool.next(); // round-robin
 *   const conn = pool.best(); // lowest pending calls
 */

import { Connection } from '@solana/web3.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('infra:rpcPool');

interface PoolEntry {
  readonly connection: Connection;
  readonly url: string;
  pendingCalls: number;
  errorCount: number;
  lastErrorAt: number;
}

export class RpcPool {
  private readonly pool: PoolEntry[];
  private roundRobinIndex = 0;

  constructor(rpcUrls: readonly string[]) {
    if (rpcUrls.length === 0) {
      throw new Error('RpcPool requires at least one RPC URL');
    }

    this.pool = rpcUrls.map((url) => ({
      connection: new Connection(url, 'confirmed'),
      url,
      pendingCalls: 0,
      errorCount: 0,
      lastErrorAt: 0,
    }));

    logger.info('RpcPool initialized', {
      endpoints: this.pool.length,
      urls: this.pool.map(e => e.url.replace(/api-key=[^&]+/, 'api-key=***')),
    });
  }

  /**
   * Get the next connection via round-robin.
   * Skips endpoints with >5 recent errors (cooldown 60s).
   */
  next(): Connection {
    const entry = this.selectEntry();
    entry.pendingCalls++;
    return entry.connection;
  }

  /**
   * Get the connection with the fewest pending calls.
   * Best for concurrent workloads.
   */
  best(): Connection {
    // Initialize to first healthy entry, not blindly pool[0]
    let bestEntry: PoolEntry | null = null;
    for (const entry of this.pool) {
      if (this.isHealthy(entry)) {
        if (!bestEntry || entry.pendingCalls < bestEntry.pendingCalls) {
          bestEntry = entry;
        }
      }
    }
    // Fallback: all unhealthy, reset and use first
    if (!bestEntry) {
      for (const entry of this.pool) entry.errorCount = 0;
      bestEntry = this.pool[0]!;
    }
    bestEntry.pendingCalls++;
    return bestEntry.connection;
  }

  /**
   * Report a successful call (decrements pending).
   */
  reportSuccess(conn: Connection): void {
    const entry = this.pool.find(e => e.connection === conn);
    if (entry) {
      entry.pendingCalls = Math.max(0, entry.pendingCalls - 1);
      // Decay error count on success — recover from transient failures
      if (entry.errorCount > 0) entry.errorCount--;
    }
  }

  /**
   * Report a failed call (decrements pending, increments error count).
   */
  reportError(conn: Connection, _error: unknown): void {
    const entry = this.pool.find(e => e.connection === conn);
    if (entry) {
      entry.pendingCalls = Math.max(0, entry.pendingCalls - 1);
      entry.errorCount++;
      entry.lastErrorAt = Date.now();
    }
  }

  /**
   * Get pool stats for monitoring.
   */
  getStats(): { totalEndpoints: number; healthyEndpoints: number; totalPending: number } {
    const healthy = this.pool.filter(e => this.isHealthy(e)).length;
    const totalPending = this.pool.reduce((sum, e) => sum + e.pendingCalls, 0);
    return {
      totalEndpoints: this.pool.length,
      healthyEndpoints: healthy,
      totalPending,
    };
  }

  /**
   * Get all connections (for operations that need to try multiple).
   */
  getAll(): readonly Connection[] {
    return this.pool.map(e => e.connection);
  }

  /**
   * Get a specific connection by index.
   */
  get(index: number): Connection {
    return this.pool[index % this.pool.length]!.connection;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private selectEntry(): PoolEntry {
    // Try round-robin, skip unhealthy
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this.roundRobinIndex + i) % this.pool.length;
      const entry = this.pool[idx]!;
      if (this.isHealthy(entry)) {
        this.roundRobinIndex = (idx + 1) % this.pool.length;
        return entry;
      }
    }
    // All unhealthy — reset errors and return first
    for (const entry of this.pool) {
      entry.errorCount = 0;
    }
    return this.pool[0]!;
  }

  private isHealthy(entry: PoolEntry): boolean {
    if (entry.errorCount >= 5) {
      // Cooldown: 60 seconds after last error
      if (Date.now() - entry.lastErrorAt < 60_000) {
        return false;
      }
      // Reset after cooldown
      entry.errorCount = 0;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Factory: Build RpcPool from environment
// ---------------------------------------------------------------------------

/**
 * Build an RpcPool from Helius API keys in environment.
 * Reads HELIUS_API_KEY (primary) + HELIUS_EXTRA_KEYS (comma-separated).
 * Falls back to RPC_URL if no Helius keys found.
 */
export function buildRpcPoolFromEnv(): RpcPool {
  const urls: string[] = [];

  // Primary key
  const primaryKey = process.env['HELIUS_API_KEY'];
  if (primaryKey) {
    urls.push(`https://mainnet.helius-rpc.com/?api-key=${primaryKey}`);
  }

  // Extra keys
  const extraKeys = process.env['HELIUS_EXTRA_KEYS'];
  if (extraKeys) {
    for (const key of extraKeys.split(',')) {
      const trimmed = key.trim();
      if (trimmed) {
        urls.push(`https://mainnet.helius-rpc.com/?api-key=${trimmed}`);
      }
    }
  }

  // Fallback to RPC_URL
  if (urls.length === 0) {
    const rpcUrl = process.env['RPC_URL'] || process.env['HELIUS_RPC_URL'];
    if (rpcUrl) {
      urls.push(rpcUrl);
    }
  }

  // Fallback to public RPC
  if (urls.length === 0) {
    urls.push('https://api.mainnet-beta.solana.com');
  }

  return new RpcPool(urls);
}
