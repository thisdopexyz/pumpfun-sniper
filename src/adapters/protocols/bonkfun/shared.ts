/**
 * BonkFun / Raydium LaunchLab Protocol Shared Utilities
 *
 * Single source of truth for:
 *   - Pool state account layout constants
 *   - PDA derivation (pool state, authority, fee vaults, event authority)
 *   - Buffer read helpers (re-exports from shared)
 *   - Protocol constants (discriminators, seeds)
 *
 * ALL bonkfun adapter files MUST import from here — no local duplicates.
 */

import { PublicKey } from '@solana/web3.js';
import {
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  BONKFUN_PLATFORM_CONFIG,
  WSOL_MINT,
} from '../../../core/constants/programs.js';

// ---------------------------------------------------------------------------
// Pool State Account Layout (from Raydium LaunchLab IDL)
// ---------------------------------------------------------------------------
// Offset  0-7  : discriminator (8 bytes, Anchor account discriminator - skip)
// Offset  8-15 : epoch (u64 LE)
// Offset    16 : auth_bump (u8)
// Offset    17 : status (u8) — pool status, 100 = graduated/migrated
// Offset    18 : base_decimals (u8)
// Offset    19 : quote_decimals (u8)
// Offset    20 : migrate_type (u8)
// Offset 21-28 : supply (u64 LE) — token total supply
// Offset 29-36 : total_base_sell (u64 LE) — tokens allocated for sale
// Offset 37-44 : virtual_base (u64 LE) — virtual token reserves
// Offset 45-52 : virtual_quote (u64 LE) — virtual SOL reserves
// Offset 53-60 : real_base (u64 LE) — actual token reserves
// Offset 61-68 : real_quote (u64 LE) — actual SOL reserves
// Offset 69-76 : total_quote_fund_raising (u64 LE)
// Offset 77-84 : quote_protocol_fee (u64 LE)
// Offset 85-92 : platform_fee (u64 LE)
// Offset 93-100: migrate_fee (u64 LE)
// Offset 101-148: vesting_schedule (VestingSchedule struct, ~48 bytes)
// Offset 149-180: global_config (pubkey, 32 bytes)
// Offset 181-212: platform_config (pubkey, 32 bytes)
// Offset 213-244: base_mint (pubkey, 32 bytes)
// Offset 245-276: quote_mint (pubkey, 32 bytes)
// Offset 277-308: base_vault (pubkey, 32 bytes)
// Offset 309-340: quote_vault (pubkey, 32 bytes)
// Offset 341-372: creator (pubkey, 32 bytes)
// Offset    373: token_program_flag (u8)
// Offset    374: amm_creator_fee_on (u8 or struct)
// Offset 375+: padding (62 bytes)

/**
 * Minimum account data length for a valid pool state account.
 * VERIFIED ON-CHAIN 2026-06-23: all 20 queried BonkFun pool states are exactly
 * 429 bytes. Matches MIN_BONKFUN_POOL_STATE_SIZE in programs.ts — keep in sync.
 */
export const POOL_STATE_MIN_LEN = 429;

/** Discriminator size for Anchor accounts. */
export const DISCRIMINATOR_SIZE = 8;

// Byte offsets into the pool state buffer (after discriminator)
// NOTE: These offsets are VERIFIED ON-CHAIN (not from IDL docs which were off by 8).
export const OFFSET_STATUS = 17; // u8
export const OFFSET_VIRTUAL_BASE = 37; // u64 LE
export const OFFSET_VIRTUAL_QUOTE = 45; // u64 LE
export const OFFSET_REAL_BASE = 53; // u64 LE
export const OFFSET_REAL_QUOTE = 61; // u64 LE
export const OFFSET_GLOBAL_CONFIG = 133; // pubkey (32 bytes) — verified on-chain
export const OFFSET_PLATFORM_CONFIG = 165; // pubkey (32 bytes) — verified on-chain
export const OFFSET_BASE_MINT = 197; // pubkey (32 bytes) — verified on-chain
export const OFFSET_QUOTE_MINT = 229; // pubkey (32 bytes) — verified on-chain
export const OFFSET_BASE_VAULT = 261; // pubkey (32 bytes) — verified on-chain
export const OFFSET_QUOTE_VAULT = 293; // pubkey (32 bytes) — verified on-chain
export const OFFSET_CREATOR = 325; // pubkey (32 bytes) — verified on-chain
export const OFFSET_TOKEN_PROGRAM_FLAG = 357; // u8

// ---------------------------------------------------------------------------
// PDA Seed Constants (from Raydium LaunchLab IDL)
// ---------------------------------------------------------------------------

/** Pool state PDA seed. */
export const POOL_SEED = 'pool';

/** Authority PDA seed (vault authority). */
export const AUTH_SEED = 'vault_auth_seed';

/** Event authority PDA seed. */
export const EVENT_AUTHORITY_SEED = '__event_authority';

/** PublicKey byte length. */
export const PUBKEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Instruction Discriminators (from Raydium LaunchLab IDL)
// ---------------------------------------------------------------------------

/** buy_exact_in instruction discriminator. */
export const BUY_EXACT_IN_DISCRIMINATOR = Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]);

/** sell_exact_in instruction discriminator. */
export const SELL_EXACT_IN_DISCRIMINATOR = Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]);

// ---------------------------------------------------------------------------
// PDA Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the pool state PDA for a given base token mint.
 *
 * Seeds: ["pool", base_token_mint, wsol_mint]
 * Program: RAYDIUM_LAUNCHLAB_PROGRAM_ID
 *
 * Source: Raydium LaunchLab IDL + Chainstack reference implementation.
 */
export function derivePoolStatePDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(POOL_SEED), mint.toBuffer(), WSOL_MINT.toBuffer()],
    RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the authority PDA for pool vault operations.
 *
 * Seeds: ["vault_auth_seed"]
 * Program: RAYDIUM_LAUNCHLAB_PROGRAM_ID
 */
export function deriveAuthorityPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(AUTH_SEED)],
    RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the event authority PDA.
 *
 * Seeds: ["__event_authority"]
 * Program: RAYDIUM_LAUNCHLAB_PROGRAM_ID
 */
export function deriveEventAuthorityPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(EVENT_AUTHORITY_SEED)],
    RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the platform fee vault PDA.
 *
 * Seeds: [platform_config, quote_mint]
 * Program: RAYDIUM_LAUNCHLAB_PROGRAM_ID
 */
export function derivePlatformFeeVault(
  platformConfig: PublicKey = BONKFUN_PLATFORM_CONFIG,
  quoteMint: PublicKey = WSOL_MINT,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [platformConfig.toBuffer(), quoteMint.toBuffer()],
    RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the creator fee vault PDA.
 *
 * Seeds: [creator_pubkey, quote_mint]
 * Program: RAYDIUM_LAUNCHLAB_PROGRAM_ID
 */
export function deriveCreatorFeeVault(
  creator: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [creator.toBuffer(), quoteMint.toBuffer()],
    RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Buffer Helpers (re-exports)
// ---------------------------------------------------------------------------

export { readU64LE, readPublicKey } from '../pumpfun/shared.js';
