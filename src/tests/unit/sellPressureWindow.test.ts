/**
 * Sell pressure — ratio-based with 2x window
 * Buy: 30s, Sell: 60s, Threshold: 60%
 */

import { describe, it, expect } from 'vitest';
import { evaluateEntry } from '@strategies/filteredSniper/entryDecision.js';
import type { EntryCheckData } from '@strategies/filteredSniper/entryDecision.js';

function makeBaseData(overrides: Partial<EntryCheckData> = {}): EntryCheckData {
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

describe('Sell pressure (Check 14) — ratio', () => {
  it('BLOCKS when sell ratio > 60%', () => {
    // 35 sells / (10+35) = 77%
    const data = makeBaseData({ buyCountInWindow: 10, sellCountInWindow: 35 });
    const result = evaluateEntry(data);
    const c = result.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(false);
  });

  it('PASSES when sell ratio < 60%', () => {
    // 5 sells / (10+5) = 33%
    const data = makeBaseData({ buyCountInWindow: 10, sellCountInWindow: 5 });
    const result = evaluateEntry(data);
    const c = result.checks.find(c => c.name === 'sell_pressure');
    expect(c!.passed).toBe(true);
  });

  it('All 26 checks present', () => {
    const data = makeBaseData();
    const result = evaluateEntry(data);
    expect(result.checks.length).toBe(26);
  });
});
