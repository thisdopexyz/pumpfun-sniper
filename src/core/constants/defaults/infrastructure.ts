/**
 * Infrastructure defaults — RPC, database pool, WebSocket, compute budget, SOL price oracle, logging.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 */

import type { ComputeBudgetParams } from '../../types/execution.js';

// ---------------------------------------------------------------------------
// SOL Price Oracle
// ---------------------------------------------------------------------------

/** Fallback SOL/USD price if all sources fail. Updated 2026-05-29. */
export const SOL_FALLBACK_PRICE_USD = 150 as const; // Updated 2026-05-29 — was $85, real ~$150-180

/** Jupiter Price API for SOL. */
export const JUPITER_PRICE_URL = 'https://price.jup.ag/v6/price?ids=SOL' as const;

/** CoinGecko fallback for SOL price. */
export const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd' as const;

/** Price request timeout in milliseconds. */
export const PRICE_REQUEST_TIMEOUT_MS = 5_000 as const;

/** Price cache TTL in milliseconds (60 seconds). */
export const PRICE_CACHE_TTL_MS = 60_000 as const;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Default log level */
export const DEFAULT_LOG_LEVEL = 'info' as const;

// ---------------------------------------------------------------------------
// Transaction retries
// ---------------------------------------------------------------------------

/** Max transaction retry attempts */
export const DEFAULT_MAX_TX_RETRIES = 2 as const;

/** Delay between transaction retries in ms */
export const DEFAULT_TX_RETRY_DELAY_MS = 1_000 as const;

// ---------------------------------------------------------------------------
// RPC defaults
// ---------------------------------------------------------------------------

/** Helius RPC base URL. */
export const DEFAULT_HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com' as const;

/** Alchemy RPC base URL. */
export const DEFAULT_ALCHEMY_RPC_BASE = 'https://solana-mainnet.g.alchemy.com/v2' as const;

/** Helius RPC timeout (ms). */
export const DEFAULT_RPC_HELIUS_TIMEOUT_MS = 10_000 as const;

/** PublicNode RPC timeout (ms) — public = slower, give more time. */
export const DEFAULT_RPC_PUBLICNODE_TIMEOUT_MS = 15_000 as const;

/** Alchemy RPC timeout (ms). */
export const DEFAULT_RPC_ALCHEMY_TIMEOUT_MS = 12_000 as const;

// ---------------------------------------------------------------------------
// Database pool defaults
// ---------------------------------------------------------------------------

/** PostgreSQL max pool connections. */
export const DEFAULT_DB_MAX_CONNECTIONS = 5 as const;

/** PostgreSQL idle timeout (ms). */
export const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000 as const;

/** PostgreSQL connection timeout (ms). */
export const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 10_000 as const;

// ---------------------------------------------------------------------------
// WebSocket connection defaults
// ---------------------------------------------------------------------------

/** Maximum number of consecutive reconnection attempts before giving up. */
export const DEFAULT_WS_MAX_RETRIES = 10 as const;

/** Base delay for exponential backoff (ms). */
export const DEFAULT_WS_BASE_DELAY_MS = 5_000 as const;

/** Maximum delay between retries (ms). */
export const DEFAULT_WS_MAX_DELAY_MS = 60_000 as const;

/** WebSocket connection timeout (ms). */
export const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000 as const;

// ---------------------------------------------------------------------------
// Execution tuning
// ---------------------------------------------------------------------------

/** Minimum SOL balance to allow a trade (lamports). 0.005 SOL. */
export const DEFAULT_MIN_TRADE_BALANCE_LAMPORTS = 5_000_000n as const;

/** Exit monitor poll interval in ms. */
export const DEFAULT_EXIT_MONITOR_POLL_MS = 1_000 as const;

// ---------------------------------------------------------------------------
// Compute budget defaults
// ---------------------------------------------------------------------------

/** Default compute budget for Pump.fun buy/sell (generous). */
export const DEFAULT_PUMPFUN_COMPUTE_BUDGET: ComputeBudgetParams = {
  computeUnitLimit: 200_000,
  computeUnitPrice: 700_000n, // 2x dari 350k, fee ~$0.02/tx
} as const;

/** Default compute budget for Jupiter swap (higher CU needed). */
export const DEFAULT_JUPITER_COMPUTE_BUDGET: ComputeBudgetParams = {
  computeUnitLimit: 400_000,
  computeUnitPrice: 200_000n,
} as const;
