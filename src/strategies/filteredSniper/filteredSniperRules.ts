/**
 * Filtered Sniper Rules
 *
 * LOCKED configuration values from rule.md (project constitution).
 * These values CANNOT be changed without explicit user approval.
 *
 * Duplicated constants are imported from core/constants/defaults.ts — the
 * single source of truth for all LOCKED rule.md values. Strategy-layer
 * names are re-exported for ergonomics.
 *
 * Convention: STOP_LOSS_PERCENT here is NEGATIVE (-50). In defaults.ts
 * DEFAULT_STOP_LOSS_PCT is POSITIVE (50) — we negate on import.
 *
 * Strategy = business logic ONLY. No RPC, no DB, no protocol decoding.
 */

import {
  DEFAULT_POSITION_SIZE_USD,
  DEFAULT_MIN_POSITION_SIZE_USD,
  DEFAULT_MAX_POSITION_SIZE_USD,
  DEFAULT_BASE_POSITION_SIZE_USD,
  DEFAULT_TAKE_PROFIT_PCT,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_TRAILING_ACTIVATION_PCT,
  DEFAULT_TRAILING_STOP_PCT,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONCURRENT_POSITIONS,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_MOMENTUM_MIN_BUYS,
  DEFAULT_MOMENTUM_WINDOW_SECONDS,
  DEFAULT_MOMENTUM_MIN_VOLUME_LAMPORTS,
  DEFAULT_CREATOR_HISTORY_WINDOW_SECONDS,
  DEFAULT_CREATOR_HISTORY_MAX_LAUNCHES,
  DEFAULT_MAX_PRICE_IMPACT_BPS,
  DEFAULT_SCALE_OUT_ENABLED,
  DEFAULT_SCALE_OUT_TIERS,
  DEFAULT_MIN_TOKEN_AGE_SECONDS,
  DEFAULT_MAX_BUY_MCAP_USD,
} from '../../core/constants/defaults.js';

// ---------------------------------------------------------------------------
// Entry Rules
// ---------------------------------------------------------------------------

/**
 * ALL 16 entry checks from rule.md. No shortcuts.
 *
 *   1. launch detected
 *   2. creator not blacklisted
 *   3. creator history acceptable
 *   4. mint authority safe
 *   5. freeze authority safe
 *   6. metadata sane
 *   7. liquidity sane
 *   8. wallet concentration acceptable
 *   9. momentum threshold met
 *  10. price impact acceptable
 */
export const ENTRY_CHECK_COUNT = 23;

/** Price impact rule: max price impact in basis points. LOCKED. */
export const MAX_PRICE_IMPACT_BPS = DEFAULT_MAX_PRICE_IMPACT_BPS;

/** Momentum rule: minimum buys in time window. LOCKED. */
export const MOMENTUM_MIN_BUYS = DEFAULT_MOMENTUM_MIN_BUYS;

/** Momentum rule: time window in seconds. LOCKED. */
export const MOMENTUM_WINDOW_SECONDS = DEFAULT_MOMENTUM_WINDOW_SECONDS;

/** Momentum rule: time window in milliseconds. */
export const MOMENTUM_WINDOW_MS = MOMENTUM_WINDOW_SECONDS * 1000;

/** Momentum rule: minimum buy volume in lamports. LOCKED. */
export const MOMENTUM_MIN_VOLUME_LAMPORTS = DEFAULT_MOMENTUM_MIN_VOLUME_LAMPORTS;

/** Creator history rule: lookback window in seconds. LOCKED. */
export const CREATOR_HISTORY_WINDOW_SECONDS = DEFAULT_CREATOR_HISTORY_WINDOW_SECONDS;

/** Creator history rule: lookback window in milliseconds. */
export const CREATOR_HISTORY_WINDOW_MS = CREATOR_HISTORY_WINDOW_SECONDS * 1000;

/** Creator history rule: max launches by the same creator in the lookback window. LOCKED. */
export const CREATOR_HISTORY_MAX_LAUNCHES = DEFAULT_CREATOR_HISTORY_MAX_LAUNCHES;

// ---------------------------------------------------------------------------
// Position Sizing Rules
// ---------------------------------------------------------------------------

/** Fixed position size in USD equivalent. LOCKED. */
export const POSITION_SIZE_USD = DEFAULT_POSITION_SIZE_USD;

/** Dynamic position sizing: minimum position size in USD. */
export const MIN_POSITION_SIZE_USD = DEFAULT_MIN_POSITION_SIZE_USD;

/** Dynamic position sizing: maximum position size in USD. */
export const MAX_POSITION_SIZE_USD = DEFAULT_MAX_POSITION_SIZE_USD;

/** Dynamic position sizing: base (center) position size in USD. */
export const BASE_POSITION_SIZE_USD = DEFAULT_BASE_POSITION_SIZE_USD;

// ---------------------------------------------------------------------------
// Exit Rules
// ---------------------------------------------------------------------------

/** Take profit percentage. LOCKED. */
export const TAKE_PROFIT_PERCENT = DEFAULT_TAKE_PROFIT_PCT;

/** Stop loss percentage (negative = loss). LOCKED. */
export const STOP_LOSS_PERCENT = -DEFAULT_STOP_LOSS_PCT;

/** Trailing stop percentage (drops from high to trigger). 0 = disabled. LOCKED. */
export const TRAILING_STOP_PCT = DEFAULT_TRAILING_STOP_PCT;

/** Trailing stop activation — starts trailing after this % profit. 0 = always active. LOCKED. */
export const TRAILING_ACTIVATION_PCT = DEFAULT_TRAILING_ACTIVATION_PCT;

/** Position timeout in seconds. LOCKED. */
export const TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS; // 60 minutes

/** Position timeout in milliseconds. */
export const TIMEOUT_MS = TIMEOUT_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Execution Rules
// ---------------------------------------------------------------------------

/** Entry venue: ALWAYS Pump.fun bonding curve. LOCKED. */
export const ENTRY_VENUE = 'PUMPFUN' as const; // Note: execution layer does its own venue detection for BonkFun

/** Max concurrent positions. LOCKED. */
export const MAX_CONCURRENT_POSITIONS = DEFAULT_MAX_CONCURRENT_POSITIONS;

/** Slippage in basis points. LOCKED. */
export const SLIPPAGE_BPS = DEFAULT_SLIPPAGE_BPS; // 5%

// ---------------------------------------------------------------------------
// Scale-Out Rules
// ---------------------------------------------------------------------------

/** Scale-out partial selling enabled. LOCKED. */
export const SCALE_OUT_ENABLED = DEFAULT_SCALE_OUT_ENABLED;

/** Scale-out tier definitions. LOCKED. */
export const SCALE_OUT_TIERS = DEFAULT_SCALE_OUT_TIERS;

// ---------------------------------------------------------------------------
// Entry Check Thresholds (LOCKED)
// ---------------------------------------------------------------------------

/** Check 3: Minimum creator score to pass (0-100). */
export const MIN_CREATOR_SCORE = 30;

/** Check 11: Maximum bundle percentage (0-100). */
export const MAX_BUNDLE_PCT = 40;

/** Check 12: Maximum wash trade score (0-100). */
export const MAX_WASH_TRADE_SCORE = 60;

/** Check 13: Minimum unique wallets in momentum window. */
export const MIN_UNIQUE_WALLETS = 10;

/** Check 14: Maximum sell ratio (sells as % of total trades). */
export const MAX_SELL_RATIO_PCT = 60;

/** Check 15: Minimum real SOL reserves in bonding curve (lamports). */
export const MIN_LIQUIDITY_DEPTH_LAMPORTS = 500_000_000n; // 0.5 SOL

/** Check 16: Holder-bundle ratio — max bundle % when holder count is low. */
export const HOLDER_BUNDLE_MAX_BUNDLE_PCT = 30;
export const HOLDER_BUNDLE_MAX_HOLDERS = 100;

/** Check 17: Minimum holder floor — auto-pass if >= this regardless of ratio. */
export const MIN_HOLDER_FLOOR = 30;

/** Check 18: Maximum volume-to-market-cap ratio. */
export const MAX_VOLUME_MCAP_RATIO = 5;

/** Check 22: Minimum average buy size in lamports (anti micro-buy spam). */
export const MIN_AVG_BUY_SIZE_LAMPORTS = 100_000_000n; // 0.1 SOL

/** Check 23: Minimum holder count (standalone, independent of bundle). */
export const MIN_HOLDER_COUNT = 20;

// ---------------------------------------------------------------------------
// Token Age & Market Cap Filters (LOCKED)
// ---------------------------------------------------------------------------

/**
 * Check 20: Minimum token age in seconds before entry.
 * Prevents buying tokens that are too fresh (bot chaos zone).
 * Data source: secondsSinceLaunch from EntryCheckData.
 */
export const MIN_TOKEN_AGE_SECONDS = DEFAULT_MIN_TOKEN_AGE_SECONDS;

/**
 * Check 21: Maximum market cap (USD) at entry.
 * Prevents buying tokens that have already pumped significantly.
 * Data source: marketCapUsd from EntryCheckData.
 */
export const MAX_BUY_MCAP_USD = DEFAULT_MAX_BUY_MCAP_USD;
