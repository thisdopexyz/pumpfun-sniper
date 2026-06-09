/**
 * Strategy type definitions.
 *
 * Decision outcomes from strategy layer. Pure data shapes.
 */

// MintAddress and SignalId imports removed — ExitDecisionResult moved to exitDecision.ts

/** Reason for skipping entry */
export type SkipReason =
  | 'CREATOR_BLACKLISTED'
  | 'CREATOR_HISTORY_BAD'
  | 'MINT_AUTHORITY_UNSAFE'
  | 'FREEZE_AUTHORITY_UNSAFE'
  | 'METADATA_INVALID'
  | 'LIQUIDITY_INSUFFICIENT'
  | 'WALLET_CONCENTRATION_HIGH'
  | 'MOMENTUM_INSUFFICIENT'
  | 'RISK_LIMIT_REACHED'
  | 'COOLDOWN_ACTIVE'
  | 'MAX_CONCURRENT_REACHED'
  | 'DAILY_KILL_TRIGGERED';

/**
 * Entry decision result — canonical definition lives in
 * strategies/filteredSniper/entryDecision.ts (EntryDecisionResult).
 * Removed from here to avoid type mismatch. Import from entryDecision.ts.
 */

/** Exit reason */
export type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'BREAKEVEN_SL' | 'TRAILING_STOP' | 'TIMEOUT' | 'KILL_SWITCH' | 'MANUAL' | 'GRADUATED' | 'ANTI_RUG' | 'SCALE_OUT' | 'SOL_FLOOR' | 'NONE';

/**
 * Exit decision result — canonical definition lives in
 * strategies/filteredSniper/exitDecision.ts (ExitDecisionResult).
 * Removed from here to avoid duplicate type definition.
 * Import from exitDecision.ts for the actual type.
 */
