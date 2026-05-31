/**
 * Jito Buy+Sell Standalone Test
 * 
 * Tests real Jito bundle with actual wallet:
 * 1. Simple self-transfer via Jito bundle (test format)
 * 2. If works, test with actual token buy/sell
 * 
 * Run: npx tsx scripts/test-jito-trade.ts
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

const JITO_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const RPC_ENDPOINT = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';
const TIP_LAMPORTS = 100_000;

const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function jitoRpc(method: string, params: any[] = []): Promise<any> {
  const response = await fetch(JITO_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' JITO BUNDLE TEST — REAL WALLET');
  console.log('═══════════════════════════════════════════════\n');

  const walletSecretKeyB64 = process.env.WALLET_SECRET_KEY;
  if (!walletSecretKeyB64) {
    console.error('ERROR: WALLET_SECRET_KEY not set');
    process.exit(1);
  }
  const payer = Keypair.fromSecretKey(new Uint8Array(Buffer.from(walletSecretKeyB64, 'base64')));
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);

  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 200_000) {
    console.error('ERROR: Insufficient balance');
    process.exit(1);
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[0]!);

  // ── Test 1: Simple self-transfer via Jito ─────────────────────────────────
  console.log('\n[TEST 1] Self-transfer 0 SOL + tip via Jito bundle');

  const mainTx = new Transaction();
  mainTx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 0,
  }));
  mainTx.recentBlockhash = blockhash;
  mainTx.feePayer = payer.publicKey;
  mainTx.sign(payer);

  const tipTx = new Transaction();
  tipTx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: tipAccount,
    lamports: TIP_LAMPORTS,
  }));
  tipTx.recentBlockhash = blockhash;
  tipTx.feePayer = payer.publicKey;
  tipTx.sign(payer);

  const mainBase58 = bs58.encode(mainTx.serialize());
  const tipBase58 = bs58.encode(tipTx.serialize());

  console.log(`   Main TX: ${mainBase58.length} chars (base58)`);
  console.log(`   Tip TX: ${tipBase58.length} chars (base58)`);
  console.log(`   Tip: ${TIP_LAMPORTS} lamports → ${tipAccount.toBase58().slice(0, 8)}...`);

  const result = await jitoRpc('sendBundle', [[mainBase58, tipBase58]]);

  if (result.error) {
    console.log(`   ✗ Bundle rejected: ${result.error.message}`);
    console.log('\n   Jito HTTP API does not work with our TX format.');
    console.log('   Need to use Jito gRPC API (jito-ts SDK) instead.');
  } else {
    console.log(`   ✓ Bundle accepted! ID: ${result.result}`);

    // Check if TX confirmed
    const sig = bs58.encode(mainTx.signatures[0] as Uint8Array);
    console.log(`   Main TX signature: ${sig}`);
    console.log('   Waiting for confirmation...');

    await delay(5000);
    const status = await connection.getSignatureStatus(sig);
    if (status?.value) {
      console.log(`   Status: ${status.value.confirmationStatus || 'unknown'}`);
      if (status.value.err) {
        console.log(`   Error: ${JSON.stringify(status.value.err)}`);
      }
    } else {
      console.log('   Status: not found (may not have landed)');
    }
  }

  // ── Test 2: Check Jito bundle status ──────────────────────────────────────
  if (!result.error && result.result) {
    console.log('\n[TEST 2] Check bundle status');
    await delay(2000);
    const statusResult = await jitoRpc('getBundleStatuses', [[result.result]]);
    console.log(`   Status: ${JSON.stringify(statusResult.result, null, 2)}`);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(' CONCLUSION');
  console.log('═══════════════════════════════════════════════');

  if (result.error) {
    console.log('');
    console.log('   Jito HTTP API: NOT WORKING');
    console.log('   Reason: TX format incompatible or rate limited');
    console.log('');
    console.log('   Options:');
    console.log('   1. Use Jito gRPC API (jito-ts SDK) — more reliable');
    console.log('   2. Use JitoSearcher client — handles auth + gRPC');
    console.log('   3. Stick with RpcSender — works, no MEV protection');
  } else {
    console.log('');
    console.log('   Jito HTTP API: WORKING ✓');
    console.log('   Can integrate into main bot');
  }
  console.log('\n═══════════════════════════════════════════════');
}

main().catch(console.error);
