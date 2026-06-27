// Wrap SOL to WSOL
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  NATIVE_MINT, createSyncNativeInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/home/ubuntu/workspace/pumpfun-new/.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i+1).trim().replace(/^"|"$/g, '')]; })
);

const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_EXTRA_KEYS.split(',')[0]}`;
const conn = new Connection(HELIUS, 'confirmed');
const secret = bs58.decode('Tw1qRo7tFxxsCfc46bh2sckoeY7HLoYrqEioxX7kJgkVrXfDXTx2aR481Lw1DhPT2Gd9WuhjYSijDuykjFtLtrZ');
const kp = Keypair.fromSecretKey(secret);
const owner = kp.publicKey;

const balance = await conn.getBalance(owner);
console.log('Owner:', owner.toBase58());
console.log('Balance:', balance / LAMPORTS_PER_SOL, 'SOL');

// Determine wrap amount
const WRAP = 0.0022; // user requested
const WRAP_LAMPORTS = BigInt(Math.floor(WRAP * LAMPORTS_PER_SOL));
const PRIORITY_FEE_LAMPORTS = (700_000n * 200_000n) / 1_000_000n; // 700k µlamports/CU × 200k CU ÷ 1e6 = lamports
const ATA_RENT = 2_039_280n;
const BASE_FEE = 5_000n;
const NEEDED = WRAP_LAMPORTS + PRIORITY_FEE_LAMPORTS + ATA_RENT + BASE_FEE;

console.log('Wrap amount :', WRAP, 'SOL');
console.log('Total needed:', Number(NEEDED) / LAMPORTS_PER_SOL, 'SOL (rent + fee)');
console.log('Has         :', Number(BigInt(balance)) / LAMPORTS_PER_SOL, 'SOL');

if (BigInt(balance) < NEEDED) {
  console.log('\n❌ INSUFFICIENT BALANCE. Need ' + Number(NEEDED) / LAMPORTS_PER_SOL + ' SOL.');
  process.exit(1);
}

const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
console.log('WSOL ATA:', wsolAta.toBase58());

const tx = new Transaction();
tx.add(
  createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT),
  SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: WRAP_LAMPORTS }),
  createSyncNativeInstruction(wsolAta)
);

tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
tx.feePayer = owner;

console.log('\nSending wrap TX...');
const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
console.log('✅ TX confirmed:', sig);

const newBal = await conn.getBalance(owner);
const wsolBal = await conn.getTokenAccountBalance(wsolAta);
console.log('SOL after :', newBal / LAMPORTS_PER_SOL);
console.log('WSOL      :', wsolBal.value.uiAmountString);
