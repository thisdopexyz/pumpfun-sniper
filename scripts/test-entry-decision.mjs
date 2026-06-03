#!/usr/bin/env node
/**
 * Test script: Simulate entry decision with new age + mcap filters
 *
 * Fetches live data for a token and runs the 21-check entry pipeline
 * to verify the new checks work correctly.
 *
 * Usage: node scripts/test-entry-decision.mjs [MINT_ADDRESS]
 */

const MINT = process.argv[2] || 'EAorJYfXsMJs779dDJSBSvgrhAgdcC3XWoTGP7tXpump';

// ---------------------------------------------------------------------------
// Constants (mirror from filteredSniperRules)
// ---------------------------------------------------------------------------

const MIN_TOKEN_AGE_SECONDS = 1800;
const MAX_BUY_MCAP_USD = 20_000;
// Existing thresholds (for full simulation)
const MIN_CREATOR_SCORE = 45;
const MAX_BUNDLE_PCT = 30;
const MAX_WASH_TRADE_SCORE = 60;
const MIN_UNIQUE_WALLETS = 12;
const MAX_SELL_RATIO_PCT = 60;
const MIN_LIQUIDITY_DEPTH_LAMPORTS = 500_000_000n;
const HOLDER_BUNDLE_MAX_BUNDLE_PCT = 20;
const HOLDER_BUNDLE_MAX_HOLDERS = 100;
const MAX_HOLDER_MCAP_RATIO = 0.015;
const MAX_VOLUME_MCAP_RATIO = 5;
const MAX_PRICE_IMPACT_BPS = 500;
const MOMENTUM_MIN_BUYS = 10;
const MOMENTUM_WINDOW_MS = 30_000;
const MOMENTUM_MIN_VOLUME_LAMPORTS = 2_000_000_000n;

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchDexScreener(mint) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  return res.json();
}

async function fetchPumpfunToken(mint) {
  const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchSolPrice() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
  if (!res.ok) return 150; // fallback
  const data = await res.json();
  return data?.solana?.usd ?? 150;
}

// ---------------------------------------------------------------------------
// Simulate all 21 entry checks
// ---------------------------------------------------------------------------

function runEntryChecks(data) {
  const checks = [];

  // Check 1: Launch detected
  checks.push({
    name: 'launch_detected',
    passed: data.launchDetected,
    reason: data.launchDetected ? 'Launch event confirmed' : 'No launch event detected',
  });

  // Check 2: Creator not blacklisted
  checks.push({
    name: 'creator_not_blacklisted',
    passed: data.creatorNotBlacklisted,
    reason: data.creatorNotBlacklisted ? 'Creator is clean' : 'Creator is BLACKLISTED',
  });

  // Check 3: Creator history acceptable
  {
    const historyOk = data.creatorHistoryAcceptable;
    const scoreOk = data.creatorScore !== null && data.creatorScore >= MIN_CREATOR_SCORE;
    checks.push({
      name: 'creator_history_acceptable',
      passed: historyOk && scoreOk,
      reason: historyOk && scoreOk
        ? `Creator history acceptable (score: ${data.creatorScore}/100)`
        : !historyOk ? 'Creator is a serial launcher'
        : data.creatorScore === null ? 'Creator score unavailable — BLOCKING'
        : `Creator score too low: ${data.creatorScore}/100`,
    });
  }

  // Check 4: Mint authority safe
  checks.push({
    name: 'mint_authority_safe',
    passed: data.mintAuthorityRevoked,
    reason: data.mintAuthorityRevoked ? 'Mint authority revoked' : 'DANGER: Mint authority NOT revoked',
  });

  // Check 5: Freeze authority safe
  checks.push({
    name: 'freeze_authority_safe',
    passed: data.freezeAuthorityRevoked,
    reason: data.freezeAuthorityRevoked ? 'Freeze authority revoked' : 'DANGER: Freeze authority NOT revoked',
  });

  // Check 6: Metadata sane
  checks.push({
    name: 'metadata_sane',
    passed: data.metadataSane,
    reason: data.metadataSane ? 'Metadata looks normal' : 'Suspicious metadata detected',
  });

  // Check 7: Liquidity sane
  checks.push({
    name: 'liquidity_sane',
    passed: data.liquiditySane,
    reason: data.liquiditySane ? 'Liquidity meets minimum threshold' : 'Insufficient liquidity',
  });

  // Check 8: Wallet concentration
  checks.push({
    name: 'wallet_concentration_acceptable',
    passed: data.walletConcentrationAcceptable,
    reason: data.walletConcentrationAcceptable ? 'Wallet concentration within limits' : 'High wallet concentration (whale risk)',
  });

  // Check 9: Momentum
  {
    const buyCountOk = data.buyCountInWindow >= MOMENTUM_MIN_BUYS;
    const windowOk = data.windowMs <= MOMENTUM_WINDOW_MS;
    const volumeOk = data.volumeLamports >= MOMENTUM_MIN_VOLUME_LAMPORTS;
    const passed = buyCountOk && windowOk && volumeOk;
    checks.push({
      name: 'momentum_threshold_met',
      passed,
      reason: passed
        ? `Momentum met: ${data.buyCountInWindow} buys in ${data.windowMs}ms`
        : `Momentum NOT met: ${data.buyCountInWindow}/${MOMENTUM_MIN_BUYS} buys, vol=${(Number(data.volumeLamports)/1e9).toFixed(2)} SOL`,
    });
  }

  // Check 10: Price impact
  {
    if (data.priceImpactBps === null) {
      checks.push({ name: 'price_impact_acceptable', passed: false, reason: 'Price impact unavailable — BLOCKING' });
    } else {
      const passed = data.priceImpactBps <= MAX_PRICE_IMPACT_BPS;
      checks.push({
        name: 'price_impact_acceptable',
        passed,
        reason: passed ? `Price impact OK: ${(data.priceImpactBps/100).toFixed(2)}%` : `Price impact too high: ${(data.priceImpactBps/100).toFixed(2)}%`,
      });
    }
  }

  // Check 11: Bundle
  {
    if (data.bundlePct == null) {
      checks.push({ name: 'bundle_check', passed: false, reason: 'Bundle data unavailable — BLOCKING' });
    } else {
      const passed = data.bundlePct <= MAX_BUNDLE_PCT;
      checks.push({
        name: 'bundle_check',
        passed,
        reason: passed ? `Bundle OK: ${data.bundlePct.toFixed(1)}%` : `TOO BUNDLED: ${data.bundlePct.toFixed(1)}%`,
      });
    }
  }

  // Check 12: Wash trade
  {
    if (data.washTradeScore == null) {
      checks.push({ name: 'wash_trade_check', passed: false, reason: 'Wash trade data unavailable — BLOCKING' });
    } else {
      const passed = data.washTradeScore <= MAX_WASH_TRADE_SCORE;
      checks.push({
        name: 'wash_trade_check',
        passed,
        reason: passed ? `Wash trade OK: ${data.washTradeScore.toFixed(0)}/100` : `WASH TRADE: score ${data.washTradeScore.toFixed(0)}/100`,
      });
    }
  }

  // Check 13: Unique wallets
  {
    if (data.uniqueWallets == null) {
      checks.push({ name: 'unique_wallets', passed: false, reason: 'Wallet count unavailable — BLOCKING' });
    } else {
      const passed = data.uniqueWallets >= MIN_UNIQUE_WALLETS;
      checks.push({
        name: 'unique_wallets',
        passed,
        reason: passed ? `Unique wallets OK: ${data.uniqueWallets}` : `Too few wallets: ${data.uniqueWallets} (min ${MIN_UNIQUE_WALLETS})`,
      });
    }
  }

  // Check 14: Sell pressure
  {
    if (data.sellCountInWindow == null || data.buyCountInWindow === 0) {
      checks.push({ name: 'sell_pressure', passed: true, reason: 'Sell pressure tracking not active — skipping' });
    } else {
      const total = data.buyCountInWindow + data.sellCountInWindow;
      const ratio = total > 0 ? (data.sellCountInWindow / total) * 100 : 0;
      const passed = ratio <= MAX_SELL_RATIO_PCT;
      checks.push({
        name: 'sell_pressure',
        passed,
        reason: passed ? `Sell pressure OK: ${ratio.toFixed(0)}%` : `HIGH SELL PRESSURE: ${ratio.toFixed(0)}%`,
      });
    }
  }

  // Check 15: Liquidity depth
  {
    if (data.realSolReservesLamports == null) {
      checks.push({ name: 'liquidity_depth', passed: false, reason: 'SOL reserves unavailable — BLOCKING' });
    } else {
      const passed = data.realSolReservesLamports >= MIN_LIQUIDITY_DEPTH_LAMPORTS;
      checks.push({
        name: 'liquidity_depth',
        passed,
        reason: passed
          ? `Liquidity depth OK: ${(Number(data.realSolReservesLamports)/1e9).toFixed(2)} SOL`
          : `Insufficient liquidity: ${(Number(data.realSolReservesLamports)/1e9).toFixed(4)} SOL`,
      });
    }
  }

  // Check 16: Holder-bundle ratio
  {
    if (data.holderCount == null || data.holderCount === 0 || data.bundlePct == null) {
      checks.push({ name: 'holder_bundle_ratio', passed: true, reason: 'Holder/bundle data unavailable — skipping' });
    } else {
      const lowHolders = data.holderCount < HOLDER_BUNDLE_MAX_HOLDERS;
      const highBundle = data.bundlePct > HOLDER_BUNDLE_MAX_BUNDLE_PCT;
      const passed = !(lowHolders && highBundle);
      checks.push({
        name: 'holder_bundle_ratio',
        passed,
        reason: passed
          ? `Holder/bundle OK: ${data.holderCount} holders, ${data.bundlePct.toFixed(1)}% bundled`
          : `SUSPICIOUS: ${data.holderCount} holders with ${data.bundlePct.toFixed(1)}% bundled`,
      });
    }
  }

  // Check 17: Holder-MCap ratio
  {
    if (data.holderCount == null || data.marketCapUsd == null || data.marketCapUsd <= 0) {
      checks.push({ name: 'holder_mcap_ratio', passed: true, reason: 'Holder/MCap data unavailable — skipping' });
    } else {
      const ratio = data.holderCount / data.marketCapUsd;
      const ageSec = data.secondsSinceLaunch ?? 9999;
      const ageMultiplier = ageSec < 300 ? 1.33 : ageSec < 600 ? 1.17 : 1.0;
      const effectiveMax = MAX_HOLDER_MCAP_RATIO * ageMultiplier;
      const passed = ratio <= effectiveMax;
      checks.push({
        name: 'holder_mcap_ratio',
        passed,
        reason: passed
          ? `Holder/MCap OK: ratio ${ratio.toFixed(4)} (max ${effectiveMax.toFixed(4)})`
          : `HOLDER INFLATION: ratio ${ratio.toFixed(4)} (max ${effectiveMax.toFixed(4)})`,
      });
    }
  }

  // Check 18: Volume-MCap ratio
  {
    if (data.volumeUsd == null || data.marketCapUsd == null || data.marketCapUsd <= 0) {
      checks.push({ name: 'volume_mcap_ratio', passed: true, reason: 'Volume/MCap data unavailable — skipping' });
    } else {
      const ratio = data.volumeUsd / data.marketCapUsd;
      const passed = ratio <= MAX_VOLUME_MCAP_RATIO;
      checks.push({
        name: 'volume_mcap_ratio',
        passed,
        reason: passed
          ? `Volume/MCap OK: ${ratio.toFixed(1)}x`
          : `WASH TRADE SUSPECTED: ${ratio.toFixed(1)}x (max ${MAX_VOLUME_MCAP_RATIO}x)`,
      });
    }
  }

  // Check 19: Smart money (BOOST — never blocks)
  checks.push({
    name: 'smart_money',
    passed: true,
    reason: data.smartMoneyScore != null && data.smartMoneyScore >= 0.5
      ? `SMART MONEY DETECTED: score ${data.smartMoneyScore.toFixed(3)}`
      : 'No smart money data — skipping (boost only)',
  });

  // ========== NEW CHECK 20: MIN TOKEN AGE ==========
  {
    if (data.secondsSinceLaunch == null) {
      checks.push({ name: 'min_token_age', passed: true, reason: 'Token age unknown — skipping (no launch timestamp)' });
    } else {
      const passed = data.secondsSinceLaunch >= MIN_TOKEN_AGE_SECONDS;
      checks.push({
        name: 'min_token_age',
        passed,
        reason: passed
          ? `Token age OK: ${data.secondsSinceLaunch}s (min ${MIN_TOKEN_AGE_SECONDS}s)`
          : `TOO YOUNG: ${data.secondsSinceLaunch}s old (min ${MIN_TOKEN_AGE_SECONDS}s) — bot chaos zone`,
      });
    }
  }

  // ========== NEW CHECK 21: MAX BUY MCAP ==========
  {
    if (data.marketCapUsd == null || data.marketCapUsd <= 0) {
      checks.push({ name: 'max_buy_mcap', passed: true, reason: 'Market cap unknown — skipping' });
    } else {
      const passed = data.marketCapUsd <= MAX_BUY_MCAP_USD;
      checks.push({
        name: 'max_buy_mcap',
        passed,
        reason: passed
          ? `MCap OK: $${data.marketCapUsd.toFixed(0)} (max $${MAX_BUY_MCAP_USD.toLocaleString()})`
          : `MCAP TOO HIGH: $${data.marketCapUsd.toFixed(0)} (max $${MAX_BUY_MCAP_USD.toLocaleString()})`,
      });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('ENTRY DECISION SIMULATION — 21 CHECKS');
  console.log(`Token: ${MINT}`);
  console.log('='.repeat(70));

  // Fetch data
  const [dexData, pumpData, solPrice] = await Promise.all([
    fetchDexScreener(MINT).catch(() => null),
    fetchPumpfunToken(MINT).catch(() => null),
    fetchSolPrice().catch(() => 150),
  ]);

  const pair = dexData?.pairs?.[0] ?? null;
  const createdAt = pair?.pairCreatedAt ? new Date(pair.pairCreatedAt) : (pumpData?.created_timestamp ? new Date(pumpData.created_timestamp) : null);
  const secondsSinceLaunch = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 1000) : null;
  const marketCapUsd = pair?.marketCap ?? pair?.fdv ?? pumpData?.usd_market_cap ?? null;

  console.log(`\nToken Info:`);
  console.log(`  Name:     ${pair?.baseToken?.name ?? pumpData?.name ?? 'N/A'}`);
  console.log(`  Symbol:   ${pair?.baseToken?.symbol ?? pumpData?.symbol ?? 'N/A'}`);
  console.log(`  Age:      ${secondsSinceLaunch ?? 'N/A'} seconds (${secondsSinceLaunch ? (secondsSinceLaunch/60).toFixed(1) : 'N/A'} min)`);
  console.log(`  MCap:     $${marketCapUsd?.toLocaleString() ?? 'N/A'}`);
  console.log(`  SOL:      $${solPrice.toFixed(2)}`);

  // Build entry check data (simulate what dataProvider does)
  const entryData = {
    mint: MINT,
    launchDetected: true, // if we detected it via momentum, it's launched
    creatorNotBlacklisted: true, // would need DB check
    creatorHistoryAcceptable: true, // would need DB check
    creatorScore: 50, // placeholder — real score from creator stats
    mintAuthorityRevoked: true, // pump.fun tokens always revoke
    freezeAuthorityRevoked: true, // pump.fun tokens always revoke
    metadataSane: true, // would need metadata check
    liquiditySane: pair != null || pumpData != null, // has data = has liquidity
    walletConcentrationAcceptable: true, // would need top holders check
    buyCountInWindow: pair?.txns?.h24?.buys ?? 0,
    volumeLamports: BigInt(Math.round((pair?.volume?.h24 ?? 0) / solPrice * 1e9)),
    windowMs: 30_000,
    priceImpactBps: null, // depends on position size vs liquidity
    bundlePct: null, // would need bundle detector
    washTradeScore: null, // would need wash trade detector
    uniqueWallets: null, // from momentum signal
    sellCountInWindow: pair?.txns?.h24?.sells ?? null,
    realSolReservesLamports: pumpData?.virtual_sol_reserves ? BigInt(pumpData.virtual_sol_reserves) : null,
    holderCount: null, // would need Helius API
    secondsSinceLaunch,
    marketCapUsd,
    volumeUsd: pair?.volume?.h24 ?? null,
    smartMoneyScore: null,
    smartWalletCount: 0,
  };

  // Run checks
  const checks = runEntryChecks(entryData);
  const passed = checks.filter(c => c.passed);
  const failed = checks.filter(c => !c.passed);

  console.log('\n' + '-'.repeat(70));
  console.log(`ENTRY DECISION: ${failed.length === 0 ? '✅ ALLOWED' : '❌ REJECTED'}`);
  console.log(`Passed: ${passed.length}/${checks.length} | Failed: ${failed.length}/${checks.length}`);
  console.log('-'.repeat(70));

  // Print all checks
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const icon = c.passed ? '✅' : '❌';
    const isNew = i >= 19; // checks 20-21 are new
    const tag = isNew ? ' [NEW]' : '';
    console.log(`  ${icon} Check ${(i+1).toString().padStart(2)}: ${c.name}${tag}`);
    console.log(`           ${c.reason}`);
  }

  // Highlight the new filters specifically
  console.log('\n' + '='.repeat(70));
  console.log('NEW FILTERS SUMMARY:');
  console.log('='.repeat(70));
  const ageCheck = checks[19]; // Check 20
  const mcapCheck = checks[20]; // Check 21
  console.log(`\n  Check 20 — Min Token Age (${MIN_TOKEN_AGE_SECONDS}s minimum):`);
  console.log(`    ${ageCheck.passed ? '✅' : '❌'} ${ageCheck.reason}`);
  console.log(`\n  Check 21 — Max Buy MCap ($${MAX_BUY_MCAP_USD.toLocaleString()} maximum):`);
  console.log(`    ${mcapCheck.passed ? '✅' : '❌'} ${mcapCheck.reason}`);

  // Threshold sensitivity analysis
  console.log('\n' + '-'.repeat(70));
  console.log('THRESHOLD SENSITIVITY:');
  console.log('-'.repeat(70));

  console.log('\n  Min Token Age scenarios:');
  for (const t of [0, 15, 30, 60, 120, 300]) {
    const ok = secondsSinceLaunch != null && secondsSinceLaunch >= t;
    console.log(`    ${ok ? '✅' : '❌'} >= ${t}s: ${ok ? 'PASS' : 'BLOCK'} (age=${secondsSinceLaunch ?? 'N/A'}s)`);
  }

  console.log('\n  Max Buy MCap scenarios:');
  for (const t of [5000, 10000, 25000, 50000, 100000, 200000]) {
    const ok = marketCapUsd != null && marketCapUsd <= t;
    console.log(`    ${ok ? '✅' : '❌'} <= $${t.toLocaleString()}: ${ok ? 'PASS' : 'BLOCK'} (mcap=$${marketCapUsd?.toLocaleString() ?? 'N/A'})`);
  }

  console.log('\n' + '='.repeat(70));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
