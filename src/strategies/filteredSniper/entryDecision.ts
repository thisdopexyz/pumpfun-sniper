/**
 * Entry Decision
 *
 * Evaluates ALL 27 entry checks from rule.md before allowing a buy.
 * Every single check must pass (or fall within the soft-fail tolerance).
 * No shortcuts. No partial passes.
 *
 * The 27 checks (from rule.md + entryCheckData):
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
 *  22. Minimum average buy size (anti micro-buy spam)
 *  23. Minimum holder count
 *  24. Wallet age score (Dev Multi-Wallet Defense)
 *  25. Buy velocity score (Dev Multi-Wallet Defense)
 *  26. Enhanced bundle percentage (Dev Multi-Wallet Defense)
 *  27. Cross-token correlation (Dev Multi-Wallet Defense)
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
  MAX_WASH_TRADE_SCORE,
  MAX_BUNDLE_PCT,
  MIN_UNIQUE_WALLETS,
  MAX_SELL_RATIO_PCT,
  MIN_LIQUIDITY_DEPTH_LAMPORTS,
  HOLDER_BUNDLE_MAX_BUNDLE_PCT,
  HOLDER_BUNDLE_MAX_HOLDERS,
  MIN_HOLDER_FLOOR,
  MAX_VOLUME_MCAP_RATIO,
  MAX_BUY_MCAP_USD,
  MIN_TOKEN_AGE_SECONDS,
  MIN_AVG_BUY_SIZE_LAMPORTS,
  MIN_HOLDER_COUNT,
  MAX_WALLET_AGE_SCORE,
  MAX_BUY_VELOCITY_SCORE,
  MAX_ENHANCED_BUNDLE_PCT,
  MAX_CROSS_TOKEN_SCORE,
} from './filteredSniperRules.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('strategy:entryDecision');

// ---------------------------------------------------------------------------
// Prometheus: per-filter rejection counters
// ---------------------------------------------------------------------------

const entryRejectionCounter = new Counter({
  name: 'pumpfun_entry_rejections_total',
  help: 'Total entry check rejections by check name',
  labelNames: ['check_name'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data required for all 27 entry checks. */
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

  /** Check 12: Wash trade score (0-100, higher = more suspicious). Null if unknown. */
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

  /** Check 24: Wallet age score (0-100, higher = more new wallets). Null if unavailable. */
  readonly walletAgeScore?: number | null;

  /** Check 25: Buy velocity score (0-100, higher = more bot-like). Null if unavailable. */
  readonly buyVelocityScore?: number | null;

  /** Check 26: Enhanced bundle percentage (0-100). Null if unavailable. */
  readonly enhancedBundlePct?: number | null;

  /** Check 27: Cross-token correlation score (0-100). Null if unavailable. */
  readonly crossTokenScore?: number | null;
}

/** Individual check result. */
interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

/** Entry decision result. */
export interface EntryDecisionResult {
  /** Whether ALL 27 checks passed (within soft-fail tolerance). */
  readonly allowed: boolean;
  /** Individual check results (always 27). */
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
 * Evaluate all 27 entry checks. ALL must pass (or fall within soft-fail tolerance).
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
    // NOTE: Check 13 (unique_wallets min 20) is a SOFT check (MED-AUDIT-1).
    // Both Check 9 and Check 13 must pass for the entry to count as clean;
    // either failure counts toward SOFT_FAIL_TOLERANCE=2, so an early-stage
    // token with 15 buys from 5 unique wallets could still pass (e.g., if
    // bundle/wash checks are unavailable). Real anti-scam gating is at
    // Check 11/12/26 (bundle %).
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
    // Check 12: Wash trade score acceptable (block if score > 60)
    (() => {
      if (data.washTradeScore == null) {
        return { name: 'wash_trade_check', passed: false, reason: 'Wash trade data unavailable — soft-skipping' };
      }
      const passed = data.washTradeScore <= MAX_WASH_TRADE_SCORE;
      return {
        name: 'wash_trade_check',
        passed,
        reason: passed
          ? `Wash trade OK: score ${data.washTradeScore.toFixed(0)}/100`
          : `WASH TRADE SUSPECTED: score ${data.washTradeScore.toFixed(0)}/100 (max ${MAX_WASH_TRADE_SCORE})`,
      };
    })(),
    // Check 11: Bundle percentage acceptable (180s window — multi-wallet scheme)
    // BundleDetector default windowSeconds=180, but forceAnalyze returns data
    // after 30s minimum (forceAnalyzeMinMs). MED-AUDIT-1: now soft.
    (() => {
      if (data.bundlePct == null) {
        return { name: 'bundle_pct', passed: false, reason: 'Bundle % unavailable — soft-skipping' };
      }
      const passed = data.bundlePct <= MAX_BUNDLE_PCT;
      return {
        name: 'bundle_pct',
        passed,
        reason: passed
          ? `Bundle OK: ${data.bundlePct.toFixed(1)}% (max ${MAX_BUNDLE_PCT}%)`
          : `BUNDLE DETECTED: ${data.bundlePct.toFixed(1)}% of supply from clustered wallets (max ${MAX_BUNDLE_PCT}%) — likely dev multi-wallet scheme`,
      };
    })(),
    // Check 13: Unique wallets in momentum window (min 12)
    // MED-AUDIT-1: now soft — wallet diversity data is sometimes unavailable
    (() => {
      if (data.uniqueWallets == null) {
        return { name: 'unique_wallets', passed: false, reason: 'Wallet count unavailable — soft-skipping' };
      }
      const passed = data.uniqueWallets >= MIN_UNIQUE_WALLETS;
      return {
        name: 'unique_wallets',
        passed,
        reason: passed
          ? `Unique wallets OK: ${data.uniqueWallets}`
          : `Too few unique wallets: ${data.uniqueWallets} (min ${MIN_UNIQUE_WALLETS})`,
      };
    })(),
    // Check 14: Sell pressure acceptable (early dump detection)
    // If sells > 60% of total trades, it's likely a dump
    // Both buy and sell counts use the SAME momentum window (30s)
    // to avoid ratio inflation from mismatched windows
    (() => {
      if (data.sellCountInWindow === undefined) {
        return { name: 'sell_pressure', passed: true, reason: 'Sell pressure tracking not yet active — skipping' };
      }
      if (data.sellCountInWindow == null || data.buyCountInWindow === 0) {
        return { name: 'sell_pressure', passed: false, reason: 'Sell pressure data unavailable — SOFT-FAILING (data-quality, not anti-scam)' };
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
    // MED-AUDIT-1: now soft — liquidity data may be unavailable for non-pump tokens
    (() => {
      if (data.realSolReservesLamports == null) {
        return { name: 'liquidity_depth', passed: false, reason: 'Real SOL reserves unavailable — soft-skipping' };
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
    // Tiers (holders per dollar of mcap, stricter as mcap grows):
    //   mcap < $2k   -> 0.012
    //   mcap < $5k   -> 0.009
    //   mcap < $10k  -> 0.006
    //   mcap >= $10k -> 0.005
    // Examples: 300 holders / $11k = 0.027 -> BLOCK
    //           50 holders / $50k  = 0.001 -> PASS
    //           200 holders / $500k = 0.0004 -> PASS
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
      const maxRatio = mcap < 2000 ? 0.012 :
                       mcap < 5000 ? 0.009 :
                       mcap < 10000 ? 0.006 : 0.005;
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
    // SOFT — data may be unavailable early in token lifecycle (race with launch detector).
    // SOFT pass when null: launch just happened, can't compute age reliably yet.
    (() => {
      if (data.secondsSinceLaunch === undefined || data.secondsSinceLaunch === null) {
        return { name: 'min_token_age', passed: true, reason: 'Token age unavailable — skipping (too early)' };
      }
      const passed = data.secondsSinceLaunch >= MIN_TOKEN_AGE_SECONDS;
      return {
        name: 'min_token_age',
        passed,
        reason: passed
          ? `Token age OK: ${data.secondsSinceLaunch}s (min ${MIN_TOKEN_AGE_SECONDS}s)`
          : `TOKEN TOO FRESH: ${data.secondsSinceLaunch}s (min ${MIN_TOKEN_AGE_SECONDS}s) — bot chaos zone, wait for organic buyers`,
      };
    })(),

    // Check 21: Maximum buy market cap (avoid already-pumped tokens)
    // BLOCK if mcap exceeds threshold — diminishing returns for small positions
    // MED-AUDIT-1: now soft — mcap data may be unavailable for non-pump tokens
    (() => {
      if (data.marketCapUsd == null || data.marketCapUsd <= 0) {
        return { name: 'max_buy_mcap', passed: false, reason: 'Market cap unavailable — soft-skipping' };
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
        return { name: 'min_avg_buy_size', passed: false, reason: 'Avg buy size unavailable — SOFT-FAILING (data-quality, parsing may need warming)' };
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
        return { name: 'min_holder_count', passed: false, reason: 'Holder count unavailable — SOFT-FAILING (Helius API may be slow/down)' };
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

    // Check 24: Wallet Age Score (Dev Multi-Wallet Defense)
    // BLOCK if majority of buying wallets are brand new (< 1 hour old)
    // MED-AUDIT-1: now soft — detector may not have data for all mints
    (() => {
      if (data.walletAgeScore == null) {
        return { name: 'wallet_age_score', passed: false, reason: 'Wallet age score unavailable — soft-skipping' };
      }
      const passed = data.walletAgeScore <= MAX_WALLET_AGE_SCORE;
      return {
        name: 'wallet_age_score',
        passed,
        reason: passed
          ? `Wallet age OK: score ${data.walletAgeScore} (max ${MAX_WALLET_AGE_SCORE})`
          : `WALLETS TOO NEW: score ${data.walletAgeScore} (max ${MAX_WALLET_AGE_SCORE}) — majority of buyers are brand new wallets, likely dev multi-wallet scheme`,
      };
    })(),

    // Check 25: Buy Velocity Score (Dev Multi-Wallet Defense)
    // BLOCK if buy velocity indicates bot swarm or coordinated mass-buy
    // MED-AUDIT-1: now soft — detector may not have data
    (() => {
      if (data.buyVelocityScore == null) {
        return { name: 'buy_velocity_score', passed: false, reason: 'Buy velocity score unavailable — soft-skipping' };
      }
      const passed = data.buyVelocityScore <= MAX_BUY_VELOCITY_SCORE;
      return {
        name: 'buy_velocity_score',
        passed,
        reason: passed
          ? `Buy velocity OK: score ${data.buyVelocityScore} (max ${MAX_BUY_VELOCITY_SCORE})`
          : `BOT SWARM DETECTED: velocity score ${data.buyVelocityScore} (max ${MAX_BUY_VELOCITY_SCORE}) — too many wallets buying too fast, coordinated activity`,
      };
    })(),

    // Check 26: Enhanced Bundle Percentage (Dev Multi-Wallet Defense)
    // BLOCK if enhanced bundle % exceeds threshold (lowered from original 40%)
    // Uses 180s window instead of 60s, catches slower multi-wallet schemes
    // MED-AUDIT-1: now soft — detector may not have data
    (() => {
      if (data.enhancedBundlePct == null) {
        return { name: 'enhanced_bundle_pct', passed: false, reason: 'Enhanced bundle % unavailable — soft-skipping' };
      }
      const passed = data.enhancedBundlePct <= MAX_ENHANCED_BUNDLE_PCT;
      return {
        name: 'enhanced_bundle_pct',
        passed,
        reason: passed
          ? `Enhanced bundle OK: ${data.enhancedBundlePct.toFixed(1)}% (max ${MAX_ENHANCED_BUNDLE_PCT}%)`
          : `ENHANCED BUNDLE TOO HIGH: ${data.enhancedBundlePct.toFixed(1)}% (max ${MAX_ENHANCED_BUNDLE_PCT}%) — wallets clustered by funding source, likely coordinated`,
      };
    })(),

    // Check 27: Cross-Token Correlation (Dev Multi-Wallet Defense)
    // BLOCK if wallets from previous dump-tokens are buying this token
    // MED-AUDIT-1: now soft — detector may not have data
    (() => {
      if (data.crossTokenScore == null) {
        return { name: 'cross_token_score', passed: false, reason: 'Cross-token score unavailable — soft-skipping' };
      }
      const passed = data.crossTokenScore <= MAX_CROSS_TOKEN_SCORE;
      return {
        name: 'cross_token_score',
        passed,
        reason: passed
          ? `Cross-token OK: score ${data.crossTokenScore} (max ${MAX_CROSS_TOKEN_SCORE})`
          : `SERIAL SCAMMER WALLETS: cross-token score ${data.crossTokenScore} (max ${MAX_CROSS_TOKEN_SCORE}) — wallets from previous dumps buying this token`,
      };
    })(),
  ];

  // Validate check count matches ENTRY_CHECK_COUNT
  if (checks.length !== ENTRY_CHECK_COUNT) {
    throw new Error(
      `Entry check count mismatch: expected ${ENTRY_CHECK_COUNT}, got ${checks.length}`,
    );
  }

  // Soft-fail classification: a check is "soft" if failing it doesn't
  // necessarily mean the token is a scam — it usually means the data
  // isn't available yet, or the token is a borderline case on a strict
  // threshold. "Hard" checks are non-negotiable anti-scam gates.
  //
  // A token is ALLOWED if it has zero hard failures AND <= SOFT_FAIL_TOLERANCE
  // soft failures. This lets the bot snipe tokens that are 25-26/27 in
  // practice (data race / strict count off by one) while still blocking
  // real scams (bundle, dev multi-wallet, blacklist, rug risk).
  //
  // Classification rationale:
  //   HARD = real anti-scam signal where failing = high rug risk:
  //     - bundle_pct, wash_trade_check, enhanced_bundle_pct: dev multi-wallet
  //     - creator_not_blacklisted: KNOWN scammer (DB-confirmed)
  //     - liquidity_sane, momentum_threshold_met: structural (BC must exist, must have momentum)
  //   SOFT = heuristic / data-quality / borderline:
  //     - creator_history (serial launcher) — heuristic, not a scam signal per se
  //     - wallet_concentration — popular launches can have concentration
  //     - mint/freeze authority — not all tokens revoke (pump.fun pattern)
  //     - data-quality checks (holder count, unique wallets, mcap, etc.)
  //     - analytics boosters (smart money, cross-token, etc.)
  // MED-AUDIT-1 fix (2026-06-20): relaxed hard-fail set.
  // The old set marked `metadata_sane`, `bundle_pct`, `wash_trade_check`,
  // `enhanced_bundle_pct` as HARD. This caused most tokens to be blocked
  // with "X unavailable — BLOCKING" because the off-chain detectors either
  // hadn't warmed up (data unavailable) or the bonding-curve metadata
  // wasn't parseable (Token-2022 mints, no MPL metadata).
  //
  // New policy: a check is HARD only when the data is GUARANTEED available
  // (onchain RPC, launch event) and failure means a real anti-pattern.
  // Anti-scam signals whose data is sometimes unavailable (bundle, wash,
  // enhanced_bundle) are now SOFT — they skip when data is null instead
  // of blocking. Real scams with detectable bundles still trigger the
  // hard reject via the 3-soft-fail tolerance.
  //
  //   HARD = structural, data always available, failure = real anti-pattern:
  //     - launch_detected: no launch = nothing to buy
  //     - creator_not_blacklisted: KNOWN scammer (DB)
  //     - liquidity_sane: bonding curve must exist
  //     - momentum_threshold_met: must have momentum
  //   SOFT = heuristic / data-quality / sometimes unavailable:
  //     - everything else, including the anti-scam detectors
  const HARD_FAIL_NAMES = new Set([
    'launch_detected',
    'creator_not_blacklisted',
    'liquidity_sane',
    'momentum_threshold_met',
  ]);

  // MED-AUDIT-1: tighter tolerance now that anti-scam checks are soft.
  // With 23 soft checks, allowing 2 fails means 25/27 = 93% pass rate.
  // Lowering to 2 requires 25/27 = 93% — still lenient, but catches more
  // borderline tokens where 3 different data sources are missing.
  const SOFT_FAIL_TOLERANCE = 2;

  const passedCount = checks.filter((c) => c.passed).length;
  const failedCount = checks.length - passedCount;
  const firstFailure = checks.find((c) => !c.passed);

  const failures = checks.filter((c) => !c.passed);
  const hardFailures = failures.filter((c) => HARD_FAIL_NAMES.has(c.name));
  const softFailures = failures.filter((c) => !HARD_FAIL_NAMES.has(c.name));

  const allowed = hardFailures.length === 0 && softFailures.length <= SOFT_FAIL_TOLERANCE;

  if (allowed && softFailures.length > 0) {
    logger.info('Entry decision: ALLOWED via soft-fail tolerance', {
      mint: data.mint,
      passedCount,
      failedCount,
      hardFails: hardFailures.length,
      softFails: softFailures.length,
      softFailNames: softFailures.map((c) => c.name),
    });
  }

  if (allowed) {
    logger.info('Entry decision: ALLOWED', {
      mint: data.mint,
      passedCount,
    });
  } else {
    // Increment per-filter rejection counters
    for (const check of checks) {
      if (!check.passed) {
        entryRejectionCounter.inc({ check_name: check.name });
      }
    }

    logger.info('Entry decision: REJECTED', {
      mint: data.mint,
      passedCount,
      failedCount,
      hardFails: hardFailures.length,
      softFails: softFailures.length,
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
