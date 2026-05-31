/**
 * Jito gRPC Buy+Sell Test — uses bot's compiled code
 * Run: npx tsx scripts/test-jito-buy-v2.ts
 */

import {
  Connection, Keypair, PublicKey, TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
import dotenv from 'dotenv';

// Import bot's compiled code
import { PumpfunVenue } from '../../dist/execution/venues/pumpfunVenue.js';
import { deriveBondingCurvePDA, deriveAssociatedBondingCurve } from '../../dist/adapters/protocols/pumpfun/pumpfunTradeBuilder.js';

dotenv.config();

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

  const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const mint = new PublicKey('9S7Gr9piTk81iqZUXe2stiyGa2mwKrmZ8YDYTCqKpump');
  const bc = deriveBondingCurvePDA(mint);
  const abc = deriveAssociatedBondingCurve(bc, mint, TOKEN_2022);

  // Get BC data
  const bcInfo = await conn.getAccountInfo(bc);
  if (!bcInfo) { console.error('BC not found'); return; }
  const vToken = bcInfo.data.readBigUInt64LE(8);
  const vSol = bcInfo.data.readBigUInt64LE(16);
  const creatorOffset = 49;
  const creator = new PublicKey(bcInfo.data.subarray(creatorOffset, creatorOffset + 32));
  console.log(`Creator: ${creator.toBase58().slice(0, 12)}...`);

  // Calculate buy amount
  const buyLamports = Math.floor(0.10 / 82 * 1e9);
  const tokensOut = (BigInt(buyLamports) * vToken) / (vSol + BigInt(buyLamports));
  const maxSolCost = BigInt(buyLamports) + (BigInt(buyLamports) * 500n / 10000n);

  console.log(`\nBuy: ${buyLamports} lamports, Tokens: ${tokensOut}`);

  // Use bot's PumpfunVenue to build swap
  const venue = new PumpfunVenue();
  const swapResult = venue.buildSwap({
    mint,
    user: wallet.publicKey,
    direction: 'BUY',
    tokenAmount: tokensOut,
    slippageAmount: maxSolCost,
    tokenProgram: TOKEN_2022,
    creator,
  });

  console.log('Swap instruction built');

  // Add ATA creation instruction
  const { SystemProgram, TransactionInstruction } = await import('@solana/web3.js');
  const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const userATA = deriveAssociatedBondingCurve(wallet.publicKey, mint, TOKEN_2022);

  // Actually derive user ATA properly
  const userATA2 = PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  )[0];

  const createATAIx = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userATA2, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

  // Build TX
  const { blockhash } = await conn.getLatestBlockhash();
  const mainTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [createATAIx, swapResult.instruction],
    }).compileToV0Message()
  );
  mainTx.sign([wallet]);
  console.log('TX built and signed');

  // Simulate
  console.log('\nSimulating...');
  const sim = await conn.simulateTransaction(mainTx);
  if (sim.value.err) {
    console.error('Simulation FAILED:', JSON.stringify(sim.value.err));
    console.log('Logs:', sim.value.logs?.slice(-5).join('\n'));
    return;
  }
  console.log('Simulation OK! CUs:', sim.value.unitsConsumed);

  // Send via Jito
  console.log('\nConnecting to Jito gRPC...');
  const client = searcherClient('mainnet.block-engine.jito.wtf');
  const tipAccounts = await client.getTipAccounts();
  if (!tipAccounts.ok) { console.error('Tips failed'); return; }
  const tipAccount = new PublicKey(tipAccounts.value[0]!);

  // Wait for leader
  console.log('Waiting for leader...');
  for (let i = 0; i < 30; i++) {
    const next = await client.getNextScheduledLeader();
    if (next.ok && (next.value.nextLeaderSlot - next.value.currentSlot) <= 2) {
      console.log('Leader ready!');
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Bundle
  const bundle = new Bundle([], 5);
  bundle.addTransactions(mainTx);
  bundle.addTipTx(wallet, 100_000, tipAccount, blockhash);

  console.log('Sending bundle...');
  const result = await client.sendBundle(bundle);
  if (!result.ok) {
    console.error('Bundle FAILED:', JSON.stringify(result.error));
    return;
  }
  console.log(`Bundle ID: ${result.value}`);

  // Wait for result
  console.log('Waiting 30s...');
  let finalStatus = '';
  const cancel = client.onBundleResult(
    (r) => {
      finalStatus = r.rejected ? 'REJECTED' : r.processed ? 'PROCESSED' :
        r.finalized ? 'FINALIZED' : r.dropped ? 'DROPPED' : 'UNKNOWN';
      console.log(`Result: ${finalStatus}`);
    },
    (e) => console.error('Stream error:', e.message)
  );

  await new Promise(r => setTimeout(r, 30000));
  cancel();

  // Check on-chain
  console.log('\nRecent TXs:');
  const sigs = await conn.getSignaturesForAddress(wallet.publicKey, { limit: 3 });
  for (const s of sigs) {
    const age = s.blockTime ? Math.round(Date.now()/1000 - s.blockTime) : '?';
    console.log(`  ${s.signature.slice(0,40)}  ${s.confirmationStatus}  ${age}s  ${s.err ? 'ERR' : 'OK'}`);
  }

  // Check token balance
  const tokenBal = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint });
  if (tokenBal.value.length > 0) {
    const amount = tokenBal.value[0].account.data.readBigUInt64LE(64);
    console.log(`\nToken balance: ${amount}`);
  }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(` RESULT: ${finalStatus || 'UNKNOWN'}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
