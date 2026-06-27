// Check pumpfun-new wallet balances: SOL + SPL tokens
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const envPath = '/home/ubuntu/workspace/pumpfun-new/.env';
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i+1).trim().replace(/^"|"$/g, '')]; })
);

// Pick first usable RPC (prefer Helius for token queries)
const keys = (env.HELIUS_EXTRA_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${keys[0]}`;
const RPC = keys.length ? HELIUS : 'https://solana-rpc.publicnode.com';
const conn = new Connection(RPC, 'confirmed');
// WALLET_SECRET_KEY may be base58 OR base64
let keypair;
try {
  keypair = Keypair.fromSecretKey(bs58.decode(env.WALLET_SECRET_KEY));
} catch {
  keypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(env.WALLET_SECRET_KEY, 'base64')));
}
const owner = keypair.publicKey;

console.log('Wallet:', owner.toBase58());
console.log('RPC   :', RPC);
console.log('---');

const sol = await conn.getBalance(owner);
console.log('SOL      :', (sol / LAMPORTS_PER_SOL).toFixed(9), 'SOL');

// Fetch all token accounts
const tokenAccounts = await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
console.log('SPL mints:', tokenAccounts.value.length);

if (tokenAccounts.value.length > 0) {
  console.log('\nMint                                              | Amount (raw)             | Decimals | UI Amount');
  console.log('--------------------------------------------------------------------------------------------------------');
  for (const { account } of tokenAccounts.value) {
    const info = account.data.parsed.info;
    if (Number(info.tokenAmount.amount) === 0) continue;
    console.log(
      info.mint.padEnd(50),
      '|',
      info.tokenAmount.amount.padStart(23),
      '|',
      String(info.tokenAmount.decimals).padStart(8),
      '|',
      info.tokenAmount.uiAmountString
    );
  }
}
