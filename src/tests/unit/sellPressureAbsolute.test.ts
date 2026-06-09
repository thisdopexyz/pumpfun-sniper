/**
 * Sell pressure check — ratio-based with 2x window
 *
 * Buy window: 30s (momentum)
 * Sell window: 60s (2x ratio)
 * Threshold: MAX_SELL_RATIO_PCT = 60%
 */

import { describe, it, expect } from 'vitest';
import { evaluateEntry } from '@strategies/filteredSniper/entryDecision.js';
import type { EntryCheckData } from '@strategies/filteredSniper/entryDecision.js';

function makeData(overrides: Partial<EntryCheckData> = {}): EntryCheckData {
  return {
    mint: 'TestMint1111111111111111111111111111111111' as any,
    launchDetected: true,
    creatorNotBlacklisted: true,
    creatorHistoryAcceptable: true,
    creatorScore: 50,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    metadataSane: true,
    liquiditySane: true,
    walletConcentrationAcceptable: true,
    buyCountInWindow: 10,
    volumeLamports: 2_000_000_000n,
    windowMs: 30_000,
    priceImpactBps: 100,
    uniqueWallets: 10,
    sellCountInWindow: 0,
    realSolReservesLamports: 2_000_000_000n,
    holderCount: 80,
    secondsSinceLaunch: 1800,
    marketCapUsd: 15000,
    ...overrides,
  };
}

describe('Sell pressure — ratio (60% threshold, 30s buy / 60s sell)', () => {
  it('PASSES when sell ratio < 60%', () => {
    // 5 sells / (10+5) = 33%
    const r = evaluateEntry(makeData({ buyCountInWindow: 10, sellCountInWindow: 5 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('PASSES at exactly 60%', () => {
    // 15 sells / (10+15) = 60%
    const r = evaluateEntry(makeData({ buyCountInWindow: 10, sellCountInWindow: 15 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('BLOCKS at 61%', () => {
    // 16 sells / (10+16) = 61.5%
    const r = evaluateEntry(makeData({ buyCountInWindow: 10, sellCountInWindow: 16 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(false);
  });

  it('EtqqBzh6: 68 sells / (45+68) = 60% → PASS', () => {
    const r = evaluateEntry(makeData({ buyCountInWindow: 45, sellCountInWindow: 68 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    // 68/113 = 60.2% → BLOCK (just over 60%)
    expect(c!.passed).toBe(false);
  });

  it('wPSgRXvv: 23 sells / (26+23) = 47% → PASS', () => {
    const r = evaluateEntry(makeData({ buyCountInWindow: 26, sellCountInWindow: 23 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('AvxS9N5EEuQr: 0 sells → PASS', () => {
    const r = evaluateEntry(makeData({ buyCountInWindow: 10, sellCountInWindow: 0 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('High buys + high sells → ratio matters', () => {
    // 100 buys + 100 sells = 50% → PASS
    const r = evaluateEntry(makeData({ buyCountInWindow: 100, sellCountInWindow: 100 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('Low buys + high sells → BLOCK', () => {
    // 5 buys + 20 sells = 80% → BLOCK
    const r = evaluateEntry(makeData({ buyCountInWindow: 5, sellCountInWindow: 20 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(false);
  });

  it('undefined sellCount → PASS (pipeline not active)', () => {
    const r = evaluateEntry(makeData({ sellCountInWindow: undefined }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('null sellCount → BLOCK', () => {
    const r = evaluateEntry(makeData({ sellCountInWindow: null as any }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(false);
  });

  it('buyCount = 0 → BLOCK', () => {
    const r = evaluateEntry(makeData({ buyCountInWindow: 0, sellCountInWindow: 5 }));
    const c = r.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(false);
  });

  it('All 26 checks present', () => {
    const r = evaluateEntry(makeData());
    expect(r.checks.length).toBe(26);
  });
});
