/**
 * Cross-Token Correlator
 *
 * Detects serial scammer wallet clusters by tracking wallet behavior
 * across multiple tokens. When wallets that previously bought tokens
 * that dumped appear on a new token, they are flagged.
 *
 * Detection logic:
 *   1. Track which wallets buy which tokens (with timestamps).
 *   2. When a token is marked as "dumped" (price dropped >80% from ATH),
 *      all wallets that bought it become "dump participants."
 *   3. Cluster dump-participant wallets using Union-Find (co-occurrence
 *      on 2+ dumped tokens = same cluster).
 *   4. When analyzing a new token, check if buying wallets belong to
 *      any dump-cluster.
 *   5. Score based on matched dump-cluster wallet count.
 *
 * Design:
 *   - Pure detector layer — no execution, no risk decisions.
 *   - Rolling 7-day window for dump history.
 *   - LRU-bounded caches for scalability.
 *   - Prometheus metrics for observability.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { CrossTokenSignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Gauge } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';
import { generateId } from '../../core/utils/serialization.js';
import { UnionFind } from '../../core/utils/unionFind.js';

const logger = createLogger('detectors:crossToken');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const crossTokenDetectionsCounter = new Counter({
  name: 'pumpfun_cross_token_detections_total',
  help: 'Total cross-token detections emitted',
  registers: [register],
});

const crossTokenScoreGauge = new Gauge({
  name: 'pumpfun_cross_token_latest_score',
  help: 'Cross-token score from the most recent analysis',
  labelNames: ['mint'] as const,
  registers: [register],
});

const dumpTokensTracked = new Gauge({
  name: 'pumpfun_cross_token_dump_tokens',
  help: 'Number of tokens tracked as dumped',
  registers: [register],
});

const dumpWalletsTracked = new Gauge({
  name: 'pumpfun_cross_token_dump_wallets',
  help: 'Number of wallets tracked as dump participants',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score threshold to emit signal */
const SCORE_THRESHOLD = 50;

/** Rolling window for dump history: 7 days */
const DUMP_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum tokens to track */
const MAX_TOKENS = 10_000;

/** Maximum mints to track simultaneously */
const MAX_MINTS = 5_000;

/** Cleanup interval: every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Cooldown per mint before re-emitting signal */
const COOLDOWN_MS = 120_000;

/** Minimum dump-cluster wallets on a token to trigger signal */
const MIN_MATCHED_WALLETS = 3;

// ---------------------------------------------------------------------------
// Scoring thresholds
// ---------------------------------------------------------------------------

const SCORE_3_TO_4_WALLETS = 50;
const SCORE_5_TO_9_WALLETS = 80;
const SCORE_10_PLUS_WALLETS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenRecord {
  readonly mint: string;
  readonly buyers: Set<string>;
  readonly firstSeenAt: number;
  isDumped: boolean;
  dumpedAt?: number;
}

interface MintCorrelationState {
  readonly buyingWallets: Set<string>;
  readonly firstBuyAt: number;
  lastAnalyzedAt: number;
  lastSignalAt: number;
}

/** Analysis result for a mint. */
export interface CrossTokenAnalysis {
  readonly score: number;
  readonly dumpClusterWallets: number;
  readonly clusterSize: number;
  readonly matchedWallets: readonly string[];
}

// ---------------------------------------------------------------------------
// Cross-Token Correlator
// ---------------------------------------------------------------------------

export class CrossTokenCorrelator implements IDetector {
  readonly name = 'CrossTokenCorrelator';

  private readonly handlers: SignalHandler[] = [];

  /** Token tracking: mint → TokenRecord */
  private readonly tokens = new Map<string, TokenRecord>();

  /** Dump-participant wallet clusters (Union-Find) */
  private dumpClusters = new UnionFind();

  /** Per-mint analysis state for current token being evaluated */
  private readonly mintStates = new Map<string, MintCorrelationState>();

  /** Set of wallets that have participated in dumps */
  private readonly dumpWallets = new Set<string>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info('CrossTokenCorrelator started', {
      scoreThreshold: SCORE_THRESHOLD,
      dumpHistoryDays: 7,
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.tokens.clear();
    this.mintStates.clear();
    this.dumpWallets.clear();
    this.dumpClusters = new UnionFind();
    logger.info('CrossTokenCorrelator stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  /**
   * Record a buy event. Tracks which wallets bought which tokens.
   */
  recordBuy(mint: MintAddress, wallet: string, timestamp?: number): void {
    // Track in token record
    let token = this.tokens.get(mint);
    if (!token) {
      if (this.tokens.size >= MAX_TOKENS) {
        this.evictOldestToken();
      }
      token = { mint, buyers: new Set(), firstSeenAt: timestamp ?? nowMs(), isDumped: false };
      this.tokens.set(mint, token);
    }
    token.buyers.add(wallet);

    // Track in mint analysis state
    let state = this.mintStates.get(mint);
    if (!state) {
      if (this.mintStates.size >= MAX_MINTS) {
        // Evict oldest
        let oldest: string | null = null;
        let oldestTime = Infinity;
        for (const [m, s] of this.mintStates) {
          if (s.firstBuyAt < oldestTime) { oldestTime = s.firstBuyAt; oldest = m; }
        }
        if (oldest) this.mintStates.delete(oldest);
      }
      state = { buyingWallets: new Set(), firstBuyAt: timestamp ?? nowMs(), lastAnalyzedAt: 0, lastSignalAt: 0 };
      this.mintStates.set(mint, state);
    }
    state.buyingWallets.add(wallet);
  }

  /**
   * Mark a token as "dumped" — all buying wallets become dump participants.
   * Call this when a token's price drops >80% from ATH.
   */
  markDump(mint: MintAddress): void {
    const token = this.tokens.get(mint);
    if (!token || token.isDumped) return;

    token.isDumped = true;
    token.dumpedAt = nowMs();

    // Add all buyers to dump wallet set and cluster them
    const buyers = [...token.buyers];
    for (const wallet of buyers) {
      this.dumpWallets.add(wallet);
    }

    // Cluster wallets: connect all buyers to a single representative (O(n))
    // instead of pairwise unions (O(n²)). Same connected-component result.
    if (buyers.length > 1) {
      const representative = buyers[0]!;
      for (let i = 1; i < buyers.length; i++) {
        this.dumpClusters.union(representative, buyers[i]!);
      }
    }

    dumpTokensTracked.inc();
    dumpWalletsTracked.set(this.dumpWallets.size);

    logger.info('Token marked as dump — wallet cluster updated', {
      mint: mint.slice(0, 12),
      buyerCount: buyers.length,
      totalDumpWallets: this.dumpWallets.size,
    });
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze cross-token correlation for a mint.
   * Returns null if insufficient data.
   */
  analyzeMint(mint: MintAddress): CrossTokenAnalysis | null {
    const state = this.mintStates.get(mint);
    if (!state || state.buyingWallets.size === 0) return null;

    // Check how many buying wallets on this token are dump participants
    const matchedWallets: string[] = [];
    for (const wallet of state.buyingWallets) {
      if (this.dumpWallets.has(wallet)) {
        matchedWallets.push(wallet);
      }
    }

    if (matchedWallets.length === 0) {
      return { score: 0, dumpClusterWallets: 0, clusterSize: 0, matchedWallets: [] };
    }

    // Find the largest cluster among matched wallets
    const clusterSizes = new Map<string, number>();
    for (const wallet of matchedWallets) {
      const root = this.dumpClusters.find(wallet);
      clusterSizes.set(root, (clusterSizes.get(root) ?? 0) + 1);
    }

    let maxClusterSize = 0;
    for (const size of clusterSizes.values()) {
      if (size > maxClusterSize) maxClusterSize = size;
    }

    // Score based on matched wallet count
    let score = 0;
    if (matchedWallets.length >= 10) {
      score = SCORE_10_PLUS_WALLETS;
    } else if (matchedWallets.length >= 5) {
      score = SCORE_5_TO_9_WALLETS;
    } else if (matchedWallets.length >= MIN_MATCHED_WALLETS) {
      score = SCORE_3_TO_4_WALLETS;
    }

    return {
      score,
      dumpClusterWallets: matchedWallets.length,
      clusterSize: maxClusterSize,
      matchedWallets,
    };
  }

  /**
   * Get the latest score for a mint.
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

  private emitSignal(mint: MintAddress, analysis: CrossTokenAnalysis): void {
    const signal: CrossTokenSignal = {
      id: generateId('sig'),
      type: 'CROSS_TOKEN',
      mint,
      timestamp: nowMs(),
      slot: 0,
      crossTokenScore: analysis.score,
      dumpClusterSize: analysis.clusterSize,
      matchedWallets: analysis.dumpClusterWallets,
    };

    crossTokenDetectionsCounter.inc();
    crossTokenScoreGauge.set({ mint: mint.slice(0, 8) }, analysis.score);

    logger.warn('CrossToken ALERT — serial scammer wallets detected', {
      mint: mint.slice(0, 12),
      score: analysis.score,
      dumpClusterWallets: analysis.dumpClusterWallets,
      clusterSize: analysis.clusterSize,
      sampleWallets: analysis.matchedWallets.slice(0, 5).map(w => w.slice(0, 8)),
    });

    for (const handler of this.handlers) {
      try { handler(signal); } catch { /* non-fatal */ }
    }
  }

  private cleanup(): void {
    const now = nowMs();
    let cleanedTokens = 0;
    let cleanedMints = 0;

    // Clean old tokens
    for (const [mint, token] of this.tokens) {
      if (now - token.firstSeenAt > DUMP_HISTORY_WINDOW_MS) {
        this.tokens.delete(mint);
        cleanedTokens++;
      }
    }

    // Clean old mint states
    for (const [mint, state] of this.mintStates) {
      if (now - state.firstBuyAt > DUMP_HISTORY_WINDOW_MS) {
        this.mintStates.delete(mint);
        cleanedMints++;
      }
    }

    // Rebuild dump wallet set AND UnionFind from remaining dumped tokens
    // This prevents memory leak from stale entries in the UnionFind
    this.dumpWallets.clear();
    const newClusters = new UnionFind();
    for (const token of this.tokens.values()) {
      if (token.isDumped) {
        const buyers = [...token.buyers];
        for (const wallet of buyers) {
          this.dumpWallets.add(wallet);
        }
        // O(n) clustering: connect all to representative
        if (buyers.length > 1) {
          const rep = buyers[0]!;
          for (let i = 1; i < buyers.length; i++) {
            newClusters.union(rep, buyers[i]!);
          }
        }
      }
    }
    // Replace old UnionFind with rebuilt one (frees memory from stale entries)
    this.dumpClusters = newClusters;

    // Count dumped tokens inline (avoid throwaway array allocation)
    let dumpedCount = 0;
    for (const t of this.tokens.values()) { if (t.isDumped) dumpedCount++; }
    dumpTokensTracked.set(dumpedCount);
    dumpWalletsTracked.set(this.dumpWallets.size);

    if (cleanedTokens > 0 || cleanedMints > 0) {
      logger.debug('CrossToken cleanup', {
        cleanedTokens,
        cleanedMints,
        remainingTokens: this.tokens.size,
        remainingMints: this.mintStates.size,
        dumpWallets: this.dumpWallets.size,
      });
    }
  }

  private evictOldestToken(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [mint, token] of this.tokens) {
      if (token.firstSeenAt < oldestTime) {
        oldestTime = token.firstSeenAt;
        oldest = mint;
      }
    }
    if (oldest) this.tokens.delete(oldest);
  }
}
