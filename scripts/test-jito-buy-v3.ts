import { PublicKey, VersionedTransaction, TransactionMessage, Keypair, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
import { bootstrap } from '../dist/app/bootstrap.js';
import { deriveBondingCurvePDA } from '../dist/adapters/protocols/pumpfun/shared.js';
import { deriveAssociatedBondingCurve } from '../dist/adapters/protocols/pumpfun/pumpfunTradeBuilder.js';

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MINT = new PublicKey('9S7Gr9piTk81iqZUXe2stiyGa2mwKrmZ8YDYTCqKpump');

async function main() {
  const container = await bootstrap();
  const conn = container.connection;
  const walletPk = container.signer.getPublicKey();
  const walletKeypair = Keypair.fromSecretKey(new Uint8Array(Buffer.from(process.env.WALLET_SECRET_KEY!, 'base64')));
  console.log('Wallet:', walletPk.toBase58(), 'Balance:', (await conn.getBalance(walletPk) / 1e9).toFixed(4), 'SOL');

  // Get BC data
  const bc = deriveBondingCurvePDA(MINT);
  const bcInfo = await conn.getAccountInfo(bc);
  if (!bcInfo) { console.error('BC not found'); process.exit(1); }

  const vToken = bcInfo.data.readBigUInt64LE(8);
  const vSol = bcInfo.data.readBigUInt64LE(16);
  const creator = new PublicKey(bcInfo.data.subarray(49, 81));
  console.log('Creator:', creator.toBase58().slice(0, 12) + '...');

  // Calculate buy
  const buyLamports = Math.floor(0.10 / 82 * 1e9);
  const tokensOut = (BigInt(buyLamports) * vToken) / (vSol + BigInt(buyLamports));
  const maxSolCost = BigInt(buyLamports) + (BigInt(buyLamports) * 500n / 10000n);
  console.log('Buy:', buyLamports, 'lamports, Tokens:', tokensOut.toString());

  // Build swap
  console.log('Building swap instruction...');
  const swapResult = container.pumpfunVenue.buildSwap({
    mint: MINT,
    user: walletPk,
    direction: 'BUY',
    tokenAmount: tokensOut,
    slippageAmount: maxSolCost,
    tokenProgram: TOKEN_2022,
    creator,
  });
  console.log('Swap built:', swapResult.instruction.keys.length, 'keys');

  // ATA creation
  const userATA = deriveAssociatedBondingCurve(walletPk, MINT, TOKEN_2022);
  const createATAIx = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: walletPk, isSigner: true, isWritable: true },
      { pubkey: userATA, isSigner: false, isWritable: true },
      { pubkey: walletPk, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

  // Build and sign TX
  const { blockhash } = await conn.getLatestBlockhash();
  const mainTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: walletPk,
      recentBlockhash: blockhash,
      instructions: [createATAIx, swapResult.instruction],
    }).compileToV0Message()
  );
  mainTx.sign([walletKeypair]);
  console.log('TX signed');

  // Simulate
  console.log('Simulating...');
  const sim = await conn.simulateTransaction(mainTx);
  if (sim.value.err) {
    console.error('SIMULATION FAILED:', JSON.stringify(sim.value.err));
    console.log('Logs:', sim.value.logs?.slice(-5).join('\n'));
    process.exit(1);
  }
  console.log('Simulation OK! CUs:', sim.value.unitsConsumed);

  // Jito gRPC
  console.log('\nConnecting to Jito gRPC...');
  const client = searcherClient('mainnet.block-engine.jito.wtf');
  const tipAccounts = await client.getTipAccounts();
  if (!tipAccounts.ok) { console.error('Tips failed'); process.exit(1); }
  const tipAccount = new PublicKey(tipAccounts.value[0]!);

  // Wait for leader
  console.log('Waiting for leader...');
  for (let i = 0; i < 30; i++) {
    const next = await client.getNextScheduledLeader();
    if (next.ok && (next.value.nextLeaderSlot - next.value.currentSlot) <= 2) {
      console.log('Leader ready!'); break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Bundle
  const bundle = new Bundle([], 5);
  bundle.addTransactions(mainTx);
  bundle.addTipTx(walletKeypair, 100_000, tipAccount, blockhash);

  console.log('Sending bundle...');
  const result = await client.sendBundle(bundle);
  if (!result.ok) { console.error('Bundle FAILED:', JSON.stringify(result.error)); process.exit(1); }
  console.log('Bundle ID:', result.value);

  // Wait for result
  console.log('Waiting 30s...');
  let finalStatus = '';
  const cancel = client.onBundleResult(
    (r) => {
      finalStatus = r.rejected ? 'REJECTED' : r.processed ? 'PROCESSED' :
        r.finalized ? 'FINALIZED' : r.dropped ? 'DROPPED' : 'UNKNOWN';
      console.log('Bundle result:', finalStatus);
    },
    (e) => console.error('Stream error:', e.message)
  );
  await new Promise(r => setTimeout(r, 30000));
  cancel();

  // Check on-chain
  console.log('\nRecent TXs:');
  const sigs = await conn.getSignaturesForAddress(walletPk, { limit: 3 });
  for (const s of sigs) {
    const age = s.blockTime ? Math.round(Date.now() / 1000 - s.blockTime) : '?';
    console.log(`  ${s.signature.slice(0, 40)}  ${s.confirmationStatus}  ${age}s  ${s.err ? 'ERR' : 'OK'}`);
  }

  // Check token balance
  const tokenBal = await conn.getTokenAccountsByOwner(walletPk, { mint: MINT });
  if (tokenBal.value.length > 0) {
    const amount = tokenBal.value[0].account.data.readBigUInt64LE(64);
    console.log(`\nToken balance: ${amount}`);
  } else {
    console.log('\nNo token account');
  }

  console.log(`\nRESULT: ${finalStatus || 'UNKNOWN'}`);
  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
