#!/usr/bin/env node
/**
 * Standalone force-sell script for PumpFun tokens.
 * Usage: node scripts/force-sell.mjs <MINT_ADDRESS>
 *
 * Uses the same @pump-fun/pump-sdk as the bot.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Load .env manually ──────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const envContent = readFileSync(envPath, 'utf8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const require = createRequire(import.meta.url);
const {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, NATIVE_MINT,
} = require('@solana/spl-token');
const BN = require('bn.js');
const pumpSdk = require('@pump-fun/pump-sdk');

const PumpSdk = pumpSdk.PumpSdk;
const GLOBAL_PDA = pumpSdk.GLOBAL_PDA;
const PUMP_FEE_CONFIG_PDA = pumpSdk.PUMP_FEE_CONFIG_PDA;
const getSellSolAmountFromTokenAmount = pumpSdk.getSellSolAmountFromTokenAmount;

// ── Constants ────────────────────────────────────────────────────────
const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const BONDING_CURVE_SEED = 'bonding-curve';
const SLIPPAGE_BPS = 500; // 5%

const PUMPFUN_BUYBACK_FEE_RECIPIENTS = [
  new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
  new PublicKey('9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7'),
  new PublicKey('GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL'),
  new PublicKey('3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR'),
  new PublicKey('5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6'),
  new PublicKey('EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL'),
  new PublicKey('5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD'),
  new PublicKey('A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'),
];

// ── Helpers ──────────────────────────────────────────────────────────
function toBN(v) { return new BN(v.toString()); }
function bnToBigInt(v) { return BigInt(v.toString()); }

function deriveBondingCurvePDA(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}

function parseBondingCurveData(data) {
  if (data.length < 49) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    complete: data[48] === 1,
  };
}

function readPublicKey(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) {
    console.error('Usage: node scripts/force-sell.mjs <MINT_ADDRESS>');
    process.exit(1);
  }

  // Use first Helius key from extra pool (or legacy HELIUS_API_KEY if set).
  // Manual sells need a real RPC to fetch blockhash + bonding curve + send tx
  // — public RPC will 429. This matches the bot's runtime key pool.
  const HELIUS_KEY = process.env.HELIUS_API_KEY
    ?? process.env.HELIUS_EXTRA_KEYS?.split(',')[0]?.trim();
  const RPC_URL = HELIUS_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : 'https://api.mainnet-beta.solana.com';

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load wallet
  const secretKeyB64 = process.env.WALLET_SECRET_KEY;
  if (!secretKeyB64) {
    console.error('WALLET_SECRET_KEY not found in .env');
    process.exit(1);
  }
  const secretKey = Uint8Array.from(Buffer.from(secretKeyB64, 'base64'));
  const wallet = Keypair.fromSecretKey(secretKey);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const mint = new PublicKey(mintStr);
  console.log(`Mint: ${mint.toBase58()}`);

  // Detect token program (Token-2022 vs Token)
  let tokenProgram = TOKEN_PROGRAM_ID;
  const mintAccountInfo = await connection.getAccountInfo(mint);
  if (mintAccountInfo && mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    tokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  // Get token balance
  const userAta = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram);
  const ataInfo = await connection.getTokenAccountBalance(userAta).catch(() => null);
  if (!ataInfo || BigInt(ataInfo.value.amount) === 0n) {
    console.error('No token balance found in wallet ATA');
    process.exit(1);
  }

  const tokenAmount = BigInt(ataInfo.value.amount);
  console.log(`Token balance: ${ataInfo.value.uiAmountString} (${tokenAmount} raw)`);

  // Fetch bonding curve
  const bcPDA = deriveBondingCurvePDA(mint);
  console.log(`Bonding curve PDA: ${bcPDA.toBase58()}`);

  const bcAccount = await connection.getAccountInfo(bcPDA);
  if (!bcAccount?.data || bcAccount.data.length < 49) {
    console.error('Bonding curve account not found or invalid');
    process.exit(1);
  }

  const parsed = parseBondingCurveData(bcAccount.data);
  if (!parsed) {
    console.error('Failed to parse bonding curve data');
    process.exit(1);
  }

  // Read creator from bonding curve data (offset 49 = after complete flag)
  // Layout after complete byte: creator (32 bytes) + padding
  let creator = null;
  if (bcAccount.data.length >= 49 + 32) {
    creator = readPublicKey(bcAccount.data, 49);
  }
  if (!creator) {
    // Try alternate offset
    if (bcAccount.data.length >= 8 + 5*8 + 1 + 32) {
      creator = readPublicKey(bcAccount.data, 8 + 5*8 + 1);
    }
  }
  if (!creator) {
    console.error('Could not read creator from bonding curve data');
    process.exit(1);
  }
  console.log(`Creator: ${creator.toBase58()}`);
  console.log(`Bonding curve complete (graduated): ${parsed.complete}`);

  if (parsed.complete) {
    console.error('Token has graduated to Raydium — need Jupiter sell (not implemented in this script)');
    console.error('Sell manually via Phantom or Jupiter aggregator');
    process.exit(1);
  }

  // Build sell quote using official SDK
  const sdk = new PumpSdk();

  const [globalAccount, feeConfigAccount, mintSupplyResult] = await Promise.all([
    connection.getAccountInfo(GLOBAL_PDA),
    connection.getAccountInfo(PUMP_FEE_CONFIG_PDA),
    connection.getTokenSupply(mint),
  ]);

  if (!globalAccount) {
    console.error('Pump.fun global account not found');
    process.exit(1);
  }

  const global = sdk.decodeGlobal(globalAccount);
  const feeConfig = feeConfigAccount ? sdk.decodeFeeConfig(feeConfigAccount) : null;
  const mintSupply = toBN(mintSupplyResult.value.amount);

  const bondingCurve = {
    virtualTokenReserves: toBN(parsed.virtualTokenReserves),
    virtualQuoteReserves: toBN(parsed.virtualSolReserves),
    realTokenReserves: toBN(parsed.realTokenReserves),
    realQuoteReserves: toBN(parsed.realSolReserves),
    tokenTotalSupply: mintSupply,
    complete: parsed.complete,
    creator: creator,
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: NATIVE_MINT,
  };

  const sellQuoteSol = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply, bondingCurve,
    amount: toBN(tokenAmount),
  });

  const expectedSolOutput = bnToBigInt(sellQuoteSol);
  const minSolOutput = expectedSolOutput - (expectedSolOutput * BigInt(SLIPPAGE_BPS) / 10_000n);

  console.log(`Expected SOL output: ${Number(expectedSolOutput) / 1e9} SOL`);
  console.log(`Min SOL output (5% slippage): ${Number(minSolOutput) / 1e9} SOL`);

  // Select fee accounts
  const recipients = [global.feeRecipient, ...(global.feeRecipients ?? [])];
  const validRecipients = recipients.filter(r => r instanceof PublicKey && !r.equals(PublicKey.default));
  if (validRecipients.length === 0) {
    console.error('No valid fee recipients');
    process.exit(1);
  }
  const feeRecipient = validRecipients[Math.floor(Math.random() * validRecipients.length)];
  const buybackFeeRecipient = PUMPFUN_BUYBACK_FEE_RECIPIENTS[
    Math.floor(Math.random() * PUMPFUN_BUYBACK_FEE_RECIPIENTS.length)
  ];

  console.log(`Fee recipient: ${feeRecipient.toBase58()}`);
  console.log(`Buyback fee recipient: ${buybackFeeRecipient.toBase58()}`);

  // Build sell instruction
  console.log('\nBuilding sell transaction...');

  let instructions = [];

  // For Token-2022, need to create wSOL ATA
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const userQuoteAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID,
    );
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userQuoteAta, wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
      ),
    );

    const sellIx = await sdk.getSellV2InstructionRaw({
      user: wallet.publicKey,
      mint,
      creator,
      amount: toBN(tokenAmount),
      quoteAmount: toBN(minSolOutput),
      feeRecipient,
      buybackFeeRecipient,
      tokenProgram,
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    instructions.push(sellIx);

    instructions.push(
      createCloseAccountInstruction(
        userQuoteAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID,
      ),
    );
  } else {
    // Standard SPL Token — use venue.buildSwap equivalent
    // We build manually using the SDK
    const sellIx = await sdk.getSellV2InstructionRaw({
      user: wallet.publicKey,
      mint,
      creator,
      amount: toBN(tokenAmount),
      quoteAmount: toBN(minSolOutput),
      feeRecipient,
      buybackFeeRecipient,
      tokenProgram: TOKEN_PROGRAM_ID,
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    instructions.push(sellIx);
  }

  // Build versioned transaction
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  console.log('Sending transaction...');
  try {
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    console.log(`\n✅ TX sent! Signature: ${sig}`);
    console.log(`Explorer: https://solscan.io/tx/${sig}`);

    // Wait for confirmation
    console.log('Waiting for confirmation...');
    const status = await connection.confirmTransaction({
      signature: sig,
      blockhash,
      lastValidBlockHeight: (await connection.getBlockHeight()) + 150,
    }, 'confirmed');

    if (status.value.err) {
      console.error(`❌ TX failed on-chain: ${JSON.stringify(status.value.err)}`);
    } else {
      console.log('✅ TX CONFIRMED! Token sold.');
    }
  } catch (err) {
    console.error(`❌ Send failed: ${err.message}`);
    if (err.logs) console.error('Logs:', err.logs.join('\n'));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
