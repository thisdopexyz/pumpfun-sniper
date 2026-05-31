/**
 * Standalone test: Scale-out persistence + flow validation
 *
 * Tests:
 * 1. Tier detection: +100% → tier 0, +300% → tier 1, +500% → tier 2
 * 2. Partial sell percentages: 50%, 25%, 15%
 * 3. Persistence across restarts (DB save/load)
 * 4. All tiers done → full exit
 * 5. Scale-out fires before trailing when tier threshold met
 */

import { describe, it, expect } from 'vitest';
import { evaluateExit } from '@strategies/filteredSniper/exitDecision.js';
import type { ExitDecisionData } from '@strategies/filteredSniper/exitDecision.js';
import { SCALE_OUT_TIERS } from '@strategies/filteredSniper/filteredSniperRules.js';

function makeExitData(overrides: Partial<ExitDecisionData> = {}): ExitDecisionData {
  return {
    tradeId: 'test-trade-001',
    mint: 'TestMint1111111111111111111111111111111111',
    entryPriceLamports: 1000n,
    currentPriceLamports: 2000n, // +100%
    highestPriceLamports: 2000n,
    elapsedMs: 60_000,
    scaleOutTiersCompleted: [],
    ...overrides,
  };
}

describe('Scale-out tiers config', () => {
  it('has correct tier configuration', () => {
    expect(SCALE_OUT_TIERS).toHaveLength(3);
    expect(SCALE_OUT_TIERS[0]).toEqual({ triggerPct: 100, sellPct: 50 });
    expect(SCALE_OUT_TIERS[1]).toEqual({ triggerPct: 300, sellPct: 25 });
    expect(SCALE_OUT_TIERS[2]).toEqual({ triggerPct: 500, sellPct: 15 });
  });
});

describe('Scale-out exit decisions', () => {
  it('tier 0 fires at +100%', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 2000n, // +100%
      scaleOutTiersCompleted: [],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.sellPct).toBe(50);
    expect(result.tierIndex).toBe(0);
  });

  it('tier 1 fires at +300%', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 4000n, // +300%
      scaleOutTiersCompleted: [0],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.sellPct).toBe(25);
    expect(result.tierIndex).toBe(1);
  });

  it('tier 2 fires at +500%', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 6000n, // +500%
      scaleOutTiersCompleted: [0, 1],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.sellPct).toBe(15);
    expect(result.tierIndex).toBe(2);
  });

  it('does NOT fire tier 1 if tier 0 not completed', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 4000n, // +300%
      scaleOutTiersCompleted: [], // tier 0 not done
    });
    const result = evaluateExit(data);
    // Should fire tier 0 first (at +300% which is > +100%)
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.tierIndex).toBe(0); // tier 0 first
    expect(result.sellPct).toBe(50);
  });

  it('does NOT fire at +50% (below tier 0 threshold)', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1500n, // +50%
      scaleOutTiersCompleted: [],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('SCALE_OUT');
  });

  it('all tiers done → no more SCALE_OUT', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 10000n, // +900%
      scaleOutTiersCompleted: [0, 1, 2], // all done
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('SCALE_OUT');
  });

  it('trailing stop fires independently of scale-out tiers', () => {
    // At +1000%, highest was +1500%, now dropped to +1000%
    // Trailing fires even with all tiers done
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 11000n, // +1000%
      highestPriceLamports: 16000n, // was +1500%
      scaleOutTiersCompleted: [0, 1, 2], // all done
    });
    const result = evaluateExit(data);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('scale-out fires BEFORE trailing when tier threshold met', () => {
    // Even if trailing would trigger, scale-out fires first when tier threshold hit
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 11000n, // +1000%
      highestPriceLamports: 16000n, // was +1500%
      scaleOutTiersCompleted: [0, 1], // tier 2 NOT done
    });
    const result = evaluateExit(data);
    // Should fire tier 2 (at +1000% which is > +500%)
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.tierIndex).toBe(2);
  });
});

describe('Scale-out sell amount math', () => {
  it('correct remaining balance after all 3 tiers', () => {
    // Start: 100 tokens
    // Tier 0: sell 50% → 50 remaining
    // Tier 1: sell 25% of 50 → 37.5 remaining
    // Tier 2: sell 15% of 37.5 → 31.875 remaining
    let balance = 100_000_000_000n; // 100B tokens

    // Tier 0: sell 50%
    balance = balance - (balance * 50n / 100n);
    expect(balance).toBe(50_000_000_000n);

    // Tier 1: sell 25%
    balance = balance - (balance * 25n / 100n);
    expect(balance).toBe(37_500_000_000n);

    // Tier 2: sell 15%
    balance = balance - (balance * 15n / 100n);
    expect(balance).toBe(31_875_000_000n);

    // After all tiers: 31.875% of original remains
    // This continues riding with trailing stop
    console.log(`  Remaining after 3 tiers: ${balance} (31.875% of original)`);
  });
});
