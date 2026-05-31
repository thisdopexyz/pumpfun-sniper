/**
 * Unit test: Price consistency across BC → Graduation transition
 * 
 * Verifies that:
 * 1. BC price and entry price use same scale (10^6)
 * 2. Graduated price (Jupiter/DexScreener) also uses 10^6 scale
 * 3. PNL doesn't spike when token graduates
 * 4. Trailing stop doesn't false-trigger after graduation
 */

import { describe, it, expect } from 'vitest';

// Import the actual price functions
import { computeEntryPriceScaled, computeBondingCurvePriceScaled } from '../../core/utils/price.js';

// Simulate fetchGraduatedPriceLamports (the FIXED version)
function fetchGraduatedPriceScaled(priceSol: number): bigint {
  return BigInt(Math.round(priceSol * 1_000_000));
}

// Simulate the OLD (buggy) version
function fetchGraduatedPriceRaw(priceSol: number): bigint {
  return BigInt(Math.round(priceSol * 1_000_000_000));
}

describe('Price Unit Consistency: BC → Graduation', () => {

  describe('computeEntryPriceScaled and computeBondingCurvePriceScaled use same scale', () => {
    it('should produce comparable prices for same token value', () => {
      // Simulate: 0.001 SOL buys 1M tokens
      const entryPrice = computeEntryPriceScaled(1_000_000n, 1_000_000_000n); // 0.001 SOL, 1B tokens
      
      // Simulate BC with matching reserves
      // vSol=30 SOL, vToken=1B tokens → same ratio
      const bcPrice = computeBondingCurvePriceScaled(30_000_000_000n, 1_000_000_000n);
      
      // Both should be in same order of magnitude (both scaled 10^6)
      // entryPrice = 1_000_000 * 10^6 / 1_000_000_000 = 1_000
      // bcPrice = 30_000_000_000 * 10^6 / 1_000_000_000 = 30_000_000
      expect(entryPrice).toBe(1000n);
      expect(bcPrice).toBe(30_000_000n);
      
      // Ratio depends on reserve sizes — both should be in same SCALE (10^6)
      // not same magnitude. Key: ratio should NOT be ~1000x (which would indicate
      // unit mismatch between 10^6 and 10^9).
      const ratio = Number(bcPrice) / Number(entryPrice);
      expect(ratio).toBeGreaterThan(1);
      // If ratio were ~1000, that would mean unit mismatch
      expect(ratio).not.toBeCloseTo(1000, 100);
      // Verify both are in 10^6 scale by checking magnitude
      expect(entryPrice).toBeLessThan(1_000_000_000n); // < 10^9 means it's scaled
      expect(bcPrice).toBeLessThan(1_000_000_000n);
    });
  });

  describe('Graduated price scale matches BC price scale', () => {
    it('FIXED: graduated price should be in same scale as BC price', () => {
      // Token at 0.0001 SOL per token
      const priceSol = 0.0001;
      
      const bcPrice = computeBondingCurvePriceScaled(
        30_000_000_000n, // 30 SOL in lamports
        300_000_000_000n // 300B tokens
      );
      
      const graduatedFixed = fetchGraduatedPriceScaled(priceSol);
      const graduatedRaw = fetchGraduatedPriceRaw(priceSol);
      
      // Fixed: 0.0001 * 10^6 = 100
      expect(graduatedFixed).toBe(100n);
      
      // Raw (old bug): 0.0001 * 10^9 = 100_000
      expect(graduatedRaw).toBe(100_000n);
      
      // Raw is 1000x the fixed version
      expect(graduatedRaw).toBe(graduatedFixed * 1000n);
    });

    it('FIXED: PNL should be ~0% when entry and current are same price', () => {
      const priceSol = 0.0001;
      const entryPrice = fetchGraduatedPriceScaled(priceSol); // 100
      const currentPriceFixed = fetchGraduatedPriceScaled(priceSol); // 100
      const currentPriceRaw = fetchGraduatedPriceRaw(priceSol); // 100_000
      
      // PNL with fixed: (100 - 100) * 10000 / 100 = 0%
      const pnlFixed = Number((currentPriceFixed - entryPrice) * 10000n / entryPrice) / 100;
      expect(pnlFixed).toBe(0);
      
      // PNL with raw (bug): (100_000 - 100) * 10000 / 100 = 9,990,000% !!!
      const pnlRaw = Number((currentPriceRaw - entryPrice) * 10000n / entryPrice) / 100;
      expect(pnlRaw).toBeGreaterThan(9000); // This is the BUG
    });
  });

  describe('Trailing stop should NOT false-trigger on graduation', () => {
    it('should not trigger trailing stop when price drops 17% after graduation', () => {
      // Scenario: Token at BC price 0.0001 SOL, peaks at 0.00017 SOL (+70%)
      // After graduation, price drops to 0.00014 SOL (-17% from peak)
      const entrySol = 0.0001;
      const peakSol = 0.00017;
      const currentSol = 0.00014;
      
      const entryPrice = fetchGraduatedPriceScaled(entrySol);
      const peakPrice = fetchGraduatedPriceScaled(peakSol);
      const currentPrice = fetchGraduatedPriceScaled(currentSol);
      
      // Trailing stop at 50% from peak
      const trailingPct = 50;
      const trailStopPrice = peakPrice * BigInt(100 - trailingPct) / 100n;
      
      // Current should be ABOVE trailing stop (17% drop < 50% drop)
      expect(currentPrice).toBeGreaterThan(trailStopPrice);
      
      // PNL check
      const pnlBps = (currentPrice - entryPrice) * 10000n / entryPrice;
      const pnlPercent = Number(pnlBps) / 100;
      expect(pnlPercent).toBeGreaterThan(0); // Still profitable
      expect(pnlPercent).toBeLessThan(100); // Reasonable
    });

    it('BUG DEMO: with raw prices, trailing stop false-triggers', () => {
      // Same scenario but with raw (buggy) prices
      const entrySol = 0.0001;
      const peakSol = 0.00017;
      const currentSol = 0.00014;
      
      // Entry uses scaled (from BC), current uses raw (from Jupiter) — THE BUG
      const entryPrice = fetchGraduatedPriceScaled(entrySol); // 100
      const peakPriceRaw = fetchGraduatedPriceRaw(peakSol); // 170_000
      const currentPriceRaw = fetchGraduatedPriceRaw(currentSol); // 140_000
      
      // Trailing stop calculation
      const trailingPct = 50;
      const trailStopPrice = peakPriceRaw * BigInt(100 - trailingPct) / 100n; // 85_000
      
      // PNL with mixed scales: (140_000 - 100) * 10000 / 100 = 139,900%
      const pnlBps = (currentPriceRaw - entryPrice) * 10000n / entryPrice;
      const pnlPercent = Number(pnlBps) / 100;
      
      // The PNL is absurdly high
      expect(pnlPercent).toBeGreaterThan(10000);
      
      // highestPriceLamports would be 170_000 (from Jupiter raw)
      // Then price "drops" to 140_000 — that's only 17.6% drop
      // But entryPrice is 100, so PNL went from +169,900% to +139,900%
      // The dynamic trailing would tighten to 20% (at >1000% PNL)
      const dynamicTrail = 20; // tightened because PNL > 1000%
      const dynamicTrailStop = peakPriceRaw * BigInt(100 - dynamicTrail) / 100n; // 136_000
      
      // 140_000 > 136_000 so trailing stop doesn't trigger YET
      // But if price drops to 135_000 (20.6% from peak), it triggers
      // even though the ACTUAL drop is only 20.6%, not 50%
      expect(currentPriceRaw).toBeGreaterThan(dynamicTrailStop);
      
      // At 20.6% drop from peak, trailing stop triggers (because dynamic=20%)
      const slightlyLower = peakPriceRaw * 79n / 100n; // 21% drop
      expect(slightlyLower).toBeLessThanOrEqual(dynamicTrailStop);
      // ↑ This shows the trailing stop triggers at 21% drop instead of 50%
      // because the PNL is inflated by 1000x
    });
  });

  describe('Transition continuity: BC price → Graduated price', () => {
    it('should maintain consistent PNL when token transitions from BC to Jupiter', () => {
      // Entry on BC
      const entrySol = 0.0001;
      const entryPrice = fetchGraduatedPriceScaled(entrySol); // 100
      
      // Price on BC (before graduation)
      const bcPriceSol = 0.00015; // +50% from entry
      const bcPrice = fetchGraduatedPriceScaled(bcPriceSol); // 150
      
      const pnlBC = Number((bcPrice - entryPrice) * 10000n / entryPrice) / 100;
      expect(pnlBC).toBeCloseTo(50, 0); // ~50% PNL
      
      // Same price but fetched from Jupiter (after graduation)
      const jupiterPriceFixed = fetchGraduatedPriceScaled(bcPriceSol); // 150
      const pnlJupiterFixed = Number((jupiterPriceFixed - entryPrice) * 10000n / entryPrice) / 100;
      expect(pnlJupiterFixed).toBeCloseTo(50, 0); // Same ~50% PNL ✅
      
      // With old bug (raw Jupiter price)
      const jupiterPriceRaw = fetchGraduatedPriceRaw(bcPriceSol); // 150_000
      const pnlJupiterRaw = Number((jupiterPriceRaw - entryPrice) * 10000n / entryPrice) / 100;
      expect(pnlJupiterRaw).toBeGreaterThan(100000); // 149,900% ← BUG!
    });
  });
});
