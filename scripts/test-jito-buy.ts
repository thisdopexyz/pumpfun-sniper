/**
 * Jito gRPC Buy Test — 9S7Gr9pi...pump, $0.10
 * Run: npx tsx scripts/test-jito-buy.ts
 */

import {
  Connection, Keypair, PublicKey, TransactionMessage,
  VersionedTransaction, SystemProgram, TransactionInstruction,
} from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
import dotenv from 'dotenv';
dotenv.config();

// PumpFun constants
const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ68w7k89u7p');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const GLOBAL_STATE = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

function deriveBC(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()], PUMPFUN_PROGRAM
  )[0];
}

function deriveATA(owner: PublicKey, mint: PublicKey, tp: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tp.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM
  )[0];
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' JITO gRPC BUY TEST — 9S7Gr9pi...pump');
  console.log('═══════════════════════════════════════════════\n');

  const wallet = Keypair.fromSecretKey(
    new Uint8Array(Buffer.from(process.env.WALLET_SECRET_KEY!, 'base64'))
  );
  const conn = new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed'
  );
  const balance = await conn.getBalance(wallet.publicKey);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  const mint = new PublicKey('9S7Gr9piTk81iqZUXe2stiyGa2mwKrmZ8YDYTCqKpump');
  const bc = deriveBC(mint);
  const abc = deriveATA(bc, mint, TOKEN_2022);
  const userATA = deriveATA(wallet.publicKey, mint, TOKEN_2022);

  // Get BC data
  const bcInfo = await conn.getAccountInfo(bc);
  if (!bcInfo) { console.error('BC not found'); return; }
  const vToken = bcInfo.data.readBigUInt64LE(8);
  const vSol = bcInfo.data.readBigUInt64LE(16);
  const rToken = bcInfo.data.readBigUInt64LE(24);
  console.log(`BC: vSol=${vSol} vToken=${vToken} rToken=${rToken}`);

  // Calculate buy: $0.10 / $82 per SOL
  const buyLamports = Math.floor(0.10 / 82 * 1e9);
  const tokensOut = (BigInt(buyLamports) * vToken) / (vSol + BigInt(buyLamports));
  const maxSolCost = BigInt(buyLamports) + (BigInt(buyLamports) * 500n / 10000n);

  console.log(`\nBuy: ${buyLamports} lamports (${(buyLamports/1e9).toFixed(6)} SOL)`);
  console.log(`Tokens out: ${tokensOut}`);
  console.log(`Max SOL cost: ${maxSolCost}`);

  // Build ATA creation instruction (CreateIdempotent)
  const createATAIx = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userATA, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent instruction index
  });

  // Build buy instruction
  const disc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const data = Buffer.alloc(24);
  disc.copy(data, 0);
  data.writeBigUInt64LE(tokensOut, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  const buyIx = new TransactionInstruction({
    programId: PUMPFUN_PROGRAM,
    keys: [
      { pubkey: GLOBAL_STATE, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: abc, isSigner: false, isWritable: true },
      { pubkey: userATA, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Build TX
  const { blockhash } = await conn.getLatestBlockhash();
  const mainTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [createATAIx, buyIx],
    }).compileToV0Message()
  );
  mainTx.sign([wallet]);
  console.log('\nTX built and signed');

  // Simulate first
  console.log('\nSimulating TX...');
  const sim = await conn.simulateTransaction(mainTx);
  if (sim.value.err) {
    console.error('Simulation FAILED:', JSON.stringify(sim.value.err));
    console.log('Logs:', sim.value.logs?.join('\n'));
    return;
  }
  console.log('Simulation OK! CUs:', sim.value.unitsConsumed);

  // Send via Jito gRPC
  console.log('\nConnecting to Jito gRPC...');
  const client = searcherClient('mainnet.block-engine.jito.wtf');
  const tipResult = await client.getTipAccounts();
  if (!tipResult.ok) { console.error('Tip accounts failed:', tipResult.error); return; }
  const tipAccount = new PublicKey(tipResult.value[0]!);

  // Wait for leader
  console.log('Waiting for leader slot...');
  for (let i = 0; i < 30; i++) {
    const next = await client.getNextScheduledLeader();
    if (next.ok) {
      const slots = next.value.nextLeaderSlot - next.value.currentSlot;
      if (slots <= 2) { console.log('Leader ready!'); break; }
      if (i % 5 === 0) process.stdout.write(`  ${slots} slots...`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Build bundle
  const bundle = new Bundle([], 5);
  bundle.addTransactions(mainTx);
  const tipRes = bundle.addTipTx(wallet, 100_000, tipAccount, blockhash);
  if (isError(tipRes)) { console.error('Tip failed:', tipRes.message); return; }

  console.log('\nSending bundle...');
  const result = await client.sendBundle(bundle);
  if (!result.ok) {
    console.error('Bundle FAILED:', JSON.stringify(result.error));
    return;
  }
  console.log(`Bundle ID: ${result.value}`);

  // Wait for result
  console.log('Waiting 30s for confirmation...');
  let finalStatus = '';
  const cancel = client.onBundleResult(
    (r) => {
      finalStatus = r.rejected ? 'REJECTED' : r.processed ? 'PROCESSED' :
        r.finalized ? 'FINALIZED' : r.dropped ? 'DROPPED' : 'UNKNOWN';
      console.log(`Bundle result: ${finalStatus}`);
    },
    (e) => console.error('Stream error:', e.message)
  );

  await new Promise(r => setTimeout(r, 30000));
  cancel();

  // Check on-chain
  console.log('\nChecking on-chain...');
  const sigs = await conn.getSignaturesForAddress(wallet.publicKey, { limit: 3 });
  for (const s of sigs) {
    const age = s.blockTime ? Math.round(Date.now()/1000 - s.blockTime) : '?';
    console.log(`  ${s.signature.slice(0,40)}  ${s.confirmationStatus}  ${age}s ago  ${s.err ? 'ERR' : 'OK'}`);
  }

  // Check token balance
  const tokenBal = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint });
  if (tokenBal.value.length > 0) {
    const bal = tokenBal.value[0].account.data;
    const amount = bal.readBigUInt64LE(64);
    console.log(`\nToken balance: ${amount}`);
  } else {
    console.log('\nNo token account (buy may have failed)');
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(` RESULT: ${finalStatus || 'UNKNOWN'}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
