/**
 * Detection & entry-filter defaults — momentum, creator history, metadata checks, wallet concentration.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 */

// ---------------------------------------------------------------------------
// Momentum entry filter
// ---------------------------------------------------------------------------

/** Momentum entry filter — minimum buy count in the configured window */
export const DEFAULT_MOMENTUM_MIN_BUYS = 15 as const;

/** Momentum entry filter — LOCKED: buy-count window in seconds */
export const DEFAULT_MOMENTUM_WINDOW_SECONDS = 30 as const;

/** Momentum entry filter — LOCKED: minimum buy volume in lamports */
export const DEFAULT_MOMENTUM_MIN_VOLUME_LAMPORTS = 10_000_000_000n as const;

/** Momentum detector cooldown per mint in ms before re-emitting */
export const DEFAULT_MOMENTUM_COOLDOWN_MS = 60_000 as const;

/** Momentum detector max tokens to track simultaneously */
export const DEFAULT_MOMENTUM_MAX_TRACKED_TOKENS = 500 as const;

/**
 * Sell pressure window in seconds — LONGER than momentum window (10s).
 * Keeps sells for 60s so Check 14 can detect dumps that happened
 * just before the momentum signal fired.
 */
export const SELL_PRESSURE_WINDOW_SECONDS = 60 as const;

// ---------------------------------------------------------------------------
// Creator history entry filter
// ---------------------------------------------------------------------------

/** Creator history entry filter — LOCKED: lookback window in seconds */
export const DEFAULT_CREATOR_HISTORY_WINDOW_SECONDS = 3_600 as const;

/** Creator history entry filter — LOCKED: max recent launches by same creator */
export const DEFAULT_CREATOR_HISTORY_MAX_LAUNCHES = 3 as const;

// ---------------------------------------------------------------------------
// Bonding-curve reserves
// ---------------------------------------------------------------------------

/** Minimum virtual SOL reserves on bonding curve (0.1 SOL) */
export const DEFAULT_MIN_SOL_RESERVES = 100_000_000n as const;

/** Minimum virtual token reserves on bonding curve */
export const DEFAULT_MIN_TOKEN_RESERVES = 1_000_000n as const;

// ---------------------------------------------------------------------------
// Metadata quality checks
// ---------------------------------------------------------------------------

/** Minimum acceptable token name length */
export const DEFAULT_MIN_NAME_LENGTH = 1 as const;

/** Maximum acceptable token name length */
export const DEFAULT_MAX_NAME_LENGTH = 50 as const;

/** Minimum acceptable token symbol length */
export const DEFAULT_MIN_SYMBOL_LENGTH = 1 as const;

/** Maximum acceptable token symbol length */
export const DEFAULT_MAX_SYMBOL_LENGTH = 12 as const;

/** Scam patterns in token names/symbols (case-insensitive, financial scams) */
export const DEFAULT_METADATA_SCAM_PATTERNS: readonly RegExp[] = [
  /\brug\b/i, /\bscam\b/i, /\bhoneypot\b/i, /\bponzi\b/i, /\bfake\b/i,
  /airdrop.*claim/i, /connect.*wallet/i, /seed.*phrase/i,
  /private.*key/i, /send.*sol.*back/i, /\bdoubler\b/i,
  /\bguaranteed\b/i, /free.*sol/i,
] as const;

/** Structural metadata patterns (keyboard mash, test, repeated chars) */
export const DEFAULT_METADATA_STRUCTURAL_PATTERNS: readonly RegExp[] = [
  /^\s*$/,        // Whitespace-only name
  /^test\d*$/i,   // "test", "test123"
  /^asdf/i,       // Keyboard mash
  /^aaa+$/i,      // Repeated characters
] as const;

// ---------------------------------------------------------------------------
// Token age entry filter
// ---------------------------------------------------------------------------

/**
 * Minimum token age in seconds before allowing entry.
 * Prevents buying tokens that are too fresh — first few seconds are chaotic
 * bot territory with no organic activity. Gives time for initial dust to settle.
 *
 * Rationale: 30s is enough for the first wave of organic buyers to show up,
 * while still catching tokens early in their lifecycle.
 */
export const DEFAULT_MIN_TOKEN_AGE_SECONDS = 1200 as const;

// ---------------------------------------------------------------------------
// Market cap entry filter
// ---------------------------------------------------------------------------

/**
 * Maximum market cap (USD) at entry time.
 * Prevents buying tokens that have already pumped significantly.
 * For a $0.23 position, tokens above $50k mcap offer diminishing returns.
 *
 * PumpFun bonding curve context:
 *   - Graduation to Raydium happens ~$69k mcap
 *   - Sweet spot for sniping: $5k-$30k mcap
 *   - Above $50k = likely already on Raydium or about to graduate
 */
export const DEFAULT_MAX_BUY_MCAP_USD = 25_000 as const;

// ---------------------------------------------------------------------------
// Wallet concentration
// ---------------------------------------------------------------------------

/** Wallet concentration: max % top N holders can own (0-100) */
export const DEFAULT_MAX_WALLET_CONCENTRATION_PCT = 75 as const;

/** Wallet concentration: number of top holders to check */
export const DEFAULT_WALLET_CONCENTRATION_TOP_N = 5 as const;
