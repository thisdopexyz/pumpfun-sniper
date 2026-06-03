#!/usr/bin/env node
/**
 * Test script: Min Token Age + Max Buy MCap filter
 *
 * Analyzes a token to get:
 *   1. Token age (seconds since launch)
 *   2. Current market cap (USD)
 *   3. Whether it would pass proposed filter thresholds
 *
 * Usage: node scripts/test-age-mcap-filter.mjs <MINT_ADDRESS>
 */

const MINT = process.argv[2] || 'EAorJYfXsMJs779dDJSBSvgrhAgdcC3XWoTGP7tXpump';

// ---------------------------------------------------------------------------
// DexScreener fetch
// ---------------------------------------------------------------------------

async function fetchDexScreener(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  console.log(`[dexscreener] Fetching ${url}`);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// PumpFun API fetch (for bonding curve / launch data)
// ---------------------------------------------------------------------------

async function fetchPumpfunToken(mint) {
  const url = `https://frontend-api-v3.pump.fun/coins/${mint}`;
  console.log(`[pumpfun] Fetching ${url}`);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    console.log(`[pumpfun] API returned ${res.status}, trying alt...`);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Birdeye token overview (public endpoint)
// ---------------------------------------------------------------------------

async function fetchBirdeyeToken(mint) {
  const url = `https://public-api.birdeye.so/defi/token_overview?address=${mint}`;
  console.log(`[birdeye] Fetching token overview...`);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'x-chain': 'solana',
    },
  });
  if (!res.ok) {
    console.log(`[birdeye] API returned ${res.status}`);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log(`TOKEN ANALYSIS: ${MINT}`);
  console.log('='.repeat(70));

  // Fetch all data sources in parallel
  const [dexData, pumpData, birdeyeData] = await Promise.all([
    fetchDexScreener(MINT).catch(e => { console.error('[dexscreener] Error:', e.message); return null; }),
    fetchPumpfunToken(MINT).catch(e => { console.error('[pumpfun] Error:', e.message); return null; }),
    fetchBirdeyeToken(MINT).catch(e => { console.error('[birdeye] Error:', e.message); return null; }),
  ]);

  // --- DexScreener data ---
  console.log('\n' + '-'.repeat(50));
  console.log('DEXSCREENER DATA:');
  console.log('-'.repeat(50));
  const pair = dexData?.pairs?.[0] ?? null;
  if (pair) {
    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
    const ageSeconds = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 1000) : null;
    const ageMinutes = ageSeconds !== null ? (ageSeconds / 60).toFixed(1) : 'N/A';
    const ageHours = ageSeconds !== null ? (ageSeconds / 3600).toFixed(2) : 'N/A';

    console.log(`  DEX:            ${pair.dexId}`);
    console.log(`  Pair:           ${pair.pairAddress}`);
    console.log(`  Base Token:     ${pair.baseToken?.name} (${pair.baseToken?.symbol})`);
    console.log(`  Created At:     ${createdAt?.toISOString() ?? 'N/A'}`);
    console.log(`  Token Age:      ${ageSeconds ?? 'N/A'} seconds (${ageMinutes} min / ${ageHours} hours)`);
    console.log(`  Price USD:      $${pair.priceUsd ?? 'N/A'}`);
    console.log(`  Market Cap:     $${pair.marketCap ?? pair.fdv ?? 'N/A'} (mcap) / $${pair.fdv ?? 'N/A'} (fdv)`);
    console.log(`  Liquidity:      $${pair.liquidity?.usd ?? 'N/A'}`);
    console.log(`  Volume 24h:     $${pair.volume?.h24 ?? 'N/A'}`);
    console.log(`  Price Change:`);
    console.log(`    5m:           ${pair.priceChange?.m5 ?? 'N/A'}%`);
    console.log(`    1h:           ${pair.priceChange?.h1 ?? 'N/A'}%`);
    console.log(`    6h:           ${pair.priceChange?.h6 ?? 'N/A'}%`);
    console.log(`    24h:          ${pair.priceChange?.h24 ?? 'N/A'}%`);
    console.log(`  Txns (24h):     buy=${pair.txns?.h24?.buys ?? 'N/A'} sell=${pair.txns?.h24?.sells ?? 'N/A'}`);
    console.log(`  Website:        ${pair.info?.websites?.[0]?.url ?? 'N/A'}`);
    console.log(`  Twitter:        ${pair.info?.socials?.find(s => s.type === 'twitter')?.url ?? 'N/A'}`);

    // --- Filter simulation ---
    console.log('\n' + '-'.repeat(50));
    console.log('FILTER SIMULATION:');
    console.log('-'.repeat(50));

    const mcap = pair.marketCap ?? pair.fdv ?? null;

    // Min Token Age scenarios
    const ageThresholds = [0, 30, 60, 120, 300, 600]; // seconds
    console.log('\n  MIN TOKEN AGE (seconds since launch):');
    for (const threshold of ageThresholds) {
      const pass = ageSeconds !== null && ageSeconds >= threshold;
      const marker = pass ? '✅ PASS' : '❌ BLOCK';
      console.log(`    Age >= ${threshold}s (${(threshold/60).toFixed(0)}min): ${marker} (age=${ageSeconds ?? 'N/A'}s)`);
    }

    // Max Buy MCap scenarios
    const mcapThresholds = [5000, 10000, 20000, 50000, 100000, 200000]; // USD
    console.log('\n  MAX BUY MCAP (USD):');
    if (mcap) {
      for (const threshold of mcapThresholds) {
        const pass = mcap <= threshold;
        const marker = pass ? '✅ PASS' : '❌ BLOCK';
        console.log(`    MCap <= $${threshold.toLocaleString()}: ${marker} (mcap=$${mcap.toLocaleString()})`);
      }
    } else {
      console.log('    No market cap data available');
    }
  } else {
    console.log('  No DexScreener pair found');
  }

  // --- PumpFun data ---
  console.log('\n' + '-'.repeat(50));
  console.log('PUMPFUN DATA:');
  console.log('-'.repeat(50));
  if (pumpData) {
    const createdAtPf = pumpData.created_timestamp ? new Date(pumpData.created_timestamp) : null;
    const ageSecondsPf = createdAtPf ? Math.floor((Date.now() - createdAtPf.getTime()) / 1000) : null;

    console.log(`  Name:           ${pumpData.name}`);
    console.log(`  Symbol:         ${pumpData.symbol}`);
    console.log(`  Created:        ${createdAtPf?.toISOString() ?? 'N/A'}`);
    console.log(`  Token Age:      ${ageSecondsPf ?? 'N/A'} seconds`);
    console.log(`  Complete:       ${pumpData.complete ?? 'N/A'}`);
    console.log(`  Market Cap:     $${pumpData.usd_market_cap ?? pumpData.market_cap ?? 'N/A'}`);
    console.log(`  Virtual SOL:    ${pumpData.virtual_sol_reserves ?? 'N/A'}`);
    console.log(`  Virtual Token:  ${pumpData.virtual_token_reserves ?? 'N/A'}`);
    console.log(`  Reply Count:    ${pumpData.reply_count ?? 'N/A'}`);
    console.log(`  Creator:        ${pumpData.creator ?? 'N/A'}`);
  } else {
    console.log('  No PumpFun data available (token may have graduated to Raydium)');
  }

  // --- Birdeye data ---
  console.log('\n' + '-'.repeat(50));
  console.log('BIRDEYE DATA:');
  console.log('-'.repeat(50));
  if (birdeyeData?.data) {
    const d = birdeyeData.data;
    console.log(`  Name:           ${d.name}`);
    console.log(`  Symbol:         ${d.symbol}`);
    console.log(`  Price USD:      $${d.price ?? 'N/A'}`);
    console.log(`  Market Cap:     $${d.mc ?? d.realMc ?? 'N/A'}`);
    console.log(`  24h Volume:     $${d.v24hUSD ?? 'N/A'}`);
    console.log(`  Liquidity:      $${d.liquidity ?? 'N/A'}`);
    console.log(`  Holders:        ${d.holder ?? 'N/A'}`);
    console.log(`  Created At:     ${d.creationTime ? new Date(d.creationTime * 1000).toISOString() : 'N/A'}`);
  } else {
    console.log('  No Birdeye data available');
  }

  // --- Summary ---
  console.log('\n' + '='.repeat(70));
  console.log('RECOMMENDED THRESHOLDS:');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Min Token Age:  30-60 seconds (avoid instant-snipe bot wars)');
  console.log('  Max Buy MCap:   $30,000-$50,000 (catch tokens before they moon)');
  console.log('');
  console.log('  Rationale:');
  console.log('  - 0s age = too early, likely bot territory + no real organic activity');
  console.log('  - 30-60s age = enough time for first wave of organic buyers');
  console.log('  - >$50k mcap = already pumped, diminishing returns for 0.23$ entry');
  console.log('  - <$5k mcap = too risky, could be dead on arrival');
  console.log('');
  console.log('='.repeat(70));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
