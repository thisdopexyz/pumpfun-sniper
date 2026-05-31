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

/** Position sizing — base $0.20 equivalent (used directly by strategy) */
export const DEFAULT_POSITION_SIZE_USD = 0.2 as const;

/** Dynamic position sizing — minimum $0.20 */
export const DEFAULT_MIN_POSITION_SIZE_USD = 0.2 as const;

/** Dynamic position sizing — maximum $0.20 */
export const DEFAULT_MAX_POSITION_SIZE_USD = 0.2 as const;

/** Dynamic position sizing — base (center) $0.20 */
export const DEFAULT_BASE_POSITION_SIZE_USD = 0.2 as const;

// ---------------------------------------------------------------------------
// Take profit / Stop loss / Trailing
// ---------------------------------------------------------------------------

/** Take profit — LOCKED: +1500% */
export const DEFAULT_TAKE_PROFIT_PCT = 1500 as const;

/** Stop loss — LOCKED: -80% */
export const DEFAULT_STOP_LOSS_PCT = 80 as const;

/** Trailing stop — activates after this % profit from entry. 0 = always active. */
export const DEFAULT_TRAILING_ACTIVATION_PCT = 100 as const;

/** Trailing stop — drops this % from highest price to trigger sell. 0 = disabled. */
export const DEFAULT_TRAILING_STOP_PCT = 50 as const;

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
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 500 as const;

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
 *   +100% → sell 50% of position
 *   +300% → sell 25% of position
 *   Remaining rides with trailing stop.
 */
export const DEFAULT_SCALE_OUT_TIERS: ReadonlyArray<{ readonly triggerPct: number; readonly sellPct: number }> = [
  { triggerPct: 100, sellPct: 50 },   // +100% → sell 50%
  { triggerPct: 300, sellPct: 25 },   // +300% → sell 25% (NEW)
  { triggerPct: 500, sellPct: 15 },   // +500% → sell 15%
] as const;
