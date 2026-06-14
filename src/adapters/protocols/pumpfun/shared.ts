/**
 * Pump.fun Protocol Shared Utilities
 *
 * Single source of truth for:
 *   - Bonding curve account layout constants
 *   - PDA derivation (bonding curve)
 *   - Buffer read helpers (readU64LE, readPublicKey, readBorshString)
 *   - Protocol log pattern constants
 *
 * ALL pumpfun adapter files MUST import from here — no local duplicates.
 */

import { PublicKey } from '@solana/web3.js';
import { PUMPFUN_PROGRAM_ID } from '../../../core/constants/programs.js';

// ---------------------------------------------------------------------------
// Bonding curve account layout (VERIFIED from Pump.fun on-chain program)
// ---------------------------------------------------------------------------
// Offset  0-7  : discriminator (8 bytes, Anchor account discriminator - skip)
// Offset  8-15 : virtualTokenReserves  (u64 LE) - bigint
// Offset 16-23 : virtualSolReserves    (u64 LE) - bigint
// Offset 24-31 : realTokenReserves     (u64 LE) - bigint
// Offset 32-39 : realSolReserves       (u64 LE) - bigint
// Offset 40-47 : tokenTotalSupply      (u64 LE) - bigint  (skipped; we use on-chain supply)
// Offset    48 : complete              (u8, 0 = active, 1 = graduated)
// ---------------------------------------------------------------------------

/** Minimum account data length for a valid bonding curve account. */
export const BONDING_CURVE_MIN_LEN = 49; // 8 (disc) + 8*5 (five u64) + 1 (complete)

/**
 * Seed prefix used by the Pump.fun program to derive bonding curve PDAs.
 * Source: Pump.fun on-chain program (Anchor PDA derivation).
 */
export const BONDING_CURVE_SEED = 'bonding-curve';

/** PublicKey byte length. */
export const PUBKEY_LENGTH = 32;

/** Prefix for base64-encoded program data in transaction logs. */
export const PROGRAM_DATA_PREFIX = 'Program data: ';

/** Legacy create instruction log pattern. */
export const CREATE_INSTRUCTION_LOG = 'Program log: Instruction: Create';

/** CreateV2 instruction log pattern (current Pump.fun default since late 2024). */
export const CREATE_INSTRUCTION_LOG_V2 = 'Program log: Instruction: CreateV2';

// ---------------------------------------------------------------------------
// Buffer Helpers
// ---------------------------------------------------------------------------

/**
 * Read a little-endian u64 from a Buffer at the given offset as BigInt.
 */
export function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

/**
 * Read a PublicKey (32 bytes) from a Buffer at the given offset.
 */
export function readPublicKey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + PUBKEY_LENGTH));
}

/**
 * Read a borsh-encoded string from a buffer.
 *
 * Returns the decoded string and the number of bytes consumed (4 + length).
 * Returns null if the buffer is too short or string length > maxLen.
 */
export function readBorshString(
  data: Buffer,
  offset: number,
  maxLen = 200,
): { value: string; bytesRead: number } | null {
  if (offset + 4 > data.length) return null;

  const length = data.readUInt32LE(offset);

  // Sanity check: string length must be reasonable
  if (length > maxLen || offset + 4 + length > data.length) return null;

  const value = data.subarray(offset + 4, offset + 4 + length).toString('utf8');
  // Trim null bytes that Metaplex pads with
  const trimmed = value.replace(/\0+$/, '');
  return { value: trimmed, bytesRead: 4 + length };
}

// ---------------------------------------------------------------------------
// PDA Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the bonding curve PDA for a given mint.
 *
 * Seeds: ["bonding-curve", mint_pubkey]
 * Program: PUMPFUN_PROGRAM_ID
 *
 * Source: Pump.fun on-chain program (Anchor PDA derivation) — verified.
 */
export function deriveBondingCurvePDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}
