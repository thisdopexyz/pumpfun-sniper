/**
 * Unit tests for execution/tx/computeBudgetBuilder.ts
 *
 * Tests Solana Compute Budget instruction building:
 * discriminators, byte layout, range validation.
 *
 * CRITICAL: wrong instruction data = tx rejected by Solana runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSetComputeUnitLimitIx,
  buildSetComputeUnitPriceIx,
  buildComputeBudgetInstructions,
  DEFAULT_PUMPFUN_COMPUTE_BUDGET,
  DEFAULT_JUPITER_COMPUTE_BUDGET,
} from '../../../execution/tx/computeBudgetBuilder.js';
import { COMPUTE_BUDGET_PROGRAM_ID } from '../../../core/constants/programs.js';

// ---------------------------------------------------------------------------
// SetComputeUnitLimit
// ---------------------------------------------------------------------------

describe('buildSetComputeUnitLimitIx', () => {
  it('creates instruction with correct program ID', () => {
    const ix = buildSetComputeUnitLimitIx(200_000);
    expect(ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);
  });

  it('has no account keys', () => {
    const ix = buildSetComputeUnitLimitIx(200_000);
    expect(ix.keys.length).toBe(0);
  });

  it('data is 5 bytes: [discriminator=2, u32_LE]', () => {
    const ix = buildSetComputeUnitLimitIx(200_000);
    const data = ix.data as Buffer;

    expect(data.length).toBe(5);
    // Discriminator = 2
    expect(data[0]).toBe(2);
    // Value in little-endian u32
    expect(data.readUInt32LE(1)).toBe(200_000);
  });

  it('encodes different values correctly', () => {
    const ix1 = buildSetComputeUnitLimitIx(400_000);
    expect((ix1.data as Buffer).readUInt32LE(1)).toBe(400_000);

    const ix2 = buildSetComputeUnitLimitIx(1_400_000);
    expect((ix2.data as Buffer).readUInt32LE(1)).toBe(1_400_000);
  });

  it('throws for values above 1,400,000', () => {
    expect(() => buildSetComputeUnitLimitIx(1_400_001)).toThrow();
  });

  it('throws for negative values', () => {
    expect(() => buildSetComputeUnitLimitIx(-1)).toThrow();
  });

  it('allows zero', () => {
    const ix = buildSetComputeUnitLimitIx(0);
    expect((ix.data as Buffer).readUInt32LE(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SetComputeUnitPrice
// ---------------------------------------------------------------------------

describe('buildSetComputeUnitPriceIx', () => {
  it('creates instruction with correct program ID', () => {
    const ix = buildSetComputeUnitPriceIx(50_000n);
    expect(ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);
  });

  it('has no account keys', () => {
    const ix = buildSetComputeUnitPriceIx(50_000n);
    expect(ix.keys.length).toBe(0);
  });

  it('data is 9 bytes: [discriminator=3, u64_LE]', () => {
    const ix = buildSetComputeUnitPriceIx(50_000n);
    const data = ix.data as Buffer;

    expect(data.length).toBe(9);
    // Discriminator = 3
    expect(data[0]).toBe(3);
    // Value in little-endian u64
    expect(data.readBigUInt64LE(1)).toBe(50_000n);
  });

  it('encodes large values correctly', () => {
    const large = 1_000_000_000n; // 1 billion micro-lamports
    const ix = buildSetComputeUnitPriceIx(large);
    expect((ix.data as Buffer).readBigUInt64LE(1)).toBe(large);
  });

  it('throws for negative values', () => {
    expect(() => buildSetComputeUnitPriceIx(-1n)).toThrow();
  });

  it('allows zero', () => {
    const ix = buildSetComputeUnitPriceIx(0n);
    expect((ix.data as Buffer).readBigUInt64LE(1)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// buildComputeBudgetInstructions
// ---------------------------------------------------------------------------

describe('buildComputeBudgetInstructions', () => {
  it('returns exactly 2 instructions', () => {
    const ixs = buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET);
    expect(ixs.length).toBe(2);
  });

  it('first instruction is SetComputeUnitLimit', () => {
    const ixs = buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET);
    const data = ixs[0]!.data as Buffer;
    expect(data[0]).toBe(2); // discriminator for SetComputeUnitLimit
  });

  it('second instruction is SetComputeUnitPrice', () => {
    const ixs = buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET);
    const data = ixs[1]!.data as Buffer;
    expect(data[0]).toBe(3); // discriminator for SetComputeUnitPrice
  });
});

// ---------------------------------------------------------------------------
// Default budgets
// ---------------------------------------------------------------------------

describe('default compute budgets', () => {
  it('Pump.fun default: 200k CU, 700k micro-lamports', () => {
    // 2026-06-23: was 150k micro-lamports, doubled to 700k for faster inclusion
    expect(DEFAULT_PUMPFUN_COMPUTE_BUDGET.computeUnitLimit).toBe(200_000);
    expect(DEFAULT_PUMPFUN_COMPUTE_BUDGET.computeUnitPrice).toBe(700_000n);
  });

  it('Jupiter default: 400k CU, 200k micro-lamports', () => {
    expect(DEFAULT_JUPITER_COMPUTE_BUDGET.computeUnitLimit).toBe(400_000);
    expect(DEFAULT_JUPITER_COMPUTE_BUDGET.computeUnitPrice).toBe(200_000n);
  });

  it('Jupiter CU > Pump.fun CU (Jupiter needs more)', () => {
    expect(DEFAULT_JUPITER_COMPUTE_BUDGET.computeUnitLimit).toBeGreaterThan(
      DEFAULT_PUMPFUN_COMPUTE_BUDGET.computeUnitLimit,
    );
  });
});
