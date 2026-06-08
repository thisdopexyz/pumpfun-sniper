/**
 * Trading defaults — position sizing, TP/SL, trailing stop, scale-out, slippage, price impact.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 *
 * Convention: DEFAULT_STOP_LOSS_PCT is POSITIVE (50). The exit evaluator
 * negates it internally: `pnlPercent <= -stopLossPct`. In contrast,
 * filteredSniperRules.STOP_LOSS_PERCENT is NEGATIVE (-50).
 */

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

/** Position sizing — base $1.00 equivalent (used directly by strategy) */
export const DEFAULT_POSITION_SIZE_USD = 1.0 as const;

/** Dynamic position sizing — minimum $1.00 */
export const DEFAULT_MIN_POSITION_SIZE_USD = 1.0 as const;

/** Dynamic position sizing — maximum $1.00 */
export const DEFAULT_MAX_POSITION_SIZE_USD = 1.0 as const;

/** Dynamic position sizing — base (center) $1.00 */
export const DEFAULT_BASE_POSITION_SIZE_USD = 1.0 as const;

// ---------------------------------------------------------------------------
// Take profit / Stop loss / Trailing
// ---------------------------------------------------------------------------

/** Take profit — LOCKED: +100000% */
export const DEFAULT_TAKE_PROFIT_PCT = 100000 as const;

/** Stop loss — LOCKED: -50% */
export const DEFAULT_STOP_LOSS_PCT = 50 as const;

/** Trailing stop — activates after this % profit from entry. 0 = always active. */
export const DEFAULT_TRAILING_ACTIVATION_PCT = 200 as const;

/** Trailing stop — drops this % from highest price to trigger sell. 0 = disabled. */
export const DEFAULT_TRAILING_STOP_PCT = 30 as const;

// ---------------------------------------------------------------------------
// Timeouts & concurrency
// ---------------------------------------------------------------------------

/** Timeout — LOCKED: 6 hours (21600 seconds) */
export const DEFAULT_TIMEOUT_SECONDS = 21600 as const;

/** Max concurrent positions — 1 */
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 1 as const;

// ---------------------------------------------------------------------------
// Slippage & price impact
// ---------------------------------------------------------------------------

/** Default slippage in basis points */
export const DEFAULT_SLIPPAGE_BPS = 500 as const;

/** Max price impact before buy — LOCKED: 500 bps (5%) */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 700 as const;

// ---------------------------------------------------------------------------
// Scale-Out Exit Strategy
// ---------------------------------------------------------------------------

/** Scale-out partial selling — enabled by default. */
export const DEFAULT_SCALE_OUT_ENABLED = true as const;

/**
 * Scale-out tiers. Each tier defines a profit-percentage trigger and the
 * percentage of the current token balance to sell at that trigger.
 *
 * Default tiers:
 *   +100%  → sell 50% of position
 *   +300%  → sell 10% of position
 *   +500%  → sell 10% of position
 *   +1000% → sell 5% of position
 *   Remaining rides with trailing stop.
 */
export const DEFAULT_SCALE_OUT_TIERS: ReadonlyArray<{ readonly triggerPct: number; readonly sellPct: number }> = [
  { triggerPct: 100, sellPct: 50 },    // +100%  → sell 50%
  { triggerPct: 300, sellPct: 20 },    // +300%  → sell 20%
] as const;
