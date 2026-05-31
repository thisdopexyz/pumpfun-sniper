/**
 * Validate BC vs Jupiter price consistency for graduated tokens.
 * Fetches both prices and simulates the graduationPriceRatio calculation
 * to verify PNL continuity across the BC→Jupiter transition.
 *
 * Usage: npx tsx scripts/verify-graduation-price.mjs [mint]
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const BONDING_CURVE_SEED = 'bonding-curve';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const SCALE = 1_000_000n; // 10^6 — same as computeBondingCurvePriceScaled

function deriveBondingCurvePDA(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    PUMPFUN_PROGRAM,
  )[0];
}

function parseBondingCurveData(data) {
  if (!data || data.length < 49) return null;
  // Layout matches tokenParser.ts:
  // Offset 8:  virtualTokenReserves (u64 LE)
  // Offset 16: virtualSolReserves (u64 LE)
  // Offset 24: realTokenReserves (u64 LE)
  // Offset 32: realSolReserves (u64 LE)
  // Offset 48: complete (u8, 0=active, 1=graduated)
  const virtualTokenReserves = data.readBigUInt64LE(8);
  const virtualSolReserves = data.readBigUInt64LE(16);
  const realSolReserves = data.readBigUInt64LE(32);
  const complete = data[48] === 1;
  return { virtualSolReserves, virtualTokenReserves, realSolReserves, complete };
}

function computeBCPriceScaled(virtualSolReserves, virtualTokenReserves) {
  if (virtualTokenReserves <= 0n) return 0n;
  return virtualSolReserves * SCALE / virtualTokenReserves;
}

async function fetchJupiterPrice(mint) {
  const url = `${JUPITER_PRICE_API}?ids=${mint}&vsToken=${SOL_MINT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      const price = data.data?.[mint]?.price;
      if (typeof price === 'number' && price > 0) return price;
    }
  } catch {}
  return null;
}

async function main() {
  const mintStr = process.argv[2] || 'BqZmWVE8AFCpPoHQWx4hVQ6jtz8ZujP3C8Sd7C71pump';
  const mint = new PublicKey(mintStr);
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log(`\n=== Graduation Price Validator ===`);
  console.log(`Mint: ${mintStr}\n`);

  // 1. Fetch bonding curve
  const bcPDA = deriveBondingCurvePDA(mint);
  const bcAccount = await conn.getAccountInfo(bcPDA);

  let bcPrice = 0n;
  let graduated = false;

  if (bcAccount?.data && bcAccount.data.length >= 49) {
    const parsed = parseBondingCurveData(bcAccount.data);
    if (parsed) {
      graduated = parsed.complete;
      if (!graduated && parsed.virtualTokenReserves > 0n) {
        bcPrice = computeBCPriceScaled(parsed.virtualSolReserves, parsed.virtualTokenReserves);
      }
      console.log(`[BC] virtualSolReserves:  ${parsed.virtualSolReserves} (${Number(parsed.virtualSolReserves) / 1e9} SOL)`);
      console.log(`[BC] virtualTokenReserves: ${parsed.virtualTokenReserves}`);
      console.log(`[BC] realSolReserves:     ${parsed.realSolReserves} (${Number(parsed.realSolReserves) / 1e9} SOL)`);
      console.log(`[BC] complete (graduated): ${parsed.complete}`);
      console.log(`[BC] priceScaled:         ${bcPrice}`);
      console.log(`[BC] priceSOL_per_raw:    ${Number(bcPrice) / 1e6}`);
    } else {
      console.log(`[BC] Parse failed (data length: ${bcAccount.data.length})`);
    }
  } else if (!bcAccount) {
    console.log(`[BC] Account not found — token likely graduated (BC deleted)`);
    graduated = true;
  } else {
    console.log(`[BC] Account data too short: ${bcAccount.data?.length}`);
  }

  // 2. Fetch Jupiter price
  const jupiterPriceSol = await fetchJupiterPrice(mintStr);
  let jupiterScaled = 0n;
  if (jupiterPriceSol !== null) {
    jupiterScaled = BigInt(Math.round(jupiterPriceSol * 1_000_000));
    console.log(`\n[Jupiter] priceSol:       ${jupiterPriceSol} SOL per whole token`);
    console.log(`[Jupiter] scaled (10^6):  ${jupiterScaled}`);
  } else {
    console.log(`\n[Jupiter] Price fetch failed`);
  }

  // 3. Simulate graduation price ratio
  if (bcPrice > 0n && jupiterScaled > 0n) {
    const ratio = bcPrice * SCALE / jupiterScaled;
    const scaledJupiter = jupiterScaled * ratio / SCALE;

    console.log(`\n=== Ratio Simulation ===`);
    console.log(`BC priceScaled:           ${bcPrice}`);
    console.log(`Jupiter scaled:           ${jupiterScaled}`);
    console.log(`ratio = BC * 10^6 / Jup:  ${ratio}`);
    console.log(`ratio (human):            ${(Number(ratio) / 1e6).toFixed(2)}x`);
    console.log(`scaledJupiter = J*r/10^6: ${scaledJupiter}`);
    console.log(`BC vs scaledJupiter diff:  ${bcPrice === scaledJupiter ? 'EXACT MATCH ✅' : `diff=${bcPrice - scaledJupiter} (${((Number(bcPrice) - Number(scaledJupiter)) / Number(bcPrice) * 100).toFixed(2)}%)`}`);

    if (ratio >= 100_000_000n) {
      console.log(`\n⚠️  ratio >= 10^8 — would be REJECTED by guard (cap)`);
      console.log(`   Fallback: raw Jupiter price used`);
      console.log(`   This means PNL will use Jupiter directly (no BC continuity)`);
    } else {
      console.log(`\n✅ ratio < 10^8 — guard PASSES, ratio will be stored`);
    }
  } else if (graduated && jupiterScaled > 0n) {
    console.log(`\n=== Graduated (no BC price) ===`);
    console.log(`BC deleted — Jupiter price used directly: ${jupiterScaled}`);
    console.log(`No ratio needed (no prevHighest from BC)`);
  }

  // 4. PNL simulation with sample entry price
  const entryPrice = 132n; // from the active position
  if (jupiterScaled > 0n) {
    // With ratio correction
    const bcSim = bcPrice > 0n ? bcPrice : 40000n; // simulate if no BC
    const ratio = bcSim > 0n && jupiterScaled > 0n ? bcSim * SCALE / jupiterScaled : SCALE;
    const correctedPrice = ratio < 100_000_000n ? jupiterScaled * ratio / SCALE : jupiterScaled;

    const pnlBps = (correctedPrice - entryPrice) * 10000n / entryPrice;
    const pnlPct = Number(pnlBps) / 100;

    const rawPnlBps = (jupiterScaled - entryPrice) * 10000n / entryPrice;
    const rawPnlPct = Number(rawPnlBps) / 100;

    console.log(`\n=== PNL Simulation (entry=${entryPrice}) ===`);
    console.log(`Raw Jupiter PNL:          ${rawPnlPct.toFixed(2)}%`);
    console.log(`Ratio-corrected PNL:      ${pnlPct.toFixed(2)}%`);
    console.log(`Scale-out tier 1 (+100%): ${pnlPct >= 100 ? 'WOULD TRIGGER ⚡' : 'not yet'}`);
    console.log(`Scale-out tier 2 (+300%): ${pnlPct >= 300 ? 'WOULD TRIGGER ⚡' : 'not yet'}`);
    console.log(`Scale-out tier 3 (+500%): ${pnlPct >= 500 ? 'WOULD TRIGGER ⚡' : 'not yet'}`);
  }

  console.log(`\n=== Done ===\n`);
}

main().catch(console.error);
