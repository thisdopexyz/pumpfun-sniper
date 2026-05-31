/**
 * Standalone test: TP / SL / TRAILING comprehensive validation
 *
 * Constants (from trading.ts):
 *   TP = +1500%    (all scale-out tiers must be done first)
 *   SL = -80%      (always active)
 *   Trailing = dynamic:
 *     - Activation: +100% (highest must exceed this)
 *     - Default: 50% drop from highest
 *     - +200%: 40% drop
 *     - +500%: 30% drop
 *     - +1000%: 20% drop
 *   Timeout = 6h
 *   Scale-out tiers: [+100%→50%, +300%→25%, +500%→15%]
 */

import { describe, it, expect } from 'vitest';
import { evaluateExit } from '@strategies/filteredSniper/exitDecision.js';
import type { ExitDecisionData } from '@strategies/filteredSniper/exitDecision.js';
import {
  TAKE_PROFIT_PERCENT,
  STOP_LOSS_PERCENT,
  TRAILING_STOP_PCT,
  TRAILING_ACTIVATION_PCT,
  TIMEOUT_MS,
  SCALE_OUT_TIERS,
} from '@strategies/filteredSniper/filteredSniperRules.js';

function makeExitData(overrides: Partial<ExitDecisionData> = {}): ExitDecisionData {
  return {
    tradeId: 'test-trade-001',
    mint: 'TestMint1111111111111111111111111111111111',
    entryPriceLamports: 1000n,
    currentPriceLamports: 1000n, // 0% P&L
    highestPriceLamports: 1000n,
    openedAt: Date.now() - 60_000, // opened 60s ago
    scaleOutTiersCompleted: [0, 1, 2], // all tiers done by default
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants verification
// ─────────────────────────────────────────────────────────────────────────────

describe('Exit constants match rule.md', () => {
  it('TAKE_PROFIT = +1500%', () => {
    expect(TAKE_PROFIT_PERCENT).toBe(1500);
  });
  it('STOP_LOSS = -80%', () => {
    expect(STOP_LOSS_PERCENT).toBe(-80);
  });
  it('TRAILING_STOP default = 50%', () => {
    expect(TRAILING_STOP_PCT).toBe(50);
  });
  it('TRAILING_ACTIVATION = +100%', () => {
    expect(TRAILING_ACTIVATION_PCT).toBe(100);
  });
  it('TIMEOUT = 6h', () => {
    expect(TIMEOUT_MS).toBe(6 * 60 * 60 * 1000);
  });
  it('SCALE_OUT_TIERS = [+100%→50%, +300%→25%, +500%→15%]', () => {
    expect(SCALE_OUT_TIERS).toEqual([
      { triggerPct: 100, sellPct: 50 },
      { triggerPct: 300, sellPct: 25 },
      { triggerPct: 500, sellPct: 15 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STOP LOSS
// ─────────────────────────────────────────────────────────────────────────────

describe('STOP_LOSS', () => {
  it('triggers at exactly -80%', () => {
    // entry=1000, current=200 → -80%
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 200n,
      highestPriceLamports: 1000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('triggers at -100% (total loss)', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 0n,
      highestPriceLamports: 1000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('does NOT trigger at -59%', () => {
    // entry=1000, current=401 → -59.9%
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 410n, // -59%
      highestPriceLamports: 1000n,
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('STOP_LOSS');
  });

  it('triggers at -80% when trailing NOT active (highest below activation)', () => {
    // entry=1000, highest=1500 (+50% < +100% activation), current=200 (-80%)
    // Trailing doesn't activate because highest < +100%
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 200n,
      highestPriceLamports: 1500n, // +50% — below activation
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('TRAILING_STOP fires before SL when trailing active (flash crash)', () => {
    // entry=1000, highest=5000 (+400%), current=400 (-60%)
    // Trailing activates at +400%, stop price = 5000*60% = 3000
    // current=400 < 3000 → TRAILING fires (priority > SL)
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 400n,
      highestPriceLamports: 5000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP'); // trailing has higher priority
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TAKE PROFIT
// ─────────────────────────────────────────────────────────────────────────────

describe('TAKE_PROFIT', () => {
  it('triggers at +1500% (all tiers done)', () => {
    // entry=1000, current=16000 → +1500%
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 16000n,
      highestPriceLamports: 16000n,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TAKE_PROFIT');
  });

  it('does NOT trigger if scale-out tiers remain', () => {
    // At +1500% but tier 2 not done
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 16000n,
      highestPriceLamports: 16000n,
      scaleOutTiersCompleted: [0, 1], // tier 2 NOT done
    });
    const result = evaluateExit(data);
    // Should fire SCALE_OUT tier 2 instead
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.tierIndex).toBe(2);
  });

  it('does NOT trigger at +1499%', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 15990n, // +1499%
      highestPriceLamports: 15990n,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('TAKE_PROFIT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRAILING STOP — dynamic tightening
// ─────────────────────────────────────────────────────────────────────────────

describe('TRAILING_STOP — dynamic tightening', () => {
  it('does NOT activate if highest never exceeded +100%', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1500n, // +50%
      highestPriceLamports: 1900n, // +90% (below +100% activation)
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('TRAILING_STOP');
  });

  it('activates at +100% highest, triggers on 50% drop (default)', () => {
    // highest=2000 (+100%), current=950 (-5% from entry)
    // trailing stop = 2000 * 50% = 1000 → current 950 < 1000 → TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 950n,
      highestPriceLamports: 2000n, // +100%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('50% trailing: does NOT trigger when price within range', () => {
    // highest=2000 (+100%), current=1100 (+10%)
    // trailing stop = 2000 * 50% = 1000 → current 1100 > 1000 → NO TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1100n,
      highestPriceLamports: 2000n,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('TRAILING_STOP');
  });

  it('tightens to 40% at +200% highest', () => {
    // highest=3000 (+200%), trailing = 3000 * 60% = 1800
    // current=1750 < 1800 → TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1750n,
      highestPriceLamports: 3000n, // +200%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('40% trailing at +200%: does NOT trigger within range', () => {
    // highest=3000 (+200%), trailing = 3000 * 60% = 1800
    // current=1850 > 1800 → NO TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1850n,
      highestPriceLamports: 3000n,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('TRAILING_STOP');
  });

  it('tightens to 30% at +500% highest', () => {
    // highest=6000 (+500%), trailing = 6000 * 70% = 4200
    // current=4100 < 4200 → TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 4100n,
      highestPriceLamports: 6000n, // +500%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('tightens to 20% at +1000% highest', () => {
    // highest=11000 (+1000%), trailing = 11000 * 80% = 8800
    // current=8700 < 8800 → TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 8700n,
      highestPriceLamports: 11000n, // +1000%
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('20% trailing at +1000%: does NOT trigger within range', () => {
    // highest=11000 (+1000%), trailing = 11000 * 80% = 8800
    // current=9000 > 8800 → NO TRIGGER
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 9000n,
      highestPriceLamports: 11000n,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('TRAILING_STOP');
  });

  it('does NOT fire if scale-out tiers remain', () => {
    // highest=11000 (+1000%), current=8700
    // Would trigger trailing, but tier 2 not done
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 8700n,
      highestPriceLamports: 11000n,
      scaleOutTiersCompleted: [0, 1], // tier 2 NOT done
    });
    const result = evaluateExit(data);
    // Should fire SCALE_OUT tier 2 instead
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.tierIndex).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY ORDER
// ─────────────────────────────────────────────────────────────────────────────

describe('Priority order', () => {
  it('SCALE_OUT > TRAILING_STOP (tiers remain)', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 8700n, // +770%
      highestPriceLamports: 11000n, // trailing would trigger
      scaleOutTiersCompleted: [0], // tiers 1,2 remain
    });
    const result = evaluateExit(data);
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.tierIndex).toBe(1); // tier 1 next
  });

  it('STOP_LOSS < TRAILING_STOP priority (trailing fires first when active)', () => {
    // entry=1000, highest=2000 (+100%), current=400 (-60%)
    // Trailing activates, stop = 2000*50% = 1000
    // current=400 < 1000 → TRAILING fires (not SL)
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 400n,
      highestPriceLamports: 2000n,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP'); // trailing > SL in priority
  });

  it('STOP_LOSS fires when trailing NOT active', () => {
    // entry=1000, highest=1500 (+50% < +100%), current=200 (-80%)
    // SL = -80%, trailing nonaktif karena highest < activation
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 200n,
      highestPriceLamports: 1500n, // below activation
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('NO EXIT in normal range', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1200n, // +20%
      highestPriceLamports: 1200n,
      elapsedMs: 60_000,
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIMEOUT
// ─────────────────────────────────────────────────────────────────────────────

describe('TIMEOUT', () => {
  it('triggers after 6 hours', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1100n, // +10%
      highestPriceLamports: 1100n,
      openedAt: Date.now() - 6 * 60 * 60 * 1000, // opened 6h ago
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TIMEOUT');
  });

  it('does NOT trigger at 5h59m', () => {
    const data = makeExitData({
      entryPriceLamports: 1000n,
      currentPriceLamports: 1100n,
      highestPriceLamports: 1100n,
      openedAt: Date.now() - (6 * 60 * 60 * 1000 - 1000), // opened 5h59m59s ago
      scaleOutTiersCompleted: [0, 1, 2],
    });
    const result = evaluateExit(data);
    expect(result.reason).not.toBe('TIMEOUT');
  });
});
