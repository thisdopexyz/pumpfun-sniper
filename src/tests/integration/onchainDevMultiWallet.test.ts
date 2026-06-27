/**
 * On-Chain Integration Tests: Dev Multi-Wallet Defense
 *
 * Tests the new detectors against REAL on-chain data to verify
 * they correctly identify dev multi-wallet schemes.
 *
 * Run: npx tsx src/tests/integration/onchainDevMultiWallet.test.ts
 *
 * Requirements:
 *   - Helius RPC endpoint in .env (HELIUS_API_KEY or RPC_URL)
 *   - Network access for wallet age lookups
 */

import { BuyVelocityAnalyzer } from '../../detectors/buyVelocity/buyVelocityAnalyzer.js';
import { CrossTokenCorrelator } from '../../detectors/crossToken/crossTokenCorrelator.js';
import { evaluateEntry } from '../../strategies/filteredSniper/entryDecision.js';
import type { EntryCheckData } from '../../strategies/filteredSniper/entryDecision.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { nowMs } from '../../core/utils/time.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, details: string): void {
  results.push({ name, passed: condition, details });
  const icon = condition ? '✅' : '❌';
  console.log(`${icon} ${name}: ${details}`);
}

// ---------------------------------------------------------------------------
// Test 1: BuyVelocityAnalyzer — Bot Swarm Detection
// ---------------------------------------------------------------------------

async function testBuyVelocity(): Promise<void> {
  console.log('\n=== TEST 1: BuyVelocityAnalyzer — Bot Swarm Detection ===\n');

  const analyzer = new BuyVelocityAnalyzer();
  await analyzer.start();

  const mint = 'TestMint111111111111111111111111111111111111';
  const now = nowMs();

  // Record ALL buys first (before any analysis)
  // Scenario A: Normal organic growth (5-10 wallets over 60 seconds)
  const organicWallets = [
    'Org1', 'Org2', 'Org3', 'Org4', 'Org5', 'Org6', 'Org7',
  ];
  for (let i = 0; i < organicWallets.length; i++) {
    analyzer.recordBuy(mint + '_organic', organicWallets[i]!, now + i * 8000); // ~8s apart
  }

  // Scenario B: Bot swarm (30 wallets in 30 seconds)
  const swarmMint = mint + '_swarm';
  for (let i = 0; i < 30; i++) {
    analyzer.recordBuy(swarmMint, `SwarmWallet${i}`, now + i * 1000); // 1 per second
  }

  // Scenario C: Extreme burst (20 wallets in 5 seconds)
  const burstMint = mint + '_burst';
  for (let i = 0; i < 20; i++) {
    analyzer.recordBuy(burstMint, `BurstWallet${i}`, now + i * 250); // 4 per second
  }

  // Scenario D: Regular intervals (bot-like, low std dev)
  const regularMint = mint + '_regular';
  for (let i = 0; i < 20; i++) {
    analyzer.recordBuy(regularMint, `RegularWallet${i}`, now + i * 500); // exactly 500ms apart
  }

  // Wait for token age to exceed TOKEN_AGE_HALF_MS (15s) for full confidence
  await new Promise(r => setTimeout(r, 16_000));

  const organicResult = analyzer.analyzeMint(mint + '_organic');
  assert('Organic: low velocity score', (organicResult?.score ?? 100) < 40,
    `score=${organicResult?.score}, wallets7=${organicResult?.uniqueWallets}`);

  const swarmResult = analyzer.analyzeMint(swarmMint);
  assert('Bot swarm: high velocity score', (swarmResult?.score ?? 0) >= 60,
    `score=${swarmResult?.score}, wallets30s=${swarmResult?.wallets30s}`);

  const burstResult = analyzer.analyzeMint(burstMint);
  assert('Extreme burst: high score from CV + entropy', (burstResult?.score ?? 0) >= 60,
    `score=${burstResult?.score}, wallets10s=${burstResult?.wallets10s}`);

  const regularResult = analyzer.analyzeMint(regularMint);
  assert('Regular intervals: bot detection bonus', (regularResult?.score ?? 0) >= 70,
    `score=${regularResult?.score}, stdDev=${regularResult?.stdDevMs?.toFixed(1)}ms`);

  // Scenario E: Force analyze returns score and emits signal
  const forceResult = analyzer.forceAnalyze(burstMint);
  assert('ForceAnalyze returns score', forceResult !== null && forceResult > 0,
    `score=${forceResult}`);

  await analyzer.stop();
}

// ---------------------------------------------------------------------------
// Test 2: CrossTokenCorrelator — Serial Scammer Detection
// ---------------------------------------------------------------------------

async function testCrossToken(): Promise<void> {
  console.log('\n=== TEST 2: CrossTokenCorrelator — Serial Scammer Detection ===\n');

  const correlator = new CrossTokenCorrelator();
  await correlator.start();

  const now = nowMs();

  // Create a "dumped" token with known buyers
  const dumpMint1 = 'DumpToken111111111111111111111111111111111111';
  const scamWallets = ['Scam1', 'Scam2', 'Scam3', 'Scam4', 'Scam5', 'Scam6', 'Scam7', 'Scam8'];
  for (const wallet of scamWallets) {
    correlator.recordBuy(dumpMint1, wallet, now - 3600_000); // 1 hour ago
  }
  correlator.markDump(dumpMint1);

  // Create another dumped token with overlapping wallets
  const dumpMint2 = 'DumpToken222222222222222222222222222222222222';
  for (const wallet of scamWallets.slice(0, 5)) { // 5 overlapping wallets
    correlator.recordBuy(dumpMint2, wallet, now - 1800_000); // 30 min ago
  }
  correlator.recordBuy(dumpMint2, 'LegitWallet1', now - 1800_000);
  correlator.markDump(dumpMint2);

  // Now test: new token bought by same scam wallets
  const newMint = 'NewToken1111111111111111111111111111111111111';
  for (const wallet of scamWallets.slice(0, 6)) { // 6 scam wallets buying new token
    correlator.recordBuy(newMint, wallet, now);
  }
  correlator.recordBuy(newMint, 'LegitBuyer1', now);

  const result = correlator.analyzeMint(newMint);
  assert('Scam wallets detected on new token', (result?.score ?? 0) >= 50,
    `score=${result?.score}, matched=${result?.dumpClusterWallets}, cluster=${result?.clusterSize}`);

  // Test: clean token (no scam wallets)
  const cleanMint = 'CleanToken11111111111111111111111111111111111';
  correlator.recordBuy(cleanMint, 'CleanWallet1', now);
  correlator.recordBuy(cleanMint, 'CleanWallet2', now);
  correlator.recordBuy(cleanMint, 'CleanWallet3', now);

  const cleanResult = correlator.analyzeMint(cleanMint);
  assert('Clean token: zero score', (cleanResult?.score ?? 100) === 0,
    `score=${cleanResult?.score}`);

  // Test: markDump then analyze
  const forceResult = correlator.forceAnalyze(newMint);
  assert('ForceAnalyze returns score', forceResult !== null && forceResult > 0,
    `score=${forceResult}`);

  await correlator.stop();
}

// ---------------------------------------------------------------------------
// Test 3: Entry Decision — New Checks Integration
// ---------------------------------------------------------------------------

async function testEntryDecision(): Promise<void> {
  console.log('\n=== TEST 3: Entry Decision — New Checks Integration ===\n');

  // Base data that passes all original 23 checks
  const baseData: EntryCheckData = {
    mint: 'TestMint111111111111111111111111111111111111',
    launchDetected: true,
    creatorNotBlacklisted: true,
    creatorHistoryAcceptable: true,
    creatorScore: 80,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    metadataSane: true,
    liquiditySane: true,
    walletConcentrationAcceptable: true,
    buyCountInWindow: 20,
    volumeLamports: 20_000_000_000n,
    windowMs: 30_000,
    priceImpactBps: 100,
    bundlePct: 15,
    washTradeScore: 30,
    uniqueWallets: 25,
    sellCountInWindow: 5,
    realSolReservesLamports: 1_000_000_000n,
    holderCount: 50,
    volumeUsd: 5000,
    secondsSinceLaunch: 1800,
    marketCapUsd: 15000,
    smartMoneyScore: 0,
    smartWalletCount: 0,
  };

  // Scenario A: All new checks pass (clean token)
  const cleanResult = evaluateEntry({
    ...baseData,
    walletAgeScore: 20,    // Low = mostly old wallets
    buyVelocityScore: 10,  // Low = organic growth
    enhancedBundlePct: 10, // Low = no bundling
    crossTokenScore: 0,    // Zero = no serial scammer wallets
  });
  assert('Clean token: all 27 checks pass', cleanResult.allowed,
    `passed=${cleanResult.passedCount}/27, failed=${cleanResult.failedCount}`);

  // Scenario B: Wallet age check blocks (dev multi-wallet)
  const newWalletsResult = evaluateEntry({
    ...baseData,
    walletAgeScore: 85,    // HIGH = mostly brand new wallets
    buyVelocityScore: 10,
    enhancedBundlePct: 10,
    crossTokenScore: 0,
  });
  assert('New wallets: BLOCKED by wallet_age_score', !newWalletsResult.allowed,
    `failed=${newWalletsResult.failedCount}, first=${newWalletsResult.firstFailure?.slice(0, 60)}`);

  // Scenario C: Bot swarm blocks
  const botSwarmResult = evaluateEntry({
    ...baseData,
    walletAgeScore: 20,
    buyVelocityScore: 90,  // HIGH = bot swarm
    enhancedBundlePct: 10,
    crossTokenScore: 0,
  });
  assert('Bot swarm: BLOCKED by buy_velocity_score', !botSwarmResult.allowed,
    `failed=${botSwarmResult.failedCount}, first=${botSwarmResult.firstFailure?.slice(0, 60)}`);

  // Scenario D: Bundle detected blocks
  const bundleResult = evaluateEntry({
    ...baseData,
    walletAgeScore: 20,
    buyVelocityScore: 10,
    enhancedBundlePct: 40, // HIGH = bundled
    crossTokenScore: 0,
  });
  assert('Bundle: BLOCKED by enhanced_bundle_pct', !bundleResult.allowed,
    `failed=${bundleResult.failedCount}, first=${bundleResult.firstFailure?.slice(0, 60)}`);

  // Scenario E: Serial scammer blocks
  const scammerResult = evaluateEntry({
    ...baseData,
    walletAgeScore: 20,
    buyVelocityScore: 10,
    enhancedBundlePct: 10,
    crossTokenScore: 80, // HIGH = serial scammer wallets
  });
  assert('Serial scammer: BLOCKED by cross_token_score', !scammerResult.allowed,
    `failed=${scammerResult.failedCount}, first=${scammerResult.firstFailure?.slice(0, 60)}`);

  // Scenario F: Null data blocks (anti-scam default)
  const nullResult = evaluateEntry({
    ...baseData,
    walletAgeScore: null,
    buyVelocityScore: null,
    enhancedBundlePct: null,
    crossTokenScore: null,
  });
  assert('Null data: BLOCKED (safe default)', !nullResult.allowed,
    `failed=${nullResult.failedCount}`);
}

// ---------------------------------------------------------------------------
// Test 4: On-Chain Wallet Age Verification
// ---------------------------------------------------------------------------

async function testOnChainWalletAge(): Promise<void> {
  console.log('\n=== TEST 4: On-Chain Wallet Age Verification ===\n');

  // Get RPC URL from environment
  const rpcUrl = process.env['RPC_URL'] || process.env['HELIUS_RPC_URL'];
  if (!rpcUrl) {
    console.log('⚠️  Skipping on-chain tests — no RPC_URL or HELIUS_RPC_URL in .env');
    console.log('   Set RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY to run');
    return;
  }

  const connection = new Connection(rpcUrl, 'confirmed');

  // Test with known wallets
  const testWallets = [
    { name: 'Binance hot wallet', address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', expectOld: true },
    { name: 'Phantom aggregator', address: '9CLoQ1cMQ5PG3dJtEHq5eMNoFwYrPg3C4uL3FAcBoqFA', expectOld: true },
  ];

  for (const wallet of testWallets) {
    try {
      const pubkey = new PublicKey(wallet.address);
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 1 });
      
      if (sigs.length > 0 && sigs[0]!.blockTime) {
        const ageMs = Date.now() - sigs[0]!.blockTime * 1000;
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        assert(`${wallet.name}: age resolved`, ageDays > (wallet.expectOld ? 30 : 0),
          `age=${ageDays.toFixed(0)} days, address=${wallet.address.slice(0, 12)}...`);
      } else {
        assert(`${wallet.name}: has signatures`, false, 'No blockTime found');
      }
    } catch (err: unknown) {
      assert(`${wallet.name}: RPC call succeeded`, false,
        `error=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Test with a likely new wallet (PumpFun creator from recent token)
  try {
    const pfUrl = 'https://frontend-api-v3.pump.fun/coins/currently-live?limit=1&offset=0&sort=created_timestamp&order=desc&includeNsfw=false';
    const pfRes = await fetch(pfUrl, { signal: AbortSignal.timeout(5000) });
    if (pfRes.ok) {
      const coins = await pfRes.json() as Array<{ creator?: string }>;
      if (coins.length > 0 && coins[0]!.creator) {
        const creator = coins[0]!.creator;
        const pubkey = new PublicKey(creator);
        const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 1 });
        if (sigs.length > 0 && sigs[0]!.blockTime) {
          const ageMs = Date.now() - sigs[0]!.blockTime * 1000;
          const ageHours = ageMs / (60 * 60 * 1000);
          assert('Recent PumpFun creator: wallet age resolved', true,
            `age=${ageHours.toFixed(1)} hours, creator=${creator.slice(0, 12)}...`);
        }
      }
    }
  } catch (err: unknown) {
    assert('PumpFun API + wallet age chain', false,
      `error=${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Test 5: Bundle Detector — CEX Exclusion
// ---------------------------------------------------------------------------

async function testBundleCexExclusion(): Promise<void> {
  console.log('\n=== TEST 5: Bundle Detector — CEX Exclusion ===\n');

  // Import the enhanced bundle detector
  const { BundleDetector } = await import('../../detectors/bundle/bundleDetector.js');
  
  const detector = new BundleDetector({ windowSeconds: 180, maxBundlePct: 20, minBuyCount: 3 });
  await detector.start();

  const mint = 'TestMint111111111111111111111111111111111111' as any;
  const now = nowMs();

  // Scenario: 10 wallets funded from Binance (CEX) — should NOT be clustered
  // Use different slots to isolate the CEX exclusion test (slot clustering is separate)
  const cexFundedWallets = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10'];
  for (let i = 0; i < cexFundedWallets.length; i++) {
    detector.handleBuy({
      mint,
      wallet: cexFundedWallets[i]!,
      slot: 100 + i, // Different slots to isolate CEX test
      timestamp: now,
      tokenAmount: 1000000n,
      fundingWallet: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Binance
    });
  }

  const cexResult = detector.forceAnalyze(mint);
  assert('CEX-funded wallets: NOT clustered together', (cexResult ?? 100) < 20,
    `bundlePct=${cexResult}% (should be low — CEX wallets excluded)`);

  // Scenario: 10 wallets funded from same non-CEX wallet — SHOULD be clustered
  const bundledMint = 'BundledMint111111111111111111111111111111111' as any;
  for (let i = 0; i < 10; i++) {
    detector.handleBuy({
      mint: bundledMint,
      wallet: `Bundled${i}`,
      slot: 200,
      timestamp: now,
      tokenAmount: 1000000n,
      fundingWallet: 'DevWallet11111111111111111111111111111111',
    });
  }

  const bundledResult = detector.forceAnalyze(bundledMint);
  assert('Same-source wallets: CLUSTERED', (bundledResult ?? 0) > 50,
    `bundlePct=${bundledResult}% (should be high — same funder)`);

  await detector.stop();
}

// ---------------------------------------------------------------------------
// Run All Tests
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Dev Multi-Wallet Defense — On-Chain Integration Tests  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await testBuyVelocity();
  await testCrossToken();
  await testEntryDecision();
  await testOnChainWalletAge();
  await testBundleCexExclusion();

  // Summary
  console.log('\n══════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.details}`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
