/**
 * Trading defaults — position sizing, TP/SL, trailing stop, scale-out, slippage, price impact.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 *
 * Convention: DEFAULT_STOP_LOSS_PCT is POSITIVE (50). The exit evaluator
 * negates it internally: `pnlPercent <= -stopLossPct`. In contrast,
 * filteredSniperRules.STOP_LOSS_PERCENT is NEGATIVE (-50).
 *
 * NOTE on position sizing:
 *   The deployed bot uses a FIXED $0.20 position size (POSITION_SIZE_USD).
 *   The dynamic sizer (BASE/MIN/MAX) is currently a no-op — its bounds all
 *   equal $0.20 so any combination of multipliers produces $0.20. This is
 *   intentional for $0.20 micro-positions where dynamic sizing adds
 *   complexity without meaningful dollar impact. If you want to re-enable
 *   dynamic sizing, set MIN < BASE < MAX and wire the sizer in main.ts.
 */

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

/** Position sizing — $0.50 fixed (used directly by strategy when no sizer wired). */
export const DEFAULT_POSITION_SIZE_USD = 0.50 as const;

/** Dynamic position sizing bounds — currently equal to POSITION_SIZE_USD ($0.50). */
/** @see comment above — sizer is no-op until MIN < BASE < MAX. */
export const DEFAULT_MIN_POSITION_SIZE_USD = 0.50 as const;
export const DEFAULT_MAX_POSITION_SIZE_USD = 0.50 as const;
export const DEFAULT_BASE_POSITION_SIZE_USD = 0.50 as const;

// ---------------------------------------------------------------------------
// Take profit / Stop loss / Trailing
// ---------------------------------------------------------------------------

/** Take profit — LOCKED: +9900% (100x) */
export const DEFAULT_TAKE_PROFIT_PCT = 9900 as const;

/** Stop loss — LOCKED: -50% */
export const DEFAULT_STOP_LOSS_PCT = 50 as const;

/** Trailing stop — activates after this % profit from entry. 0 = always active. */
export const DEFAULT_TRAILING_ACTIVATION_PCT = 200 as const;

/** Trailing stop — drops this % from highest price to trigger sell. 0 = disabled. */
export const DEFAULT_TRAILING_STOP_PCT = 55 as const;

// ---------------------------------------------------------------------------
// Timeouts & concurrency
// ---------------------------------------------------------------------------

/** Timeout — LOCKED: 6 hours (21600 seconds) */
export const DEFAULT_TIMEOUT_SECONDS = 21600 as const;

/** Maximum number of concurrent open positions. Set to 1 per user config 2026-06-28. */
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 1 as const;

// ---------------------------------------------------------------------------
// Slippage & price impact
// ---------------------------------------------------------------------------

/** Default slippage in basis points */
export const DEFAULT_SLIPPAGE_BPS = 500 as const;

/** Max price impact before buy — LOCKED: 700 bps (7%).
 *
 *  NOTE (2026-06-23): For $0.20 positions on pump.fun BC (virtualSolReserves
 *  starts at 30 SOL = 3e10 lamports), actual impact is always < 50 bps.
 *  This check only fires when virtualSolReserves < 0.14 SOL (near graduation
 *  when BC has been heavily bought). Acts as a graduation safety net to avoid
 *  entering with massive slippage right before BC drains.
 *
 *  If you tighten below 500 bps, expect this to NEVER block for $0.20 positions.
 *  If you loosen above 1000 bps, the check becomes purely a no-op.
 */
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
