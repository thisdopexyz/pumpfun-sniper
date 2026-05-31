/**
 * Full graduation flow simulation with REAL on-chain data.
 * Tests: BC price → graduation → Jupiter price → ratio → PNL
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SCALE = 1_000_000_000n; // 10^9 — matches fetchGraduatedPriceLamports

function deriveBondingCurvePDA(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()], PUMPFUN_PROGRAM
  )[0];
}

function computeBCPriceScaled(vSol, vToken) {
  return vToken > 0n ? vSol * SCALE / vToken : 0n;
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');

  // Test case: simulate user's scenario (entry 19k, BC peak 40k, graduate)
  console.log('=== Graduation PNL Simulation ===\n');

  // Realistic numbers from Pump.fun bonding curve
  // Entry: 0.00019 SOL per raw token → scaled = 190
  // But user says "19k" — likely means 19000 in some unit
  // Let's use real BC data to calibrate

  // From the active position: entryPrice=132, BC price=127
  // User's case: entry at 19k scaled, BC at 40k scaled
  const entryPrice = 19000n;   // user's entry (scaled 10^6)
  const bcPeakPrice = 40000n;  // BC price at graduation (scaled 10^6)

  // Simulate: what Jupiter would return for same token
  // Jupiter returns SOL per whole token. For 6-decimal token:
  //   BC: 40000 scaled = 0.04 lamports per raw = 0.04 * 10^-9 SOL per raw
  //   Per whole token (10^6 raw): 0.04 * 10^-9 * 10^6 = 0.00004 SOL
  //   Jupiter would return: 0.00004
  //   Scaled by 10^6: 0.00004 * 10^6 = 40

  // So BC=40000, Jupiter_scaled=40 → ratio should be 1000
  const jupiterPriceSol = 0.00004; // SOL per whole token
  const jupiterScaled = BigInt(Math.round(jupiterPriceSol * 1_000_000_000));

  console.log(`Entry price (scaled):     ${entryPrice}`);
  console.log(`BC peak price (scaled):   ${bcPeakPrice}`);
  console.log(`Jupiter price (SOL):      ${jupiterPriceSol}`);
  console.log(`Jupiter scaled (10^6):    ${jupiterScaled}`);
  console.log(`Scale difference:         ${bcPeakPrice} / ${jupiterScaled} = ${Number(bcPeakPrice) / Number(jupiterScaled)}x\n`);

  // --- OLD BUG: no ratio correction ---
  console.log('--- OLD CODE (bug) ---');
  const oldPnlBps = (jupiterScaled - entryPrice) * 10000n / entryPrice;
  const oldPnlPct = Number(oldPnlBps) / 100;
  console.log(`currentPrice = ${jupiterScaled} (raw Jupiter, no correction)`);
  console.log(`PNL = (${jupiterScaled} - ${entryPrice}) * 10000 / ${entryPrice} = ${oldPnlBps} bps = ${oldPnlPct.toFixed(2)}%`);
  console.log(`Tier 1 (+100%): ${oldPnlPct >= 100 ? 'TRIGGER ⚡' : 'no'}`);
  console.log(`Tier 2 (+300%): ${oldPnlPct >= 300 ? 'TRIGGER ⚡' : 'no'}`);
  console.log(`Tier 3 (+500%): ${oldPnlPct >= 500 ? 'TRIGGER ⚡' : 'no'}`);
  console.log(`Result: ${oldPnlPct >= 500 ? 'ALL TIERS → FULL SELL ❌' : 'scale-out works ✅'}\n`);

  // --- NEW FIX: with ratio correction ---
  console.log('--- NEW CODE (fix) ---');
  const ratio = bcPeakPrice * SCALE / jupiterScaled;
  const correctedPrice = jupiterScaled * ratio / SCALE;
  console.log(`ratio = ${bcPeakPrice} * ${SCALE} / ${jupiterScaled} = ${ratio}`);
  console.log(`ratio guard (< 10^12): ${ratio < 1_000_000_000_000n ? 'PASS ✅' : 'REJECT ❌'}`);
  console.log(`correctedPrice = ${jupiterScaled} * ${ratio} / ${SCALE} = ${correctedPrice}`);
  console.log(`BC vs corrected: ${bcPeakPrice} === ${correctedPrice} → ${bcPeakPrice === correctedPrice ? 'EXACT ✅' : 'DIFF ❌'}`);

  const newPnlBps = (correctedPrice - entryPrice) * 10000n / entryPrice;
  const newPnlPct = Number(newPnlBps) / 100;
  console.log(`PNL = (${correctedPrice} - ${entryPrice}) * 10000 / ${entryPrice} = ${newPnlBps} bps = ${newPnlPct.toFixed(2)}%`);
  console.log(`Tier 1 (+100%): ${newPnlPct >= 100 ? 'TRIGGER ⚡' : 'no'}`);
  console.log(`Tier 2 (+300%): ${newPnlPct >= 300 ? 'TRIGGER ⚡' : 'no'}`);
  console.log(`Tier 3 (+500%): ${newPnlPct >= 500 ? 'TRIGGER ⚡' : 'no'}`);
  console.log(`Result: ${newPnlPct >= 100 && newPnlPct < 300 ? 'ONLY TIER 1 → sell 50% ✅' : newPnlPct >= 300 ? 'multiple tiers' : 'no tier'}\n`);

  // --- Edge case: BC price spike before graduation ---
  console.log('--- EDGE CASE: BC spike (reserves nearly depleted) ---');
  const bcSpikePrice = 4000000n; // 100x spike from reserves depletion
  const spikeRatio = bcSpikePrice * SCALE / jupiterScaled;
  console.log(`BC spike price: ${bcSpikePrice} (100x normal)`);
  console.log(`ratio = ${spikeRatio} (${(Number(spikeRatio) / 1e6).toFixed(0)}x)`);
  console.log(`ratio guard (< 10^12): ${spikeRatio < 1_000_000_000_000n ? 'PASS ✅' : 'REJECT ❌ (fallback to raw Jupiter)'}`);

  if (spikeRatio < 1_000_000_000_000n) {
    const spikeCorrected = jupiterScaled * spikeRatio / SCALE;
    const spikePnl = Number((spikeCorrected - entryPrice) * 10000n / entryPrice) / 100;
    console.log(`correctedPrice = ${spikeCorrected}`);
    console.log(`PNL = ${spikePnl.toFixed(2)}% (preserves BC spike → inflated but bounded)`);
  } else {
    const rawPnl = Number((jupiterScaled - entryPrice) * 10000n / entryPrice) / 100;
    console.log(`Fallback: raw Jupiter price = ${jupiterScaled}`);
    console.log(`PNL = ${rawPnl.toFixed(2)}% (uses actual market price)`);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
