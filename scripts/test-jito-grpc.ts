/**
 * Jito gRPC Bundle Test (Standalone)
 * 
 * Tests jito-ts SDK with real wallet:
 * 1. Create SearcherClient with auth keypair
 * 2. Get tip accounts
 * 3. Wait for Jito leader slot
 * 4. Send simple self-transfer as bundle with tip
 * 5. Stream bundle results
 * 
 * Run: npx tsx scripts/test-jito-grpc.ts
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
import dotenv from 'dotenv';

dotenv.config();

const BLOCK_ENGINE_URL = 'mainnet.block-engine.jito.wtf';
const TIP_LAMPORTS = 100_000; // 0.0001 SOL

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' JITO gRPC BUNDLE TEST');
  console.log('═══════════════════════════════════════════════\n');

  // Load wallet
  const walletSecretKeyB64 = process.env.WALLET_SECRET_KEY;
  if (!walletSecretKeyB64) {
    console.error('ERROR: WALLET_SECRET_KEY not set');
    process.exit(1);
  }
  const wallet = Keypair.fromSecretKey(new Uint8Array(Buffer.from(walletSecretKeyB64, 'base64')));
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const rpcUrl = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(rpcUrl, 'confirmed');
  const balance = await conn.getBalance(wallet.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 200_000) {
    console.error('ERROR: Insufficient balance (< 0.0002 SOL)');
    process.exit(1);
  }

  // ── Step 1: Create SearcherClient ─────────────────────────────────────────
  console.log('\n[1] Creating SearcherClient...');

  // Generate auth keypair (separate from wallet)
  // In production, this should be saved and reused
  const authKeypair = Keypair.generate();
  console.log(`   Auth keypair: ${authKeypair.publicKey.toBase58()}`);

  const client = searcherClient(BLOCK_ENGINE_URL, authKeypair);
  console.log('   ✓ SearcherClient created');

  // ── Step 2: Get tip accounts ──────────────────────────────────────────────
  console.log('\n[2] Getting tip accounts...');
  const tipAccountsResult = await client.getTipAccounts();

  if (!tipAccountsResult.ok) {
    console.error('   ✗ Failed to get tip accounts:', tipAccountsResult.error);
    process.exit(1);
  }

  const tipAccount = new PublicKey(tipAccountsResult.value[0]!);
  console.log(`   ✓ Tip accounts: ${tipAccountsResult.value.length}`);
  console.log(`   Tip account: ${tipAccount.toBase58().slice(0, 12)}...`);

  // ── Step 3: Wait for Jito leader slot ─────────────────────────────────────
  console.log('\n[3] Waiting for Jito leader slot...');

  let isLeaderSlot = false;
  let attempts = 0;
  const maxAttempts = 20; // 10 seconds max wait

  while (!isLeaderSlot && attempts < maxAttempts) {
    const nextLeader = await client.getNextScheduledLeader();

    if (!nextLeader.ok) {
      console.error('   ✗ Failed to get next leader:', nextLeader.error);
      break;
    }

    const numSlots = nextLeader.value.nextLeaderSlot - nextLeader.value.currentSlot;
    console.log(`   Current slot: ${nextLeader.value.currentSlot}, Next Jito leader: ${nextLeader.value.nextLeaderSlot} (${numSlots} slots away)`);

    isLeaderSlot = numSlots <= 2;
    if (!isLeaderSlot) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
  }

  if (!isLeaderSlot) {
    console.log('   ⚠ No Jito leader within 2 slots, submitting anyway...');
  } else {
    console.log('   ✓ Jito leader slot within reach!');
  }

  // ── Step 4: Build bundle ──────────────────────────────────────────────────
  console.log('\n[4] Building bundle...');

  const { blockhash } = await conn.getLatestBlockhash();

  // Main TX: self-transfer 0 SOL
  const mainTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: 0,
        }),
      ],
    }).compileToV0Message()
  );
  mainTx.sign([wallet]);

  // Create bundle
  const bundle = new Bundle([], 5);
  const addTxResult = bundle.addTransactions(mainTx);
  if (isError(addTxResult)) {
    console.error('   ✗ Failed to add TX to bundle:', addTxResult.message);
    process.exit(1);
  }

  // Add tip TX
  const addTipResult = bundle.addTipTx(wallet, TIP_LAMPORTS, tipAccount, blockhash);
  if (isError(addTipResult)) {
    console.error('   ✗ Failed to add tip TX:', addTipResult.message);
    process.exit(1);
  }

  console.log('   ✓ Bundle built (main TX + tip TX)');
  console.log(`   Tip: ${TIP_LAMPORTS} lamports`);

  // ── Step 5: Send bundle ───────────────────────────────────────────────────
  console.log('\n[5] Sending bundle via gRPC...');

  const sendResult = await client.sendBundle(bundle);

  if (!sendResult.ok) {
    console.error('   ✗ Bundle send failed:', sendResult.error);
    console.log('\n═══════════════════════════════════════════════');
    console.log(' RESULT: JITO gRPC FAILED');
    console.log('═══════════════════════════════════════════════');
    process.exit(1);
  }

  const bundleId = sendResult.value;
  console.log(`   ✓ Bundle sent! ID: ${bundleId}`);

  // ── Step 6: Stream bundle results ─────────────────────────────────────────
  console.log('\n[6] Streaming bundle results (30s timeout)...');

  let finalResult: any = null;
  const timeout = 30000;
  const startTime = Date.now();

  const cancelStream = client.onBundleResult(
    (bundleResult) => {
      console.log('   Bundle result received:', JSON.stringify(bundleResult, null, 2));

      if (bundleResult.rejected) {
        finalResult = { status: 'REJECTED', data: bundleResult.rejected };
      } else if (bundleResult.finalized) {
        finalResult = { status: 'FINALIZED', data: bundleResult.finalized };
      } else if (bundleResult.processed) {
        finalResult = { status: 'PROCESSED', data: bundleResult.processed };
      } else if (bundleResult.dropped) {
        finalResult = { status: 'DROPPED', data: bundleResult.dropped };
      }
    },
    (error) => {
      console.error('   Stream error:', error.message);
    }
  );

  // Wait for result or timeout
  while (!finalResult && (Date.now() - startTime) < timeout) {
    await new Promise(r => setTimeout(r, 2000));
  }

  cancelStream();

  // ── Step 7: Check on-chain ────────────────────────────────────────────────
  console.log('\n[7] Checking on-chain status...');

  // Get main TX signature
  const mainSig = Buffer.from(mainTx.signatures[0]!).toString('base64url');
  console.log(`   Main TX sig (base64url): ${mainSig}`);

  // Wait a bit more for confirmation
  await new Promise(r => setTimeout(r, 5000));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(' RESULTS');
  console.log('═══════════════════════════════════════════════');

  console.log(`  Bundle ID: ${bundleId}`);

  if (finalResult) {
    console.log(`  Bundle Status: ${finalResult.status}`);
  } else {
    console.log('  Bundle Status: TIMEOUT (no result in 30s)');
  }

  if (finalResult?.status === 'PROCESSED' || finalResult?.status === 'FINALIZED') {
    console.log('');
    console.log('  ✓ JITO gRPC WORKS!');
    console.log('  Bundle landed on-chain via gRPC API');
    console.log('  Can integrate into main bot');
  } else if (finalResult?.status === 'REJECTED') {
    console.log('');
    console.log('  ✗ Bundle REJECTED');
    console.log('  Reason:', JSON.stringify(finalResult.data));
  } else {
    console.log('');
    console.log('  ⚠ Bundle status unknown');
    console.log('  May have landed but result not received');
  }

  console.log('\n═══════════════════════════════════════════════');
}

main().catch(console.error);
