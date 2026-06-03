/**
 * Entry Decision
 *
 * Evaluates ALL 21 entry checks from rule.md before allowing a buy.
 * Every single check must pass. No shortcuts. No partial passes.
 *
 * The 21 checks (from rule.md):
 *   1. Launch detected
 *   2. Creator not blacklisted
 *   3. Creator history acceptable
 *   4. Mint authority safe (revoked)
 *   5. Freeze authority safe (revoked)
 *   6. Metadata sane
 *   7. Liquidity sane
 *   8. Wallet concentration acceptable
 *   9. Momentum threshold met
 *  10. Price impact acceptable
 *  11. Bundle percentage acceptable
 *  12. Wash trade score acceptable
 *  13. Unique wallets sufficient
 *  14. Sell pressure acceptable (early dump detection)
 *  15. Liquidity depth sufficient (real SOL reserves)
 *  16. Holder-to-bundle ratio acceptable
 *  17. Holder-MCap ratio acceptable
 *  18. Volume-MCap ratio acceptable
 *  19. Smart money presence (boost, never blocks)
 *  20. Minimum token age (avoid bot chaos zone)
 *  21. Maximum buy market cap (avoid already-pumped tokens)
 *
 * Strategy = business logic ONLY. No RPC, no DB, no protocol decoding.
 * All data is provided via the EntryCheckData interface.
 */

import type { MintAddress } from '../../core/types/token.js';
import {
  ENTRY_CHECK_COUNT,
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_MS,
  MAX_PRICE_IMPACT_BPS,
  MIN_CREATOR_SCORE,
  MAX_BUNDLE_PCT,
  MAX_WASH_TRADE_SCORE,
  MIN_UNIQUE_WALLETS,
  MAX_SELL_RATIO_PCT,
  MIN_LIQUIDITY_DEPTH_LAMPORTS,
  HOLDER_BUNDLE_MAX_BUNDLE_PCT,
  HOLDER_BUNDLE_MAX_HOLDERS,
  MIN_HOLDER_FLOOR,
  MAX_VOLUME_MCAP_RATIO,
  MIN_TOKEN_AGE_SECONDS,
  MAX_BUY_MCAP_USD,
  MIN_AVG_BUY_SIZE_LAMPORTS,
  MIN_HOLDER_COUNT,
} from './filteredSniperRules.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('strategy:entryDecision');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data required for all 19 entry checks. */
export interface EntryCheckData {
  readonly mint: MintAddress;

  /** Check 1: Was a launch event detected? */
  readonly launchDetected: boolean;

  /** Check 2: Is the creator NOT on the blacklist? */
  readonly creatorNotBlacklisted: boolean;

  /** Check 3: Is the creator history acceptable? (not a serial launcher) */
  readonly creatorHistoryAcceptable: boolean;

  /** Creator score from trade outcomes (0-100, null if unknown). */
  readonly creatorScore: number | null;

  /** Check 4: Is the mint authority revoked? */
  readonly mintAuthorityRevoked: boolean;

  /** Check 5: Is the freeze authority revoked? */
  readonly freezeAuthorityRevoked: boolean;

  /** Check 6: Is the token metadata sane? (name/symbol not suspicious) */
  readonly metadataSane: boolean;

  /** Check 7: Is the liquidity sane? (minimum reserves on bonding curve) */
  readonly liquiditySane: boolean;

  /** Check 8: Is wallet concentration acceptable? (no whale domination) */
  readonly walletConcentrationAcceptable: boolean;

  /** Check 9: Momentum data — number of buys in the window. */
  readonly buyCountInWindow: number;

  /** Check 9: Momentum data — total buy volume in lamports. */
  readonly volumeLamports: bigint;

  /** Check 18: Buy volume in USD (for volume-mcap ratio). */
  readonly volumeUsd?: number;

  /** Check 9: Momentum data — window size in ms. */
  readonly windowMs: number;

  /** Check 10: Price impact of the position size in basis points (null = data unavailable). */
  readonly priceImpactBps: number | null;

  /** Check 11: Bundle percentage (0-100). Null if unknown. */
  readonly bundlePct?: number | null;

  /** Check 12: Wash trade score (0-1, higher = more suspicious). Null if unknown. */
  readonly washTradeScore?: number | null;

  /** Check 13: Unique wallets in momentum window. */
  readonly uniqueWallets?: number;

  /** Check 14: Number of sells in the momentum window (for sell pressure). */
  readonly sellCountInWindow?: number;

  /** Check 15: Real SOL reserves in bonding curve (lamports). */
  readonly realSolReservesLamports?: bigint | null;

  /** Check 16: Number of unique holders (for holder-to-bundle ratio). */
  readonly holderCount?: number | null;

  /** Optional: seconds since token launch for dynamic position sizing. */
  readonly secondsSinceLaunch?: number;

  /** Optional: market cap in USD for tier-based position sizing. */
  readonly marketCapUsd?: number | null;

  /** Check 19: Smart money confidence score (0-1.5). Null if unavailable. */
  readonly smartMoneyScore?: number | null;

  /** Check 19: Number of smart wallets detected buying this token. */
  readonly smartWalletCount?: number;
}

/** Individual check result. */
interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

/** Entry decision result. */
export interface EntryDecisionResult {
  /** Whether ALL 19 checks passed. */
  readonly allowed: boolean;
  /** Individual check results (always 19). */
  readonly checks: readonly CheckResult[];
  /** Number of checks that passed. */
  readonly passedCount: number;
  /** Number of checks that failed. */
  readonly failedCount: number;
  /** First failure reason (for quick rejection logging). */
  readonly firstFailure: string | null;
}

// ---------------------------------------------------------------------------
// Entry Decision
//
// NULL HANDLING RATIONALE:
// - BLOCK when null: Checks where missing data = unquantifiable risk.
//   These are safety-critical checks where "no data" should NOT mean "pass".
//   Examples: creator_score (BUG-002), price_impact (BUG-001), bundle (BUG-003),
//   wash_trade (BUG-003), liquidity_depth (check 15).
//
// - PASS when null: Checks where data is optional or the check is a boost.
//   These are secondary heuristics that need both data points to be meaningful.
//   Examples: holder_bundle_ratio (needs holderCount AND bundlePct),
//   holder_mcap_ratio, volume_mcap_ratio, smart_money (boost only).
//
// The distinction is: "Can this check make a meaningful decision without data?"
// If NO → BLOCK. If YES (or it's a boost) → PASS.
// ---------------------------------------------------------------------------

/**
 * Evaluate all 19 entry checks. ALL must pass.
 *
 * Returns immediately on first failure for speed, but still reports
 * all check results for logging/telemetry.
 */
export function evaluateEntry(data: EntryCheckData): EntryDecisionResult {
  const checks: CheckResult[] = [
    // Check 1: Launch detected
    {
      name: 'launch_detected',
      passed: data.launchDetected,
      reason: data.launchDetected ? 'Launch event confirmed' : 'No launch event detected',
    },
    // Check 2: Creator not blacklisted
    {
      name: 'creator_not_blacklisted',
      passed: data.creatorNotBlacklisted,
      reason: data.creatorNotBlacklisted ? 'Creator is clean' : 'Creator is BLACKLISTED',
    },
    // Check 3: Creator history acceptable (including creator score threshold)
    (() => {
      const historyOk = data.creatorHistoryAcceptable;
      const scoreOk = data.creatorScore !== null && data.creatorScore >= MIN_CREATOR_SCORE;
      const passed = historyOk && scoreOk;
      let reason: string;
      if (passed) {
        reason = `Creator history acceptable (score: ${data.creatorScore}/100)`;
      } else if (!historyOk) {
        reason = 'Creator is a serial launcher';
      } else if (data.creatorScore === null) {
        reason = 'Creator score unavailable — BLOCKING (risk too high)';
      } else {
        reason = `Creator score too low: ${data.creatorScore}/100`;
        logger.warn(reason, { mint: data.mint, creatorScore: data.creatorScore });
      }
      return { name: 'creator_history_acceptable', passed, reason };
    })(),
    // Check 4: Mint authority safe
    {
      name: 'mint_authority_safe',
      passed: data.mintAuthorityRevoked,
      reason: data.mintAuthorityRevoked
        ? 'Mint authority revoked'
        : 'DANGER: Mint authority NOT revoked',
    },
    // Check 5: Freeze authority safe
    {
      name: 'freeze_authority_safe',
      passed: data.freezeAuthorityRevoked,
      reason: data.freezeAuthorityRevoked
        ? 'Freeze authority revoked'
        : 'DANGER: Freeze authority NOT revoked',
    },
    // Check 6: Metadata sane
    {
      name: 'metadata_sane',
      passed: data.metadataSane,
      reason: data.metadataSane ? 'Metadata looks normal' : 'Suspicious metadata detected',
    },
    // Check 7: Liquidity sane (basic sanity: >= 0.1 SOL virtual reserves)
    // Note: Check 15 (liquidity_depth) enforces the real floor (>= 0.5 SOL real reserves)
    {
      name: 'liquidity_sane',
      passed: data.liquiditySane,
      reason: data.liquiditySane
        ? 'Liquidity meets minimum threshold'
        : 'Insufficient liquidity on bonding curve',
    },
    // Check 8: Wallet concentration acceptable
    {
      name: 'wallet_concentration_acceptable',
      passed: data.walletConcentrationAcceptable,
      reason: data.walletConcentrationAcceptable
        ? 'Wallet concentration within limits'
        : 'High wallet concentration detected (whale risk)',
    },
    // Check 9: Momentum threshold met (buy count + volume + window)
    (() => {
      const buyCountOk = data.buyCountInWindow >= MOMENTUM_MIN_BUYS;
      const windowOk = data.windowMs <= MOMENTUM_WINDOW_MS;
      const volumeOk = data.volumeLamports >= MOMENTUM_MIN_VOLUME_LAMPORTS;
      const passed = buyCountOk && windowOk && volumeOk;
      return {
        name: 'momentum_threshold_met',
        passed,
        reason: passed
          ? `Momentum met: ${data.buyCountInWindow} buys, ${(Number(data.volumeLamports) / 1e9).toFixed(2)} SOL vol in ${data.windowMs}ms`
          : `Momentum NOT met: ${data.buyCountInWindow}/${MOMENTUM_MIN_BUYS} buys, ${(Number(data.volumeLamports) / 1e9).toFixed(2)}/${(Number(MOMENTUM_MIN_VOLUME_LAMPORTS) / 1e9).toFixed(0)} SOL vol in ${data.windowMs}ms (need ${MOMENTUM_MIN_BUYS} buys + ${Number(MOMENTUM_MIN_VOLUME_LAMPORTS) / 1e9} SOL in ${MOMENTUM_WINDOW_MS}ms)`,
      };
    })(),
    // Check 10: Price impact acceptable
    (() => {
      if (data.priceImpactBps === null) {
        return {
          name: 'price_impact_acceptable',
          passed: false,
          reason: 'Price impact data unavailable — BLOCKING (risk too high)',
        };
      }
      const passed = data.priceImpactBps <= MAX_PRICE_IMPACT_BPS;
      const impactPct = (data.priceImpactBps / 100).toFixed(2);
      const maxPct = (MAX_PRICE_IMPACT_BPS / 100).toFixed(2);
      return {
        name: 'price_impact_acceptable',
        passed,
        reason: passed
          ? `Price impact acceptable: ${impactPct}%`
          : `Price impact too high: ${impactPct}% (max ${maxPct}%)`,
      };
    })(),
    // Check 11: Bundle percentage acceptable (block if >30% bundled — match detector)
    // BLOCK if data unavailable — can't assess risk without bundle data
    (() => {
      if (data.bundlePct == null) {
        return { name: 'bundle_check', passed: false, reason: 'Bundle data unavailable — BLOCKING (risk too high without data)' };
      }
      const passed = data.bundlePct <= MAX_BUNDLE_PCT;
      return {
        name: 'bundle_check',
        passed,
        reason: passed
          ? `Bundle OK: ${data.bundlePct.toFixed(1)}%`
          : `TOO BUNDLED: ${data.bundlePct.toFixed(1)}% supply in few wallets (max 40%)`,
      };
    })(),
    // Check 12: Wash trade score acceptable (block if score > 60)
    (() => {
      if (data.washTradeScore == null) {
        return { name: 'wash_trade_check', passed: false, reason: 'Wash trade data unavailable — BLOCKING (risk too high)' };
      }
      const passed = data.washTradeScore <= MAX_WASH_TRADE_SCORE;
      return {
        name: 'wash_trade_check',
        passed,
        reason: passed
          ? `Wash trade OK: score ${data.washTradeScore.toFixed(0)}/100`
          : `WASH TRADE SUSPECTED: score ${data.washTradeScore.toFixed(0)}/100 (max 60)`,
      };
    })(),
    // Check 13: Unique wallets in momentum window (min 12)
    // BLOCK if data unavailable — wallet diversity is critical for anti-manipulation
    (() => {
      if (data.uniqueWallets == null) {
        return { name: 'unique_wallets', passed: false, reason: 'Wallet count unavailable — BLOCKING (need diversity data)' };
      }
      const passed = data.uniqueWallets >= MIN_UNIQUE_WALLETS;
      return {
        name: 'unique_wallets',
        passed,
        reason: passed
          ? `Unique wallets OK: ${data.uniqueWallets}`
          : `Too few unique wallets: ${data.uniqueWallets} (min 8)`,
      };
    })(),
    // Check 14: Sell pressure acceptable (early dump detection)
    // If sells > 60% of total trades, it's likely a dump
    // Buy window: 30s (momentum), Sell window: 60s (2x ratio)
    (() => {
      if (data.sellCountInWindow === undefined) {
        return { name: 'sell_pressure', passed: true, reason: 'Sell pressure tracking not yet active — skipping' };
      }
      if (data.sellCountInWindow == null || data.buyCountInWindow === 0) {
        return { name: 'sell_pressure', passed: false, reason: 'Sell pressure data unavailable — BLOCKING' };
      }
      const totalTrades = data.buyCountInWindow + data.sellCountInWindow;
      const sellRatio = totalTrades > 0 ? (data.sellCountInWindow / totalTrades) * 100 : 0;
      const passed = sellRatio <= MAX_SELL_RATIO_PCT;
      return {
        name: 'sell_pressure',
        passed,
        reason: passed
          ? `Sell pressure OK: ${sellRatio.toFixed(0)}% sells (${data.sellCountInWindow}/${totalTrades})`
          : `HIGH SELL PRESSURE: ${sellRatio.toFixed(0)}% sells in window (${data.sellCountInWindow}/${totalTrades}) — likely dump`,
      };
    })(),
    // Check 15: Liquidity depth sufficient (real SOL reserves)
    // Minimum 0.5 SOL in bonding curve — prevents entering dead/low-liquidity tokens
    // BLOCK if data unavailable — liquidity data should always be available from bonding curve
    (() => {
      if (data.realSolReservesLamports == null) {
        return { name: 'liquidity_depth', passed: false, reason: 'Real SOL reserves unavailable — BLOCKING (need liquidity data)' };
      }
      const minReservesLamports = MIN_LIQUIDITY_DEPTH_LAMPORTS;
      const reservesSol = Number(data.realSolReservesLamports) / 1e9;
      const passed = data.realSolReservesLamports >= minReservesLamports;
      return {
        name: 'liquidity_depth',
        passed,
        reason: passed
          ? `Liquidity depth OK: ${reservesSol.toFixed(2)} SOL`
          : `Insufficient liquidity: ${reservesSol.toFixed(4)} SOL (min 0.5 SOL)`,
      };
    })(),
    // Check 16: Holder-to-bundle ratio acceptable
    // If we know holder count AND bundle wallets, check that bundle isn't
    // the majority of holders (catches "170 holders but all from same source")
    (() => {
      if (data.holderCount == null || data.holderCount === 0 || data.bundlePct == null) {
        return { name: 'holder_bundle_ratio', passed: true, reason: 'Holder/bundle ratio data unavailable — skipping' };
      }
      // Estimate bundle wallets from bundlePct (rough: assume avg buy = 2% per wallet)
      // If bundlePct=30% and avg buy is 2%, that's ~15 bundle wallets
      // If holderCount is 50, then 15/50 = 30% of holders are bundle → suspicious
      // Simple heuristic: if bundlePct > 20% AND holderCount < 100, likely fake
      const lowHolderCount = data.holderCount < HOLDER_BUNDLE_MAX_HOLDERS;
      const highBundle = data.bundlePct > HOLDER_BUNDLE_MAX_BUNDLE_PCT;
      const passed = !(lowHolderCount && highBundle);
      return {
        name: 'holder_bundle_ratio',
        passed,
        reason: passed
          ? `Holder/bundle ratio OK: ${data.holderCount} holders, ${data.bundlePct.toFixed(1)}% bundled`
          : `SUSPICIOUS: ${data.holderCount} holders with ${data.bundlePct.toFixed(1)}% bundled — likely fake holders`,
      };
    })(),
    // Check 17: Holder-MCap ratio (catches coordinated holder inflation)
    // Pattern: 300+ holders but mcap only $11k = mass coordinated buys, will dump
    // Threshold: > 0.015 holders per dollar of mcap = suspicious
    // DYNAMIC: Stricter for new tokens (< 5 min) — coordinated buys happen fast
    // Examples: 300 holders / $11k = 0.027 → BLOCK
    //           50 holders / $50k = 0.001 → PASS
    //           200 holders / $500k = 0.0004 → PASS
    (() => {
      if (data.holderCount == null || data.marketCapUsd == null || data.marketCapUsd <= 0) {
        return { name: 'holder_mcap_ratio', passed: true, reason: 'Holder/MCap data unavailable — skipping' };
      }
      // Auto-pass if holder count meets floor
      if (data.holderCount >= MIN_HOLDER_FLOOR) {
        return { name: 'holder_mcap_ratio', passed: true, reason: `Holder floor met: ${data.holderCount} >= ${MIN_HOLDER_FLOOR}` };
      }
      // Mcap-based tiers (looser for lower mcap, tighter for higher)
      const mcap = data.marketCapUsd;
      const ratio = data.holderCount / mcap;
      const maxRatio = mcap < 5000 ? 0.05 :
                       mcap < 10000 ? 0.03 :
                       0.015;
      const passed = ratio <= maxRatio;
      return {
        name: 'holder_mcap_ratio',
        passed,
        reason: passed
          ? `Holder/MCap OK: ${data.holderCount} holders / $${mcap.toFixed(0)} (ratio ${ratio.toFixed(4)}, max ${maxRatio})`
          : `HOLDER INFLATION: ${data.holderCount} holders / $${mcap.toFixed(0)} (ratio ${ratio.toFixed(4)}, max ${maxRatio}) — coordinated dump pattern`,
      };
    })(),
    // Check 18: Volume-MCap ratio (catches wash trade / coordinated volume)
    // Pattern: volume 1h jauh lebih besar dari mcap = artificial volume
    // Threshold: volume / mcap > 5x = suspicious
    // Examples: $17k volume / $11k mcap = 1.5x → borderline
    //           $50k volume / $5k mcap = 10x → BLOCK
    //           $5k volume / $50k mcap = 0.1x → PASS
    (() => {
      if (data.volumeUsd == null || data.marketCapUsd == null || data.marketCapUsd <= 0) {
        return { name: 'volume_mcap_ratio', passed: true, reason: 'Volume/MCap data unavailable — skipping' };
      }
      const ratio = data.volumeUsd / data.marketCapUsd;
      const passed = ratio <= MAX_VOLUME_MCAP_RATIO;
      return {
        name: 'volume_mcap_ratio',
        passed,
        reason: passed
          ? `Volume/MCap OK: $${data.volumeUsd.toFixed(0)} vol / $${data.marketCapUsd.toFixed(0)} mcap (${ratio.toFixed(1)}x)`
          : `WASH TRADE SUSPECTED: $${data.volumeUsd.toFixed(0)} volume but only $${data.marketCapUsd.toFixed(0)} mcap (${ratio.toFixed(1)}x, max 5x) — artificial volume`,
      };
    })(),

    // Check 19: Smart money presence (BOOST signal — never blocks, but logs for visibility)
    (() => {
      if (data.smartMoneyScore == null) {
        return { name: 'smart_money', passed: true, reason: 'Smart money data unavailable — skipping' };
      }
      const detected = (data.smartMoneyScore ?? 0) >= 0.5;
      return {
        name: 'smart_money',
        passed: true, // Never blocks — smart money is a boost, not a filter
        reason: detected
          ? `SMART MONEY DETECTED: score ${(data.smartMoneyScore ?? 0).toFixed(3)}, ${data.smartWalletCount ?? 0} wallets`
          : `No smart money: score ${(data.smartMoneyScore ?? 0).toFixed(3)}`,
      };
    })(),

    // Check 20: Minimum token age (avoid bot chaos zone)
    // BLOCK if too young — first seconds are chaotic, no organic activity yet
    // BLOCK if data unavailable — can't assess risk without age data
    (() => {
      if (data.secondsSinceLaunch == null) {
        return { name: 'min_token_age', passed: false, reason: 'Token age unavailable — BLOCKING (no launch timestamp, risk too high)' };
      }
      const passed = data.secondsSinceLaunch >= MIN_TOKEN_AGE_SECONDS;
      return {
        name: 'min_token_age',
        passed,
        reason: passed
          ? `Token age OK: ${data.secondsSinceLaunch}s (min ${MIN_TOKEN_AGE_SECONDS}s)`
          : `TOO YOUNG: ${data.secondsSinceLaunch}s old (min ${MIN_TOKEN_AGE_SECONDS}s) — bot chaos zone, waiting for organic activity`,
      };
    })(),

    // Check 21: Maximum buy market cap (avoid already-pumped tokens)
    // BLOCK if mcap exceeds threshold — diminishing returns for small positions
    // BLOCK if data unavailable — can't assess risk without mcap data
    (() => {
      if (data.marketCapUsd == null || data.marketCapUsd <= 0) {
        return { name: 'max_buy_mcap', passed: false, reason: 'Market cap unavailable — BLOCKING (data unavailable, risk too high)' };
      }
      const passed = data.marketCapUsd <= MAX_BUY_MCAP_USD;
      return {
        name: 'max_buy_mcap',
        passed,
        reason: passed
          ? `MCap OK: $${data.marketCapUsd.toFixed(0)} (max $${MAX_BUY_MCAP_USD.toLocaleString()})`
          : `MCAP TOO HIGH: $${data.marketCapUsd.toFixed(0)} (max $${MAX_BUY_MCAP_USD.toLocaleString()}) — already pumped, diminishing returns`,
      };
    })(),

    // Check 22: Minimum average buy size (anti micro-buy spam)
    // BLOCK if avg buy size too low — likely bot micro-buy spam to fake momentum
    // BLOCK if data unavailable — parsing must be correct to get on-chain data
    (() => {
      if (data.volumeLamports == null || data.buyCountInWindow == null || data.buyCountInWindow === 0) {
        return { name: 'min_avg_buy_size', passed: false, reason: 'Avg buy size unavailable — BLOCKING (parsing failed, no on-chain data)' };
      }
      const avgBuySize = data.volumeLamports / BigInt(data.buyCountInWindow);
      const passed = avgBuySize >= MIN_AVG_BUY_SIZE_LAMPORTS;
      return {
        name: 'min_avg_buy_size',
        passed,
        reason: passed
          ? `Avg buy size OK: ${(Number(avgBuySize) / 1e9).toFixed(4)} SOL (min ${(Number(MIN_AVG_BUY_SIZE_LAMPORTS) / 1e9).toFixed(3)} SOL)`
          : `AVG BUY TOO SMALL: ${(Number(avgBuySize) / 1e9).toFixed(4)} SOL (min ${(Number(MIN_AVG_BUY_SIZE_LAMPORTS) / 1e9).toFixed(3)} SOL) — likely micro-buy spam`,
      };
    })(),

    // Check 23: Minimum holder count (standalone, independent of bundle check)
    // BLOCK if holders too low — fake volume from few wallets
    // BLOCK if data unavailable — parsing must be correct to get on-chain data
    (() => {
      if (data.holderCount == null) {
        return { name: 'min_holder_count', passed: false, reason: 'Holder count unavailable — BLOCKING (parsing failed, no on-chain data)' };
      }
      const passed = data.holderCount >= MIN_HOLDER_COUNT;
      return {
        name: 'min_holder_count',
        passed,
        reason: passed
          ? `Holder count OK: ${data.holderCount} (min ${MIN_HOLDER_COUNT})`
          : `TOO FEW HOLDERS: ${data.holderCount} (min ${MIN_HOLDER_COUNT}) — likely fake volume from few wallets`,
      };
    })(),
  ];

  // Validate we have exactly 23 checks (compile-time safety)
  if (checks.length !== ENTRY_CHECK_COUNT) {
    throw new Error(
      `Entry check count mismatch: expected ${ENTRY_CHECK_COUNT}, got ${checks.length}`,
    );
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const failedCount = checks.length - passedCount;
  const firstFailure = checks.find((c) => !c.passed);

  const allowed = failedCount === 0;

  if (allowed) {
    logger.info('Entry decision: ALLOWED', {
      mint: data.mint,
      passedCount,
    });
  } else {
    logger.info('Entry decision: REJECTED', {
      mint: data.mint,
      passedCount,
      failedCount,
      firstFailure: firstFailure?.name ?? 'unknown',
      firstFailureReason: firstFailure?.reason ?? 'unknown',
    });
  }

  return {
    allowed,
    checks,
    passedCount,
    failedCount,
    firstFailure: firstFailure?.reason ?? null,
  };
}
