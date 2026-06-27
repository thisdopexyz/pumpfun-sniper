import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/home/ubuntu/workspace/pumpfun-new/.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i+1).trim().replace(/^"|"$/g, '')]; })
);
const owner = new PublicKey('DeqVEF81A6DYRK45uWGgj5Gnj57RqeNu5j6mDtVv3Rgy');
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_EXTRA_KEYS.split(',')[0]}`, 'confirmed');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const sol = await conn.getBalance(owner);
console.log('SOL:', (sol/1e9).toFixed(9));

const spl = await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM });
console.log('SPL (Token) accounts:', spl.value.length);
for (const { account } of spl.value) {
  const i = account.data.parsed.info;
  if (Number(i.tokenAmount.amount) > 0) {
    console.log(`  ${i.mint}  ${i.tokenAmount.uiAmountString}`);
  }
}

const t22 = await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 });
console.log('Token-2022 accounts:', t22.value.length);
for (const { account } of t22.value) {
  const i = account.data.parsed.info;
  if (Number(i.tokenAmount.amount) > 0) {
    console.log(`  ${i.mint}  ${i.tokenAmount.uiAmountString}`);
  }
}
