/**
 * Risk management defaults — daily kill switch, cooldown, anti-rug.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 */

// ---------------------------------------------------------------------------
// Daily kill switch & cooldown
// ---------------------------------------------------------------------------

/** Daily kill switch — LOCKED: -$40 */
export const DEFAULT_DAILY_KILL_LIMIT_USD = 40 as const;

/** Cooldown after exit — 2 minutes (120 seconds). Triggers on all exits except SCALE_OUT. */
export const DEFAULT_COOLDOWN_AFTER_SL_SECONDS = 10 as const;

// ---------------------------------------------------------------------------
// Anti-Rug Mechanism
// ---------------------------------------------------------------------------

/** Anti-rug monitor enabled by default. */
export const DEFAULT_ANTI_RUG_ENABLED = true as const;

/** Emergency exit if any top holder dumps > this % of total supply. */
export const DEFAULT_RUG_DUMP_THRESHOLD_PCT = 8 as const;

/** Emergency exit if ALL top 20 holders combined dump > this % of total supply. */
export const DEFAULT_RUG_CUMULATIVE_DUMP_THRESHOLD_PCT = 12 as const;

/** How often to poll top holders during an active position (ms). */
export const DEFAULT_RUG_CHECK_INTERVAL_MS = 2_000 as const;
