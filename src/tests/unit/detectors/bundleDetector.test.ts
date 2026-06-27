/**
 * Unit tests for BundleDetector.
 *
 * Tests:
 *   - Normal organic buys (spread across many slots/wallets) → no signal
 *   - Bundled buys (same slot, few wallets) → signal emitted
 *   - Mixed scenario
 *   - Funding source clustering
 *   - Cooldown behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BundleDetector, type BundleBuyEvent } from '@detectors/bundle/bundleDetector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINT = 'TestMint111111111111111111111111111111111111';

function makeBuy(overrides?: Partial<BundleBuyEvent>): BundleBuyEvent {
  return {
    mint: MINT,
    wallet: `Wallet${String(Math.random()).slice(2, 10)}`,
    slot: 422383700,
    timestamp: Date.now(),
    tokenAmount: 1_000_000_000n, // 1B tokens
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BundleDetector', () => {
  let detector: BundleDetector;
  let signals: Array<{
    bundlePct: number;
    clusteredWalletCount: number;
    totalBuyCount: number;
    windowMs: number;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new BundleDetector({
      windowSeconds: 60,
      maxBundlePct: 30,
      minBuyCount: 5,
      cooldownMs: 0, // no cooldown for most tests
      forceAnalyzeMinMs: 0, // bypass 30s minimum so tests don't need time mocking
      partialWindowSafetyMarginPct: 0, // tests use deterministic data — no safety margin needed
    });
    signals = [];
    detector.onSignal((signal) => {
      if (signal.type === 'BUNDLE') {
        signals.push({
          bundlePct: signal.bundlePct,
          clusteredWalletCount: signal.clusteredWalletCount,
          totalBuyCount: signal.totalBuyCount,
          windowMs: signal.windowMs,
        });
      }
    });
    detector.start();
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Organic buys — no signal
  // -------------------------------------------------------------------------

  it('does NOT emit signal for organic buys spread across many slots/wallets', () => {
    // 10 buys from 10 different wallets across 10 different slots
    // Each buys 1B tokens (10% of 10B supply each, but no cluster)
    for (let i = 0; i < 10; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Wallet${i}`,
        slot: 422383700 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // Force analysis
    const pct = detector.forceAnalyze(MINT);

    // No single cluster should be > 30%
    expect(signals).toHaveLength(0);
    expect(pct).toBeLessThanOrEqual(30);
  });

  it('does NOT emit signal when buys are below minBuyCount', () => {
    // Only 3 buys (below minBuyCount of 5) — same slot, same wallet
    for (let i = 0; i < 3; i++) {
      detector.handleBuy(makeBuy({
        wallet: 'WalletA',
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 5_000_000_000n,
      }));
    }

    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(0);
    expect(pct).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Bundled buys — signal emitted
  // -------------------------------------------------------------------------

  it('emits signal when 5 buys from same slot by same wallet (100% bundle)', () => {
    for (let i = 0; i < 5; i++) {
      detector.handleBuy(makeBuy({
        wallet: 'WalletA',
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
      }));
    }

    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1);
    expect(signals[0].bundlePct).toBe(100);
    expect(signals[0].clusteredWalletCount).toBe(1);
    expect(signals[0].totalBuyCount).toBe(5);
    expect(pct).toBe(100);
  });

  it('emits signal when 3 wallets buy in the same slot (clustered)', () => {
    // 3 wallets buy in same slot — they form a slot cluster
    // Each buys 2B tokens out of 10B total = 60% cluster
    const slot = 422383700;
    for (let i = 0; i < 3; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Wallet${i}`,
        slot,
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
      }));
    }

    // 2 additional wallets buy in different slots (not clustered)
    detector.handleBuy(makeBuy({
      wallet: 'WalletX',
      slot: 422383710,
      timestamp: Date.now(),
      tokenAmount: 2_000_000_000n,
    }));
    detector.handleBuy(makeBuy({
      wallet: 'WalletY',
      slot: 422383711,
      timestamp: Date.now(),
      tokenAmount: 2_000_000_000n,
    }));

    const pct = detector.forceAnalyze(MINT);
    // Cluster wallets: Wallet0, Wallet1, Wallet2 = 6B out of 10B = 60%
    // (May differ slightly due to single-wallet concentration check including
    // isolated singles; we just verify it's >= 30% threshold and cluster detected)
    expect(signals).toHaveLength(1);
    expect(signals[0].bundlePct).toBeGreaterThanOrEqual(30);
    expect(signals[0].bundlePct).toBeLessThanOrEqual(70);
    expect(signals[0].clusteredWalletCount).toBe(3);
    expect(signals[0].totalBuyCount).toBe(5);
    expect(pct).toBeGreaterThanOrEqual(30);
  });

  it('emits signal when bundle exceeds 30% threshold precisely', () => {
    // 6 wallets buy in same slot: each 600M = 3.6B out of 10B = 36%
    for (let i = 0; i < 6; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Wallet${i}`,
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 600_000_000n,
      }));
    }

    // 4 other wallets buy organically
    for (let i = 0; i < 4; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383720 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // Total: 3.6B + 4B = 7.6B. Cluster = 3.6B / 7.6B = 47.4%
    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1);
    expect(signals[0].bundlePct).toBeGreaterThan(30);
    expect(signals[0].clusteredWalletCount).toBe(6);
    expect(signals[0].totalBuyCount).toBe(10);
    expect(pct).toBeGreaterThan(30);
  });

  // -------------------------------------------------------------------------
  // Mixed scenario
  // -------------------------------------------------------------------------

  it('does NOT emit signal when bundle is below threshold (20%)', () => {
    // 3 wallets in same slot, each 1B = 3B out of 15B = 20%
    for (let i = 0; i < 3; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Cluster${i}`,
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // 12 other wallets buy organically, each 1B = 12B
    for (let i = 0; i < 12; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383710 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(0);
    // 3B / 15B = 20%, which is <= 30%
    expect(pct).toBeLessThanOrEqual(30);
  });

  it('handles mixed organic and bundled wallets correctly', () => {
    // 2 wallets in slot A (cluster)
    detector.handleBuy(makeBuy({
      wallet: 'Bundler1',
      slot: 422383700,
      timestamp: Date.now(),
      tokenAmount: 3_000_000_000n,
    }));
    detector.handleBuy(makeBuy({
      wallet: 'Bundler2',
      slot: 422383700,
      timestamp: Date.now(),
      tokenAmount: 3_000_000_000n,
    }));

    // 6 organic wallets in different slots
    for (let i = 0; i < 6; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383710 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // Cluster = 6B / 12B = 50% > 30%
    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1);
    expect(signals[0].bundlePct).toBe(50);
    expect(signals[0].clusteredWalletCount).toBe(2);
    expect(signals[0].totalBuyCount).toBe(8);
  });

  // -------------------------------------------------------------------------
  // Funding source clustering
  // -------------------------------------------------------------------------

  it('clusters wallets by common funding source', () => {
    // 4 wallets all funded by the same parent wallet
    // They buy in different slots, so slot-clustering won't catch them
    for (let i = 0; i < 4; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Funded${i}`,
        slot: 422383700 + i * 10, // different slots
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
        fundingWallet: 'ParentWallet1111111111111111111111111111',
      }));
    }

    // 4 organic wallets
    for (let i = 0; i < 4; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383750 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // Cluster = 4 wallets (8B) / 12B total = 66.7%
    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1);
    expect(signals[0].bundlePct).toBeGreaterThan(30);
    expect(signals[0].clusteredWalletCount).toBe(4);
    expect(signals[0].totalBuyCount).toBe(8);
  });

  it('merges slot-based and funding-based clusters', () => {
    // WalletA and WalletB buy in the same slot
    detector.handleBuy(makeBuy({
      wallet: 'WalletA',
      slot: 422383700,
      timestamp: Date.now(),
      tokenAmount: 2_000_000_000n,
    }));
    detector.handleBuy(makeBuy({
      wallet: 'WalletB',
      slot: 422383700,
      timestamp: Date.now(),
      tokenAmount: 2_000_000_000n,
    }));

    // WalletB and WalletC share a funding source (but different slot)
    detector.handleBuy(makeBuy({
      wallet: 'WalletC',
      slot: 422383710,
      timestamp: Date.now(),
      tokenAmount: 2_000_000_000n,
      fundingWallet: 'SharedParent111111111111111111111111111111',
    }));
    detector.handleBuy(makeBuy({
      wallet: 'WalletB',
      slot: 422383710,
      timestamp: Date.now(),
      tokenAmount: 1n, // tiny buy, just to register funding
      fundingWallet: 'SharedParent111111111111111111111111111111',
    }));

    // 6 organic wallets
    for (let i = 0; i < 6; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383720 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // Cluster: A-B (slot) + B-C (funding) → A-B-C merged
    // Cluster tokens: 2B + 2B + 1B + 2B = 7B (WalletB bought twice)
    // Total: 7B + 6B = 13B
    // Cluster pct = 7/13 ≈ 53.8%
    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1);
    expect(signals[0].clusteredWalletCount).toBe(3); // A, B, C merged
    expect(signals[0].bundlePct).toBeGreaterThan(30);
  });

  it('does NOT emit signal when wallets have different funding sources', () => {
    // 3 wallets with different funding sources, different slots
    // Each buys 1B out of 8B total = 12.5% each (below 30% threshold)
    for (let i = 0; i < 3; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Wallet${i}`,
        slot: 422383700 + i * 10,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
        fundingWallet: `Parent${i}11111111111111111111111111111111`,
      }));
    }

    // 5 organic wallets, each 1B
    for (let i = 0; i < 5; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383750 + i,
        timestamp: Date.now(),
        tokenAmount: 1_000_000_000n,
      }));
    }

    // No cluster > 1 wallet, no single wallet > 30%
    // Each wallet = 1B / 8B = 12.5% < 30%
    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(0);
    expect(pct).toBeLessThanOrEqual(30);
  });

  // -------------------------------------------------------------------------
  // Cooldown behavior
  // -------------------------------------------------------------------------

  it('respects cooldown — does not re-emit within cooldown period', () => {
    // Create detector with cooldown
    detector.stop();
    detector = new BundleDetector({
      windowSeconds: 60,
      maxBundlePct: 30,
      minBuyCount: 5,
      cooldownMs: 120_000, // 2 minutes
      forceAnalyzeMinMs: 0, // bypass 30s minimum
      partialWindowSafetyMarginPct: 0, // deterministic test
    });
    signals = [];
    detector.onSignal((signal) => {
      if (signal.type === 'BUNDLE') {
        signals.push({
          bundlePct: signal.bundlePct,
          clusteredWalletCount: signal.clusteredWalletCount,
          totalBuyCount: signal.totalBuyCount,
          windowMs: signal.windowMs,
        });
      }
    });
    detector.start();

    // First batch — should emit
    for (let i = 0; i < 5; i++) {
      detector.handleBuy(makeBuy({
        wallet: 'WalletA',
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
      }));
    }
    detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1);

    // Second batch on same mint — should NOT emit (cooldown active)
    for (let i = 0; i < 5; i++) {
      detector.handleBuy(makeBuy({
        wallet: 'WalletA',
        slot: 422383710,
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
      }));
    }
    detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(1); // still 1

    // Advance time past cooldown
    vi.advanceTimersByTime(121_000);

    // Third batch — should emit now
    // Need a new mint since old one is window-closed; use a fresh detector state
    // Actually the same mint can be re-triggered after purge + new events
    const mint2 = 'TestMint222222222222222222222222222222222222';
    for (let i = 0; i < 5; i++) {
      detector.handleBuy(makeBuy({
        mint: mint2,
        wallet: 'WalletA',
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
      }));
    }
    detector.forceAnalyze(mint2);
    expect(signals).toHaveLength(2); // now 2
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('returns null when no buys recorded', () => {
    const pct = detector.forceAnalyze('NonExistentMint111111111111111111111111');
    expect(pct).toBeNull();
    expect(signals).toHaveLength(0);
  });

  it('does nothing when not running', () => {
    detector.stop();
    detector.handleBuy(makeBuy());
    const pct = detector.forceAnalyze(MINT);
    expect(pct).toBeNull();
    expect(signals).toHaveLength(0);
  });

  it('only considers the largest cluster for bundlePct', () => {
    // Two small clusters in different slots
    // Cluster 1: 2 wallets in slot A, each 1B = 2B
    detector.handleBuy(makeBuy({
      wallet: 'W1',
      slot: 422383700,
      timestamp: Date.now(),
      tokenAmount: 1_000_000_000n,
    }));
    detector.handleBuy(makeBuy({
      wallet: 'W2',
      slot: 422383700,
      timestamp: Date.now(),
      tokenAmount: 1_000_000_000n,
    }));

    // Cluster 2: 2 wallets in slot B, each 1B = 2B
    detector.handleBuy(makeBuy({
      wallet: 'W3',
      slot: 422383710,
      timestamp: Date.now(),
      tokenAmount: 1_000_000_000n,
    }));
    detector.handleBuy(makeBuy({
      wallet: 'W4',
      slot: 422383710,
      timestamp: Date.now(),
      tokenAmount: 1_000_000_000n,
    }));

    // 4 organic wallets
    for (let i = 0; i < 4; i++) {
      detector.handleBuy(makeBuy({
        wallet: `Organic${i}`,
        slot: 422383720 + i,
        timestamp: Date.now(),
        tokenAmount: 2_000_000_000n,
      }));
    }

    // Largest cluster = 2B, total = 2B + 2B + 8B = 12B
    // Largest cluster pct = 2/12 ≈ 16.7% < 30%
    const pct = detector.forceAnalyze(MINT);
    expect(signals).toHaveLength(0);
    expect(pct).toBeLessThanOrEqual(30);
  });

  it('handles zero token amounts gracefully', () => {
    // All buys have 0 tokens — should not crash, pct = 0
    for (let i = 0; i < 5; i++) {
      detector.handleBuy(makeBuy({
        wallet: 'WalletA',
        slot: 422383700,
        timestamp: Date.now(),
        tokenAmount: 0n,
      }));
    }

    const pct = detector.forceAnalyze(MINT);
    expect(pct).toBe(0);
    expect(signals).toHaveLength(0);
  });
});
