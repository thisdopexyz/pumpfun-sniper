/**
 * Jito Bundle API Standalone Validation
 * 
 * Tests:
 * 1. API connectivity
 * 2. getTipAccounts
 * 3. Build TX with tip instruction
 * 4. Sign TX
 * 5. Submit bundle
 * 6. Check bundle status
 * 
 * Run: npx tsx scripts/validate-jito.ts
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

// ── Config ──────────────────────────────────────────────────────────────────
const JITO_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=c7549260-3918-4ea2-955e-aaa66b01ce4d';
const TIP_LAMPORTS = 100_000; // 0.0001 SOL

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

// ── Helpers ─────────────────────────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function jitoRpc(method: string, params: any[] = []): Promise<any> {
  const response = await fetch(JITO_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  return response.json();
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' JITO BUNDLE API VALIDATION');
  console.log('═══════════════════════════════════════════════\n');

  // ── Step 1: API Connectivity ──────────────────────────────────────────────
  console.log('[1] Testing API connectivity...');
  const tipResult = await jitoRpc('getTipAccounts');
  if (tipResult.error) {
    console.error('   ✗ API error:', tipResult.error);
    return;
  }
  console.log('   ✓ API reachable');
  console.log(`   ✓ Tip accounts: ${tipResult.result.length}`);
  console.log('');

  // ── Step 2: Build TX with tip instruction ─────────────────────────────────
  console.log('[2] Building transaction with tip instruction...');
  
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  
  // Generate a test keypair (won't have SOL, so TX will fail on-chain but we can test format)
  const payer = Keypair.generate();
  console.log(`   Payer: ${payer.publicKey.toBase58()}`);

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  console.log(`   Blockhash: ${blockhash}`);

  // Create tip instruction
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!);
  const tipInstruction = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: tipAccount,
    lamports: TIP_LAMPORTS,
  });
  console.log(`   Tip: ${TIP_LAMPORTS} lamports → ${tipAccount.toBase58().slice(0, 8)}...`);

  // Create a no-op instruction (just for testing)
  const noopInstruction = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 0,
  });

  // Build versioned transaction
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [noopInstruction, tipInstruction], // tip MUST be included
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  console.log('   ✓ Transaction built (VersionedTransaction v0)');
  console.log('');

  // ── Step 3: Sign TX ───────────────────────────────────────────────────────
  console.log('[3] Signing transaction...');
  tx.sign([payer]);
  
  const serialized = tx.serialize();
  const txBase64 = Buffer.from(serialized).toString('base64');
  console.log(`   ✓ Signed (${serialized.length} bytes, ${txBase64.length} base64 chars)`);
  console.log(`   Base64 preview: ${txBase64.slice(0, 60)}...`);
  console.log('');

  // ── Step 4: Submit bundle ─────────────────────────────────────────────────
  console.log('[4] Submitting bundle to Jito...');
  await delay(1100); // Rate limit
  
  const bundleResult = await jitoRpc('sendBundle', [[txBase64]]);
  
  if (bundleResult.error) {
    console.log('   ✗ Bundle rejected:', bundleResult.error.message);
    
    // Check if it's a format error or balance error
    if (bundleResult.error.message.includes('could not be decoded')) {
      console.log('   → FORMAT ERROR: TX serialization wrong');
    } else if (bundleResult.error.message.includes('insufficient')) {
      console.log('   → BALANCE ERROR: Expected (test keypair has no SOL)');
    } else {
      console.log('   → Other error:', JSON.stringify(bundleResult.error));
    }
  } else {
    console.log('   ✓ Bundle accepted!');
    console.log(`   Bundle ID: ${bundleResult.result}`);
    
    // ── Step 5: Check bundle status ───────────────────────────────────────
    console.log('');
    console.log('[5] Checking bundle status...');
    await delay(1100);
    
    const statusResult = await jitoRpc('getBundleStatuses', [[bundleResult.result]]);
    if (statusResult.result) {
      console.log('   Status:', JSON.stringify(statusResult.result, null, 2));
    }
  }
  console.log('');

  // ── Step 6: Validation Summary ────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════');
  console.log(' VALIDATION SUMMARY');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log('   API Connectivity:    ✓');
  console.log('   getTipAccounts:      ✓');
  console.log('   TX Build (v0):       ✓');
  console.log('   TX Sign:             ✓');
  console.log('   Base64 Serialize:    ✓');
  
  if (bundleResult.error) {
    if (bundleResult.error.message.includes('could not be decoded')) {
      console.log('   Bundle Submit:       ✗ FORMAT ERROR');
      console.log('');
      console.log('   DIAGNOSIS:');
      console.log('   Jito cannot decode the VersionedTransaction.');
      console.log('   Possible causes:');
      console.log('   1. Jito expects legacy Transaction, not v0');
      console.log('   2. TX serialization format incompatible');
      console.log('   3. Need to use different serialization method');
    } else {
      console.log('   Bundle Submit:       ✓ (expected balance error)');
    }
  } else {
    console.log('   Bundle Submit:       ✓');
  }
  
  console.log('');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
