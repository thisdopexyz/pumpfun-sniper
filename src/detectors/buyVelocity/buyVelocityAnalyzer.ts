/**
 * Buy Velocity Analyzer
 *
 * Detects bot swarms and coordinated mass-buy schemes by analyzing the
 * velocity (wallets per time window) of buy events on a token.
 *
 * Dev multi-wallet schemes typically manifest as:
 *   - 30-200+ wallets buying within the first 60 seconds
 *   - Extremely regular intervals between buys (low std deviation)
 *   - Burst patterns: sudden spikes of 10+ buys in <1 second
 *
 * Detection logic:
 *   1. Track all buy events (wallet + timestamp) per mint.
 *   2. Calculate unique wallet count across multiple time windows: 10s, 30s, 60s, 120s.
 *   3. Calculate inter-buy interval statistics (avg, std dev).
 *   4. Score 0-100 based on velocity thresholds and interval regularity.
 *   5. Emit BUY_VELOCITY signal when score > 65.
 *
 * Design:
 *   - Pure detector layer — no execution, no risk decisions.
 *   - Per-mint tracking with 5-minute TTL cleanup.
 *   - Prometheus metrics for observability.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { BuyVelocitySignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Gauge } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';
import { generateId } from '../../core/utils/serialization.js';

const logger = createLogger('detectors:buyVelocity');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const velocityDetectionsCounter = new Counter({
  name: 'pumpfun_buy_velocity_detections_total',
  help: 'Total buy velocity detections emitted',
  registers: [register],
});

const velocityScoreGauge = new Gauge({
  name: 'pumpfun_buy_velocity_latest_score',
  help: 'Buy velocity score from the most recent analysis',
  labelNames: ['mint'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score threshold to emit signal */
const SCORE_THRESHOLD = 65;

/** Time windows for velocity calculation (seconds) */
const WINDOWS = [10, 30, 60, 120] as const;

/** Maximum buy records per mint */
const MAX_BUYS_PER_MINT = 1000;

/** Maximum mints to track simultaneously */
const MAX_MINTS = 1000;

/** Cleanup interval: remove stale mint data every 2 minutes */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

/** Mint data TTL: 5 minutes */
const MINT_TTL_MS = 5 * 60 * 1000;

/** Cooldown per mint before re-emitting signal */
const COOLDOWN_MS = 120_000;

// ---------------------------------------------------------------------------
// Scoring thresholds — MULTI-SIGNAL (CV + Entropy + Velocity + Amount Variance)
// ---------------------------------------------------------------------------
// Modern bots randomize intervals to bypass simple std dev detection.
// We use 4 independent signals that are hard to manipulate simultaneously:
//   40% Interval CV (stdDev / mean) — normalized regularity
//   30% Interval Entropy — how "random" the distribution is
//   20% Velocity multiplier — only boosts, doesn't block alone
//   10% Buy Amount Variance — bots buy uniform amounts
//
// Token age handling:
//   < 15s → skip (too chaotic)
//   15-30s → half confidence
//   > 30s → full confidence

/** Skip entirely for tokens younger than this */
const TOKEN_AGE_SKIP_MS = 15_000;

/** Half confidence for tokens between SKIP and this */
const TOKEN_AGE_HALF_MS = 30_000;

/** Minimum buys for meaningful analysis */
const MIN_BUYS_FOR_ANALYSIS = 8;

/** CV thresholds (stdDev / mean) — lower = more bot-like */
const CV_BOT = 0.15;      // CV < 15% = definitely bot
const CV_SUS = 0.30;       // CV < 30% = suspicious
const CV_MILD = 0.50;      // CV < 50% = mildly suspicious

/** Entropy thresholds — lower = more bot-like (less random) */
const ENTROPY_BOT = 2.0;   // bits, < 2 = bot
const ENTROPY_SUS = 3.0;   // < 3 = suspicious
const ENTROPY_MILD = 4.0;  // < 4 = mild

/** Velocity multiplier thresholds (wallets per second) */
const VEL_LOW = 1.0;       // < 1 wps → multiplier 0.5 (low risk)
const VEL_MED = 3.0;       // >= 3 wps → multiplier 1.3 (boost)
const VEL_HIGH = 5.0;      // >= 5 wps → multiplier 1.5 (strong boost)

/** Buy amount CV thresholds — lower = more uniform (bot-like) */
const AMT_CV_BOT = 0.10;   // < 10% = definitely bot (uniform amounts)
const AMT_CV_SUS = 0.30;   // < 30% = suspicious

/** SCORE WEIGHTS */
const W_INTERVAL_CV = 0.40;
const W_ENTROPY = 0.30;
const W_VELOCITY = 0.20;
const W_AMOUNT_VAR = 0.10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BuyRecord {
  readonly wallet: string;
  readonly timestamp: number;
  readonly solAmount: number;
}

interface MintVelocityState {
  readonly buys: BuyRecord[];
  readonly firstBuyAt: number;
  lastAnalyzedAt: number;
  lastSignalAt: number;
  /** Whether buys array needs re-sort (set false after sort, true on insert) */
  needsSort: boolean;
  /** Cached unique wallet set (updated incrementally) */
  readonly uniqueWallets: Set<string>;
}

/** Analysis result for a mint. */
export interface VelocityAnalysis {
  readonly score: number;
  readonly wallets10s: number;
  readonly wallets30s: number;
  readonly wallets60s: number;
  readonly wallets120s: number;
  readonly avgIntervalMs: number;
  readonly stdDevMs: number;
  readonly totalBuys: number;
  readonly uniqueWallets: number;
}

// ---------------------------------------------------------------------------
// Buy Velocity Analyzer
// ---------------------------------------------------------------------------

export class BuyVelocityAnalyzer implements IDetector {
  readonly name = 'BuyVelocityAnalyzer';

  private readonly handlers: SignalHandler[] = [];

  /** Per-mint tracking state */
  private readonly mintStates = new Map<string, MintVelocityState>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info('BuyVelocityAnalyzer started', {
      scoreThreshold: SCORE_THRESHOLD,
      windows: WINDOWS,
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.mintStates.clear();
    logger.info('BuyVelocityAnalyzer stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  /**
   * Record a buy event.
   * Call this for every buy event on every mint.
   */
  recordBuy(mint: MintAddress, wallet: string, timestamp?: number, solAmount?: number): void {
    let state = this.mintStates.get(mint);
    if (!state) {
      if (this.mintStates.size >= MAX_MINTS) {
        const oldest = this.findOldestMint();
        if (oldest) this.mintStates.delete(oldest);
      }
      state = { buys: [], firstBuyAt: timestamp ?? nowMs(), lastAnalyzedAt: 0, lastSignalAt: 0, needsSort: false, uniqueWallets: new Set() };
      this.mintStates.set(mint, state);
    }

    if (state.buys.length >= MAX_BUYS_PER_MINT) return;

    state.buys.push({ wallet, timestamp: timestamp ?? nowMs(), solAmount: solAmount ?? 0 });
    state.needsSort = true;
    state.uniqueWallets.add(wallet);
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze buy velocity for a mint.
   * Returns null if insufficient data.
   */
  analyzeMint(mint: MintAddress): VelocityAnalysis | null {
    const state = this.mintStates.get(mint);
    if (!state || state.buys.length < 3) return null;

    const now = nowMs();
    const buys = state.buys;

    // Count unique wallets per window
    const windowCounts = new Map<number, Set<string>>();
    for (const windowSec of WINDOWS) {
      const windowMs = windowSec * 1000;
      const cutoff = now - windowMs;
      const wallets = new Set<string>();
      for (const buy of buys) {
        if (buy.timestamp >= cutoff) {
          wallets.add(buy.wallet);
        }
      }
      windowCounts.set(windowSec, wallets);
    }

    const wallets10s = windowCounts.get(10)?.size ?? 0;
    const wallets30s = windowCounts.get(30)?.size ?? 0;
    const wallets60s = windowCounts.get(60)?.size ?? 0;
    const wallets120s = windowCounts.get(120)?.size ?? 0;

    // Calculate inter-buy intervals
    if (state.needsSort) {
      buys.sort((a, b) => a.timestamp - b.timestamp);
      state.needsSort = false;
    }
    const intervals: number[] = [];
    for (let i = 1; i < buys.length; i++) {
      intervals.push(buys[i]!.timestamp - buys[i - 1]!.timestamp);
    }

    const avgIntervalMs = intervals.length > 0
      ? intervals.reduce((s, v) => s + v, 0) / intervals.length
      : 0;

    const variance = intervals.length > 1
      ? intervals.reduce((s, v) => s + (v - avgIntervalMs) ** 2, 0) / (intervals.length - 1)
      : 0;
    const stdDevMs = Math.sqrt(variance);

    // Buy amounts for amount variance analysis
    const amounts = buys.map(b => b.solAmount).filter(a => a > 0);
    const avgAmount = amounts.length > 0
      ? amounts.reduce((s, v) => s + v, 0) / amounts.length
      : 0;
    const amountVariance = amounts.length > 1
      ? amounts.reduce((s, v) => s + (v - avgAmount) ** 2, 0) / (amounts.length - 1)
      : 0;
    const amountStdDev = Math.sqrt(amountVariance);

    // Unique wallet count (cached incrementally)
    const uniqueWallets = state.uniqueWallets.size;

    // ── TOKEN-AGE CHECK ──
    const tokenAgeMs = now - state.firstBuyAt;
    if (tokenAgeMs < TOKEN_AGE_SKIP_MS) {
      return {
        score: 0, // Too early to judge
        wallets10s, wallets30s, wallets60s, wallets120s,
        avgIntervalMs, stdDevMs,
        totalBuys: buys.length, uniqueWallets,
      };
    }
    // Half confidence for 15-30s tokens
    const ageConfidence = tokenAgeMs < TOKEN_AGE_HALF_MS ? 0.5 : 1.0;

    // ── SIGNAL 1: INTERVAL CV (Coefficient of Variation) — 40% weight ──
    // CV = stdDev / mean — normalized regularity, works across different speeds
    // Bot 500ms±7ms: CV=1.4% | Human 600ms±520ms: CV=86%
    let cvScore = 0;
    if (intervals.length >= MIN_BUYS_FOR_ANALYSIS && avgIntervalMs > 0) {
      const cv = stdDevMs / avgIntervalMs;
      if (cv < CV_BOT) {
        cvScore = 100;
      } else if (cv < CV_SUS) {
        cvScore = 80;
      } else if (cv < CV_MILD) {
        cvScore = 50;
      } else {
        cvScore = 10;
      }
    }

    // ── SIGNAL 2: INTERVAL ENTROPY — 30% weight ──
    // Shannon entropy of interval distribution (bucketed into 50ms bins)
    // Bot: low entropy (intervals cluster in narrow range)
    // Human: high entropy (intervals spread across wide range)
    let entropyScore = 0;
    if (intervals.length >= MIN_BUYS_FOR_ANALYSIS) {
      const bins = new Map<number, number>();
      const binSize = 50; // 50ms bins
      for (const interval of intervals) {
        const bin = Math.floor(interval / binSize);
        bins.set(bin, (bins.get(bin) ?? 0) + 1);
      }
      // Shannon entropy
      let entropy = 0;
      const total = intervals.length;
      for (const count of bins.values()) {
        const p = count / total;
        if (p > 0) entropy -= p * Math.log2(p);
      }
      // Normalize: max entropy = log2(numBins), typical range 0-6 bits
      if (entropy < ENTROPY_BOT) {
        entropyScore = 100;
      } else if (entropy < ENTROPY_SUS) {
        entropyScore = 80;
      } else if (entropy < ENTROPY_MILD) {
        entropyScore = 50;
      } else {
        entropyScore = 10;
      }
    }

    // ── SIGNAL 3: VELOCITY MULTIPLIER — 20% weight ──
    // Velocity as multiplier, not primary score
    // Low velocity (< 1 wps) → reduce score (less suspicious)
    // High velocity (> 3 wps) → boost score (more suspicious)
    const maxWps = Math.max(
      wallets10s / 10, wallets30s / 30, wallets60s / 60, wallets120s / 120
    );
    let velMultiplier: number;
    if (maxWps < VEL_LOW) {
      velMultiplier = 0.5;  // Low velocity = less suspicious
    } else if (maxWps >= VEL_HIGH) {
      velMultiplier = 1.5;  // Very high velocity = more suspicious
    } else if (maxWps >= VEL_MED) {
      velMultiplier = 1.3;
    } else {
      velMultiplier = 1.0;  // Normal
    }
    // Convert multiplier to 0-100 score for weighted calc
    const velScore = Math.min(100, Math.round((velMultiplier - 0.5) / 1.0 * 100));

    // ── SIGNAL 4: BUY AMOUNT VARIANCE — 10% weight ──
    // Bots buy uniform amounts → low CV
    // Humans buy varied amounts → high CV
    let amtScore = 0;
    if (amounts.length >= MIN_BUYS_FOR_ANALYSIS && avgAmount > 0) {
      const amtCv = amountStdDev / avgAmount;
      if (amtCv < AMT_CV_BOT) {
        amtScore = 100; // Very uniform = bot
      } else if (amtCv < AMT_CV_SUS) {
        amtScore = 70;
      } else {
        amtScore = 10; // Varied = organic
      }
    }

    // ── COMBINED SCORE ──
    const rawScore = Math.round(
      W_INTERVAL_CV * cvScore +
      W_ENTROPY * entropyScore +
      W_VELOCITY * velScore +
      W_AMOUNT_VAR * amtScore
    );
    // Apply age confidence (half for 15-30s tokens)
    const score = Math.min(100, Math.round(rawScore * ageConfidence));

    return {
      score: Math.min(100, score),
      wallets10s,
      wallets30s,
      wallets60s,
      wallets120s,
      avgIntervalMs,
      stdDevMs,
      totalBuys: buys.length,
      uniqueWallets,
    };
  }

  /**
   * Get the latest score for a mint.
   * Returns null if no data.
   */
  getLatestScore(mint: MintAddress): number | null {
    return this.analyzeMint(mint)?.score ?? null;
  }

  /**
   * Force analysis and return score. Used by data provider at entry time.
   * Also emits signal if threshold exceeded.
   */
  forceAnalyze(mint: MintAddress): number | null {
    const result = this.analyzeMint(mint);
    if (!result) return null;

    const state = this.mintStates.get(mint);
    if (state) state.lastAnalyzedAt = nowMs();

    // Emit signal if threshold exceeded and cooldown passed
    if (result.score >= SCORE_THRESHOLD) {
      const canEmit = !state || (nowMs() - state.lastSignalAt > COOLDOWN_MS);
      if (canEmit) {
        this.emitSignal(mint, result);
        if (state) state.lastSignalAt = nowMs();
      }
    }

    return result.score;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private emitSignal(mint: MintAddress, analysis: VelocityAnalysis): void {
    const signal: BuyVelocitySignal = {
      id: generateId('sig'),
      type: 'BUY_VELOCITY',
      mint,
      timestamp: nowMs(),
      slot: 0,
      velocityScore: analysis.score,
      walletsInWindow: Math.max(analysis.wallets10s, analysis.wallets30s, analysis.wallets60s),
      windowSeconds: analysis.wallets10s >= VEL_HIGH * 10 ? 10
        : analysis.wallets60s >= VEL_HIGH * 60 ? 60 : 120,
      avgIntervalMs: analysis.avgIntervalMs,
    };

    velocityDetectionsCounter.inc();
    velocityScoreGauge.set({ mint: mint.slice(0, 8) }, analysis.score);

    logger.warn('BuyVelocity ALERT — bot swarm / coordinated buy detected', {
      mint: mint.slice(0, 12),
      score: analysis.score,
      wallets10s: analysis.wallets10s,
      wallets30s: analysis.wallets30s,
      wallets60s: analysis.wallets60s,
      wallets120s: analysis.wallets120s,
      avgIntervalMs: analysis.avgIntervalMs.toFixed(1),
      stdDevMs: analysis.stdDevMs.toFixed(1),
    });

    for (const handler of this.handlers) {
      try { handler(signal); } catch { /* non-fatal */ }
    }
  }

  private cleanup(): void {
    const now = nowMs();
    let cleaned = 0;
    for (const [mint, state] of this.mintStates) {
      if (now - state.firstBuyAt > MINT_TTL_MS) {
        this.mintStates.delete(mint);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug('BuyVelocity cleanup', { cleaned, remaining: this.mintStates.size });
    }
  }

  private findOldestMint(): string | null {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [mint, state] of this.mintStates) {
      if (state.firstBuyAt < oldestTime) {
        oldestTime = state.firstBuyAt;
        oldest = mint;
      }
    }
    return oldest;
  }
}
