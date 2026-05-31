/**
 * Jito Bundle API — Legacy Transaction Test
 * 
 * Test if Jito accepts legacy Transaction format
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from '@solana/web3.js';

const JITO_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=c7549260-3918-4ea2-955e-aaa66b01ce4d';
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
  console.log(' JITO — LEGACY vs VERSIONED TX COMPARISON');
  console.log('═══════════════════════════════════════════════\n');

  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const payer = Keypair.generate();
  const { blockhash } = await connection.getLatestBlockhash();

  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[0]!);
  const tipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: tipAccount,
    lamports: TIP_LAMPORTS,
  });
  const noopIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 0,
  });

  // ── Test 1: Legacy Transaction ────────────────────────────────────────────
  console.log('[TEST 1] Legacy Transaction');
  const legacyTx = new Transaction();
  legacyTx.add(noopIx, tipIx);
  legacyTx.recentBlockhash = blockhash;
  legacyTx.feePayer = payer.publicKey;
  legacyTx.sign(payer);

  const legacySerialized = legacyTx.serialize();
  const legacyBase64 = Buffer.from(legacySerialized).toString('base64');
  console.log(`   Serialized: ${legacySerialized.length} bytes`);
  console.log(`   Base64: ${legacyBase64.length} chars`);
  console.log(`   Preview: ${legacyBase64.slice(0, 60)}...`);

  await delay(1100);
  const legacyResult = await jitoRpc('sendBundle', [[legacyBase64]]);
  if (legacyResult.error) {
    console.log(`   Result: ✗ ${legacyResult.error.message}`);
  } else {
    console.log(`   Result: ✓ Bundle ID: ${legacyResult.result}`);
  }
  console.log('');

  // ── Test 2: Versioned Transaction (v0) ────────────────────────────────────
  console.log('[TEST 2] Versioned Transaction (v0)');
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [noopIx, tipIx],
  }).compileToV0Message();

  const v0Tx = new VersionedTransaction(messageV0);
  v0Tx.sign([payer]);

  const v0Serialized = v0Tx.serialize();
  const v0Base64 = Buffer.from(v0Serialized).toString('base64');
  console.log(`   Serialized: ${v0Serialized.length} bytes`);
  console.log(`   Base64: ${v0Base64.length} chars`);
  console.log(`   Preview: ${v0Base64.slice(0, 60)}...`);

  await delay(1100);
  const v0Result = await jitoRpc('sendBundle', [[v0Base64]]);
  if (v0Result.error) {
    console.log(`   Result: ✗ ${v0Result.error.message}`);
  } else {
    console.log(`   Result: ✓ Bundle ID: ${v0Result.result}`);
  }
  console.log('');

  // ── Test 3: Versioned TX serialized differently ──────────────────────────
  console.log('[TEST 3] Versioned TX — serialize() with requireAllSignatures=false');
  try {
    const v0Tx2 = new VersionedTransaction(messageV0);
    v0Tx2.sign([payer]);
    // Try different serialization
    const v0Serialized2 = v0Tx2.serialize();
    const v0Base64_2 = Buffer.from(v0Serialized2).toString('base64');
    console.log(`   Serialized: ${v0Serialized2.length} bytes`);
    
    await delay(1100);
    const v0Result2 = await jitoRpc('sendBundle', [[v0Base64_2]]);
    if (v0Result2.error) {
      console.log(`   Result: ✗ ${v0Result2.error.message}`);
    } else {
      console.log(`   Result: ✓ Bundle ID: ${v0Result2.result}`);
    }
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
  }
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════');
  console.log(' CONCLUSION');
  console.log('═══════════════════════════════════════════════');
  
  if (!legacyResult.error && v0Result.error) {
    console.log('');
    console.log('   Legacy TX: ✓ WORKS');
    console.log('   Versioned: ✗ FAILS');
    console.log('');
    console.log('   SOLUTION: Use legacy Transaction for Jito bundles');
    console.log('   Keep VersionedTransaction for normal RPC sends');
  } else if (legacyResult.error && !v0Result.error) {
    console.log('');
    console.log('   Legacy TX: ✗ FAILS');
    console.log('   Versioned: ✓ WORKS');
    console.log('');
    console.log('   SOLUTION: Use VersionedTransaction (current approach)');
  } else if (legacyResult.error && v0Result.error) {
    console.log('');
    console.log('   Both formats fail!');
    console.log('   Error (legacy):', legacyResult.error?.message);
    console.log('   Error (v0):', v0Result.error?.message);
    console.log('');
    console.log('   Need further investigation...');
  } else {
    console.log('');
    console.log('   Both formats work!');
  }
  console.log('');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
