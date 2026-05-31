/**
 * Jito Bundle API — Real Wallet Test
 * 
 * Test with actual funded wallet to check if format is correct
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
  console.log(' JITO — REAL WALLET TEST');
  console.log('═══════════════════════════════════════════════\n');

  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  
  // Use bot's keypair (has SOL)
  // Load from file or env
  const keypairPath = process.env.KEYPAIR_PATH || '/home/ubuntu/.config/solana/id.json';
  let payer: Keypair;
  
  try {
    const fs = await import('fs');
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    console.log(`   Wallet: ${payer.publicKey.toBase58()}`);
  } catch (err: any) {
    console.log(`   Cannot load keypair: ${err.message}`);
    console.log('   Using generated keypair (no SOL)');
    payer = Keypair.generate();
  }

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`   Balance: ${balance / 1e9} SOL`);
  console.log('');

  const { blockhash } = await connection.getLatestBlockhash();
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[0]!);

  // ── Test 1: Legacy Transaction ────────────────────────────────────────────
  console.log('[TEST 1] Legacy Transaction (self-transfer 0 SOL + tip)');
  const legacyTx = new Transaction();
  legacyTx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 0,
    }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipAccount,
      lamports: TIP_LAMPORTS,
    }),
  );
  legacyTx.recentBlockhash = blockhash;
  legacyTx.feePayer = payer.publicKey;
  legacyTx.sign(payer);

  const legacySerialized = legacyTx.serialize();
  const legacyBase64 = Buffer.from(legacySerialized).toString('base64');
  console.log(`   Size: ${legacySerialized.length} bytes, ${legacyBase64.length} base64`);

  await delay(1100);
  const legacyResult = await jitoRpc('sendBundle', [[legacyBase64]]);
  if (legacyResult.error) {
    console.log(`   ✗ ${legacyResult.error.message}`);
  } else {
    console.log(`   ✓ Bundle ID: ${legacyResult.result}`);
  }
  console.log('');

  // ── Test 2: Versioned Transaction ─────────────────────────────────────────
  console.log('[TEST 2] Versioned Transaction (same instructions)');
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: tipAccount,
        lamports: TIP_LAMPORTS,
      }),
    ],
  }).compileToV0Message();

  const v0Tx = new VersionedTransaction(messageV0);
  v0Tx.sign([payer]);

  const v0Serialized = v0Tx.serialize();
  const v0Base64 = Buffer.from(v0Serialized).toString('base64');
  console.log(`   Size: ${v0Serialized.length} bytes, ${v0Base64.length} base64`);

  await delay(1100);
  const v0Result = await jitoRpc('sendBundle', [[v0Base64]]);
  if (v0Result.error) {
    console.log(`   ✗ ${v0Result.error.message}`);
  } else {
    console.log(`   ✓ Bundle ID: ${v0Result.result}`);
  }
  console.log('');

  // ── Test 3: Only tip instruction ──────────────────────────────────────────
  console.log('[TEST 3] Legacy TX — only tip (no other instructions)');
  const tipOnlyTx = new Transaction();
  tipOnlyTx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipAccount,
      lamports: TIP_LAMPORTS,
    }),
  );
  tipOnlyTx.recentBlockhash = blockhash;
  tipOnlyTx.feePayer = payer.publicKey;
  tipOnlyTx.sign(payer);

  const tipOnlySerialized = tipOnlyTx.serialize();
  const tipOnlyBase64 = Buffer.from(tipOnlySerialized).toString('base64');
  console.log(`   Size: ${tipOnlySerialized.length} bytes`);

  await delay(1100);
  const tipOnlyResult = await jitoRpc('sendBundle', [[tipOnlyBase64]]);
  if (tipOnlyResult.error) {
    console.log(`   ✗ ${tipOnlyResult.error.message}`);
  } else {
    console.log(`   ✓ Bundle ID: ${tipOnlyResult.result}`);
  }
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════');
  console.log(' RESULTS');
  console.log('═══════════════════════════════════════════════');
  
  const results = [
    { name: 'Legacy TX', result: legacyResult },
    { name: 'Versioned TX', result: v0Result },
    { name: 'Tip-only TX', result: tipOnlyResult },
  ];

  for (const { name, result } of results) {
    const status = result.error ? `✗ ${result.error.message}` : '✓';
    console.log(`   ${name}: ${status}`);
  }
  console.log('');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
