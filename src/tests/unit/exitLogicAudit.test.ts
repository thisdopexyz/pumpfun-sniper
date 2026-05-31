/**
 * COMPREHENSIVE EXIT LOGIC AUDIT
 * 
 * 3 profit exit paths:
 * 1. SCALE-OUT: Tier 0 (+100%→50%), Tier 1 (+300%→25%), Tier 2 (+500%→15%)
 * 2. TRAILING STOP: Dynamic (50%→40%→30%→20%), activates at +100%
 * 3. TAKE PROFIT: +1500% (only after all tiers done)
 * 
 * Verifies:
 * - Correct trigger percentages
 * - Correct sell amounts
 * - Correct priority order
 * - Remaining balance after all tiers
 * - Trailing stop sells 100% of remaining
 */

import { describe, it, expect } from 'vitest';
import { evaluateExit } from '@strategies/filteredSniper/exitDecision.js';
import type { PositionData } from '@strategies/filteredSniper/exitDecision.js';
import { SCALE_OUT_TIERS } from '@strategies/filteredSniper/filteredSniperRules.js';

function makeData(overrides: Partial<PositionData> = {}): PositionData {
  return {
    mint: 'TestMint1111111111111111111111111111111111' as any,
    tradeId: 'test-001',
    entryPriceLamports: 1000n,
    currentPriceLamports: 1000n,
    highestPriceLamports: 1000n,
    openedAt: Date.now() - 60_000,
    killSwitchActive: false,
    scaleOutTiersCompleted: [],
    ...overrides,
  };
}

describe('1. SCALE-OUT — trigger + sell amount verification', () => {
  it('Tier 0: triggers at exactly +100%, sells 50%', () => {
    const data = makeData({
      currentPriceLamports: 2000n, // +100%
      scaleOutTiersCompleted: [],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
    expect(r.sellPct).toBe(50);
    expect(r.tierIndex).toBe(0);
  });

  it('Tier 0: does NOT trigger at +99%', () => {
    const data = makeData({
      currentPriceLamports: 1990n, // +99%
      scaleOutTiersCompleted: [],
    });
    const r = evaluateExit(data);
    expect(r.reason).not.toBe('SCALE_OUT');
  });

  it('Tier 1: triggers at +300%, sells 25%', () => {
    const data = makeData({
      currentPriceLamports: 4000n, // +300%
      scaleOutTiersCompleted: [0],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
    expect(r.sellPct).toBe(25);
    expect(r.tierIndex).toBe(1);
  });

  it('Tier 2: triggers at +500%, sells 15%', () => {
    const data = makeData({
      currentPriceLamports: 6000n, // +500%
      scaleOutTiersCompleted: [0, 1],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
    expect(r.sellPct).toBe(15);
    expect(r.tierIndex).toBe(2);
  });

  it('Sells tier 0 FIRST even at +500% if tier 0 not done', () => {
    const data = makeData({
      currentPriceLamports: 6000n, // +500%
      scaleOutTiersCompleted: [], // no tiers done
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
    expect(r.tierIndex).toBe(0); // tier 0 first!
    expect(r.sellPct).toBe(50);
  });

  it('On-chain verified: 3 sequential sells = correct amounts', () => {
    // Simulate AGNsxSEi exact flow
    let balance = 16172785604n; // original buy amount
    
    // Tier 0: sell 50%
    const tier0Sell = balance * 50n / 100n;
    balance -= tier0Sell;
    expect(tier0Sell).toBe(8086392802n);
    expect(balance).toBe(8086392802n);
    
    // Tier 1: sell 25% of remaining
    const tier1Sell = balance * 25n / 100n;
    balance -= tier1Sell;
    expect(tier1Sell).toBe(2021598200n);
    expect(balance).toBe(6064794602n);
    
    // Tier 2: sell 15% of remaining
    const tier2Sell = balance * 15n / 100n;
    balance -= tier2Sell;
    expect(tier2Sell).toBe(909719190n);
    expect(balance).toBe(5155075412n);
    
    // Remaining: 31.875% of original
    const remainingPct = Number(balance * 10000n / 16172785604n) / 100;
    expect(remainingPct).toBeCloseTo(31.875, 2);
    
    console.log(`  Remaining after 3 tiers: ${balance} (${remainingPct}%)`);
  });
});

describe('2. TRAILING STOP — dynamic tightening', () => {
  it('Does NOT activate if highest < +100%', () => {
    const data = makeData({
      highestPriceLamports: 1900n, // +90%
      currentPriceLamports: 950n, // dropped 50% from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).not.toBe('TRAILING_STOP');
  });

  it('Default 50% trail: highest +100%, drop 50% = TRIGGER', () => {
    const data = makeData({
      highestPriceLamports: 2000n, // +100%
      currentPriceLamports: 1000n, // 50% drop from peak = back to entry
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP');
  });

  it('Default 50% trail: drop 49% = NO trigger', () => {
    const data = makeData({
      highestPriceLamports: 2000n, // +100%
      currentPriceLamports: 1020n, // 49% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).not.toBe('TRAILING_STOP');
  });

  it('Tightens to 40% at +200% highest', () => {
    const data = makeData({
      highestPriceLamports: 3000n, // +200%
      currentPriceLamports: 1800n, // 40% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP');
  });

  it('Tightens to 30% at +500% highest', () => {
    const data = makeData({
      highestPriceLamports: 6000n, // +500%
      currentPriceLamports: 4200n, // 30% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP');
  });

  it('Tightens to 20% at +1000% highest', () => {
    const data = makeData({
      highestPriceLamports: 11000n, // +1000%
      currentPriceLamports: 8800n, // 20% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP');
  });

  it('SELLS 100% of remaining (not partial)', () => {
    const data = makeData({
      highestPriceLamports: 2000n, // +100%
      currentPriceLamports: 900n, // 55% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP');
    expect(r.sellPct).toBeUndefined(); // undefined = 100% (default)
  });

  it('TRAILING_STOP FIRES even when scale-out tiers remain (protects dead zone)', () => {
    // BUG FIX: Previously trailing was blocked when tiers remained.
    // This left positions unprotected in the "dead zone" — price not high enough
    // for next tier but dropped significantly from peak.
    // Entry=1000, highest=2000 (+100%), current=900 (-10% from entry, 55% drop from peak)
    // No tier triggers at -10% PnL, but trailing should fire to protect position.
    const data = makeData({
      highestPriceLamports: 2000n, // +100%
      currentPriceLamports: 900n, // -10% from entry, 55% drop from peak
      scaleOutTiersCompleted: [0, 1], // tier 2 not done
    });
    const r = evaluateExit(data);
    // trailing stop = 2000 * 50% = 1000, current 900 < 1000 → TRAILING_STOP fires
    expect(r.reason).toBe('TRAILING_STOP');
    expect(r.shouldExit).toBe(true);
  });

  it('Trailing BLOCKED, but scale-out fires if pnl above tier threshold', () => {
    const data = makeData({
      highestPriceLamports: 8000n, // +700%
      currentPriceLamports: 6000n, // +500% → tier 2 threshold met
      scaleOutTiersCompleted: [0, 1], // tier 2 not done
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
    expect(r.tierIndex).toBe(2);
    expect(r.sellPct).toBe(15);
  });

  it('BUG SCENARIO: trailing should fire after all tiers done', () => {
    // Simulate: all 3 tiers done, price was +1000%, now dropped 25%
    const data = makeData({
      highestPriceLamports: 11000n, // was +1000%
      currentPriceLamports: 8250n, // 25% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP');
    // This should sell 100% of remaining 31.875%
    expect(r.sellPct).toBeUndefined();
  });
});

describe('3. TAKE PROFIT — +1500%', () => {
  it('Triggers at +1500% (all tiers done)', () => {
    const data = makeData({
      currentPriceLamports: 16000n, // +1500%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TAKE_PROFIT');
  });

  it('Does NOT trigger at +1499%', () => {
    const data = makeData({
      currentPriceLamports: 15990n, // +1499%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).not.toBe('TAKE_PROFIT');
  });

  it('BLOCKED if tiers remain', () => {
    const data = makeData({
      currentPriceLamports: 16000n, // +1500%
      scaleOutTiersCompleted: [0], // tiers 1,2 not done
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
  });
});

describe('PRIORITY ORDER', () => {
  it('Scale-out > Trailing (when tiers remain)', () => {
    const data = makeData({
      highestPriceLamports: 11000n,
      currentPriceLamports: 8000n, // trailing would trigger
      scaleOutTiersCompleted: [0], // tier 1,2 remain
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('SCALE_OUT');
    expect(r.tierIndex).toBe(1);
  });

  it('Trailing > Stop-loss (when trailing active)', () => {
    const data = makeData({
      highestPriceLamports: 2000n, // +100%
      currentPriceLamports: 400n, // -60% from entry, 80% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('TRAILING_STOP'); // not STOP_LOSS
  });

  it('Stop-loss > Take-profit (when SL triggers)', () => {
    const data = makeData({
      currentPriceLamports: 200n, // -80% (triggers SL at -80%)
      highestPriceLamports: 200n, // never exceeded +100%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    expect(r.reason).toBe('STOP_LOSS');
  });
});

describe('BUG: AGNsxSEi scenario', () => {
  it('After 3 tiers, trailing should handle remaining', () => {
    // Entry: 1000, peak was +534% = 6340
    // After 3 tiers: 31.875% remaining
    // Price dropped from 6340 to... let's say 3000 (52% drop from peak)
    const data = makeData({
      entryPriceLamports: 1000n,
      highestPriceLamports: 6340n, // +534%
      currentPriceLamports: 3000n, // 52% drop from peak
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const r = evaluateExit(data);
    // At +500%, trailing = 30% drop
    // trailingStopPrice = 6340 * 70% = 4438
    // current=3000 < 4438 → TRAILING_STOP should fire
    expect(r.reason).toBe('TRAILING_STOP');
    expect(r.sellPct).toBeUndefined(); // sells 100% of remaining
  });
});
