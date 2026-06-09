/**
 * Wallet Age Detector
 *
 * Detects tokens where the majority of buying wallets are brand new —
 * a strong indicator of dev multi-wallet schemes (200-300 fresh wallets
 * buying to fake organic activity).
 *
 * Detection logic:
 *   1. For each buy event, record the buying wallet.
 *   2. Resolve wallet age via getSignaturesForAddress (first-ever tx).
 *   3. Cache wallet ages (wallets don't get younger).
 *   4. Calculate weighted score based on age distribution:
 *      - < 1 hour: weight 3x (critical — brand new)
 *      - < 24 hours: weight 2x (suspicious)
 *      - < 7 days: weight 1x (mild)
 *      - > 7 days: weight 0x (normal/trusted)
 *   5. Score = (weighted_new / total) * 100
 *   6. Emit WALLET_AGE signal when score > threshold (default 60).
 *
 * Design:
 *   - Pure detector layer — no execution, no risk decisions.
 *   - LRU-bounded wallet age cache (max 50,000 wallets).
 *   - Per-mint tracking with 10-minute TTL cleanup.
 *   - Prometheus metrics for observability.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { WalletAgeSignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Gauge } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';
import { generateId } from '../../core/utils/serialization.js';
import { LRUCache } from '../../core/utils/lruCache.js';
import { PublicKey } from '@solana/web3.js';
import type { RpcPool } from '../../infra/rpcPool.js';


const logger = createLogger('detectors:walletAge');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const walletAgeDetectionsCounter = new Counter({
  name: 'pumpfun_wallet_age_detections_total',
  help: 'Total wallet age detections emitted',
  registers: [register],
});

const walletAgeScoreGauge = new Gauge({
  name: 'pumpfun_wallet_age_latest_score',
  help: 'Wallet age score from the most recent analysis',
  labelNames: ['mint'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score threshold to emit signal */
const SCORE_THRESHOLD = 60;

/** Maximum wallets to track per mint */
const MAX_WALLETS_PER_MINT = 500;

/** Maximum mints to track simultaneously */
const MAX_MINTS = 1000;

/** Cleanup interval: remove stale mint data every 2 minutes */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

/** Mint data TTL: 10 minutes */
const MINT_TTL_MS = 10 * 60 * 1000;

/** Wallet age cache: max 50k wallets */
const WALLET_CACHE_MAX = 50_000;

/** Age thresholds in milliseconds */
const AGE_1_HOUR_MS = 60 * 60 * 1000;
const AGE_24_HOURS_MS = 24 * 60 * 60 * 1000;
const AGE_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000;



// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the wallet age detector. */
export interface WalletAgeDetectorConfig {
  /** Score threshold to emit signal. Default: 60. */
  readonly scoreThreshold?: number;
  /** Cooldown per mint in ms before re-emitting. Default: 120_000 (2 min). */
  readonly cooldownMs?: number;
}

interface WalletRecord {
  readonly wallet: string;
  readonly firstSeenAt: number;
}

interface MintAgeState {
  readonly wallets: Map<string, WalletRecord>;
  readonly ages: Map<string, number>;
  readonly firstBuyAt: number;
  lastAnalyzedAt: number;
  lastSignalAt: number;
  creator: string | null;
  creatorAge: number | null;
}

/** Analysis result for a mint. */
export interface WalletAgeAnalysis {
  readonly score: number;
  readonly newWalletCount: number;
  readonly totalWalletCount: number;
  readonly avgAgeHours: number;
  readonly youngestWalletAgeMinutes: number;
  readonly creatorAgeHours: number | null;
  readonly creatorIsNew: boolean;
}

// ---------------------------------------------------------------------------
// Wallet Age Detector
// ---------------------------------------------------------------------------

export class WalletAgeDetector implements IDetector {
  readonly name = 'WalletAgeDetector';

  private readonly config: Required<WalletAgeDetectorConfig>;
  private readonly handlers: SignalHandler[] = [];
  private readonly rpcPool: RpcPool;

  /** Per-mint tracking state */
  private readonly mintStates = new Map<string, MintAgeState>();

  /** Wallet age cache: wallet address → first transaction timestamp (ms) */
  private readonly walletAgeCache: LRUCache<string, number>;

  /** Rate limiting for wallet age lookups */
  private pendingLookups = 0;
  private lastLookupAt = 0;

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    rpcPool: RpcPool,
    config?: WalletAgeDetectorConfig,
  ) {
    this.rpcPool = rpcPool;
    this.config = {
      scoreThreshold: config?.scoreThreshold ?? SCORE_THRESHOLD,
      cooldownMs: config?.cooldownMs ?? 120_000,
    };
    this.walletAgeCache = new LRUCache<string, number>(WALLET_CACHE_MAX);
  }

  // -------------------------------------------------------------------------
  // IDetector lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info('WalletAgeDetector started', {
      scoreThreshold: this.config.scoreThreshold,
      cacheMax: WALLET_CACHE_MAX,
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.mintStates.clear();
    this.walletAgeCache.clear();
    logger.info('WalletAgeDetector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  /**
   * Set the creator address for a mint. Resolves creator wallet age.
   * Call this when a launch event is detected.
   */
  async setCreator(mint: MintAddress, creator: string): Promise<void> {
    let state = this.mintStates.get(mint);
    if (!state) {
      if (this.mintStates.size >= MAX_MINTS) {
        const oldest = this.findOldestMint();
        if (oldest) this.mintStates.delete(oldest);
      }
      state = { wallets: new Map(), ages: new Map(), firstBuyAt: nowMs(), lastAnalyzedAt: 0, lastSignalAt: 0, creator, creatorAge: null };
      this.mintStates.set(mint, state);
    }
    if (state.creator) return; // Already set
    state.creator = creator;

    // Resolve creator wallet age
    const cached = this.walletAgeCache.get(creator);
    if (cached !== undefined) {
      state.creatorAge = cached;
    } else {
      // Rate-limited RPC for creator
      const now = nowMs();
      if (now - this.lastLookupAt >= 1000 && this.pendingLookups < 1) {
        this.lastLookupAt = now;
        this.pendingLookups++;
        try {
          const age = await this.resolveWalletAge(creator);
          if (age !== null) {
            state.creatorAge = age;
          }
        } finally {
          this.pendingLookups--;
        }
      }
    }
  }

  /**
   * Record a buy event. Resolves wallet age and updates mint tracking.
   * Call this for every buy event on every mint.
   */
  async recordBuy(mint: MintAddress, wallet: string): Promise<void> {
    let state = this.mintStates.get(mint);
    if (!state) {
      if (this.mintStates.size >= MAX_MINTS) {
        // Evict oldest mint
        const oldest = this.findOldestMint();
        if (oldest) this.mintStates.delete(oldest);
      }
      state = { wallets: new Map(), ages: new Map(), firstBuyAt: nowMs(), lastAnalyzedAt: 0, lastSignalAt: 0, creator: null, creatorAge: null };
      this.mintStates.set(mint, state);
    }

    if (state.wallets.has(wallet)) return; // Already tracked
    if (state.wallets.size >= MAX_WALLETS_PER_MINT) return; // Cap reached

    // Cache check first
    const cached = this.walletAgeCache.get(wallet);
    let age: number | null;

    if (cached !== undefined) {
      age = cached;
    } else {
      // Rate-limited RPC: max 1 lookup per second
      const now = nowMs();
      if (now - this.lastLookupAt < 1000) return; // Too fast, skip
      if (this.pendingLookups >= 1) return; // Already 1 pending, skip
      this.lastLookupAt = now;
      this.pendingLookups++;
      try {
        age = await this.resolveWalletAge(wallet);
      } finally {
        this.pendingLookups--;
      }
      if (age === null) return; // RPC failed, skip
    }

    state.wallets.set(wallet, { wallet, firstSeenAt: nowMs() });

    // Store age — null means RPC failed, exclude from scoring
    if (age === null) return; // Don't add wallet with unknown age
    state.ages.set(wallet, age);
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze wallet age distribution for a mint.
   * Returns null if insufficient data.
   */
  analyzeMint(mint: MintAddress): WalletAgeAnalysis | null {
    const state = this.mintStates.get(mint);
    if (!state || state.wallets.size === 0) return null;

    const ages = state.ages;
    if (ages.size === 0) return null;

    const now = nowMs();
    let weightedNew = 0;
    let totalAgeHours = 0;
    let minAgeMinutes = Infinity;
    let newWalletCount = 0;

    for (const [, firstTxTime] of ages) {
      const ageMs = now - firstTxTime;
      const ageHours = ageMs / (60 * 60 * 1000);
      const ageMinutes = ageMs / (60 * 1000);

      totalAgeHours += ageHours;
      if (ageMinutes < minAgeMinutes) minAgeMinutes = ageMinutes;

      let weight = 0;
      if (ageMs < AGE_1_HOUR_MS) {
        weight = 3;
        newWalletCount++;
      } else if (ageMs < AGE_24_HOURS_MS) {
        weight = 2;
        newWalletCount++;
      } else if (ageMs < AGE_7_DAYS_MS) {
        weight = 1;
      }
      // else weight = 0 (trusted wallet)

      weightedNew += weight;
    }

    const totalWalletCount = ages.size;
    // Buyer age score: 0-100 (higher = more new wallets)
    const buyerScore = totalWalletCount > 0
      ? Math.min(100, Math.round((weightedNew / (totalWalletCount * 3)) * 100))
      : 0;

    // Creator age analysis (PRIMARY signal)
    const creatorAgeMs = state.creatorAge !== null ? now - state.creatorAge : null;
    const creatorAgeHours = creatorAgeMs !== null ? creatorAgeMs / (60 * 60 * 1000) : null;
    const creatorIsNew = creatorAgeMs !== null && creatorAgeMs < AGE_24_HOURS_MS;

    // Combined scoring: creator age is PRIMARY (70%), buyer age is SECONDARY (30%)
    // If creator is established (>7 days), buyer score doesn't matter → low combined score
    // If creator is new (<1 hour) AND buyers are new → high combined score
    let combinedScore: number;
    if (creatorAgeMs === null) {
      // Creator age unknown (RPC not resolved yet) → apply moderate penalty
      // Can't assume creator is established → treat as suspicious
      combinedScore = Math.min(100, Math.round(buyerScore * 0.7 + 15));
    } else if (creatorAgeMs >= AGE_7_DAYS_MS) {
      // Creator established (>7 days) → buyer score heavily discounted
      // Max combined score = 30 (buyer score * 0.3)
      combinedScore = Math.round(buyerScore * 0.3);
    } else if (creatorAgeMs >= AGE_24_HOURS_MS) {
      // Creator somewhat established (1-7 days) → moderate weighting
      combinedScore = Math.round(buyerScore * 0.5);
    } else {
      // Creator NEW (<24 hours) → full buyer score matters
      // Creator < 1 hour = extra penalty
      const creatorPenalty = creatorAgeMs < AGE_1_HOUR_MS ? 20 : 10;
      combinedScore = Math.min(100, Math.round(buyerScore * 0.7 + creatorPenalty));
    }

    return {
      score: combinedScore,
      newWalletCount,
      totalWalletCount,
      avgAgeHours: totalWalletCount > 0 ? totalAgeHours / totalWalletCount : 0,
      youngestWalletAgeMinutes: minAgeMinutes === Infinity ? 0 : minAgeMinutes,
      creatorAgeHours,
      creatorIsNew,
    };
  }

  /**
   * Get the latest score for a mint (from last analysis).
   * Returns null if no data.
   */
  getLatestScore(mint: MintAddress): number | null {
    const result = this.analyzeMint(mint);
    return result?.score ?? null;
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
    if (result.score >= this.config.scoreThreshold) {
      const canEmit = !state || (nowMs() - state.lastSignalAt > this.config.cooldownMs);
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

  /**
   * Resolve wallet age: cache hit → return cached, cache miss → RPC fetch.
   */
  private async resolveWalletAge(wallet: string): Promise<number | null> {
    const cached = this.walletAgeCache.get(wallet);
    if (cached !== undefined) return cached;

    const firstTxTime = await this.fetchWalletCreationTime(wallet);
    if (firstTxTime === null) return null;
    this.walletAgeCache.set(wallet, firstTxTime);
    return firstTxTime;
  }

  /**
   * Fetch wallet's first transaction timestamp via getSignaturesForAddress.
   * Paginates backwards (max 3 pages) to find the oldest transaction.
   */
  private async fetchWalletCreationTime(wallet: string): Promise<number | null> {
    try {
      const pubkey = new PublicKey(wallet);
      let oldestBlockTime: number | null = null;
      let before: string | undefined = undefined;

      for (let page = 0; page < 3; page++) {
        const conn = this.rpcPool.next();
        let sigs: any[];
        try {
          sigs = await conn.getSignaturesForAddress(pubkey, { limit: 100, before });
          this.rpcPool.reportSuccess(conn);
        } catch (err) {
          this.rpcPool.reportError(conn, err);
          throw err;
        }
        if (!sigs || sigs.length === 0) break;
        const lastSig = sigs[sigs.length - 1];
        if (lastSig?.blockTime) oldestBlockTime = lastSig.blockTime * 1000;
        if (sigs.length < 100) break;
        before = lastSig?.signature;
      }
      return oldestBlockTime;
    } catch {
      return null; // RPC failure → exclude from scoring
    }
  }

  private emitSignal(mint: MintAddress, analysis: WalletAgeAnalysis): void {
    const signal: WalletAgeSignal = {
      id: generateId('sig'),
      type: 'WALLET_AGE',
      mint,
      timestamp: nowMs(),
      slot: 0,
      walletAgeScore: analysis.score,
      newWalletCount: analysis.newWalletCount,
      totalWalletCount: analysis.totalWalletCount,
      avgAgeHours: analysis.avgAgeHours,
      creatorAgeHours: analysis.creatorAgeHours,
      creatorIsNew: analysis.creatorIsNew,
    };

    walletAgeDetectionsCounter.inc();
    walletAgeScoreGauge.set({ mint: mint.slice(0, 8) }, analysis.score);

    logger.warn('WalletAge ALERT — majority of buying wallets are new', {
      mint: mint.slice(0, 12),
      score: analysis.score,
      newWallets: analysis.newWalletCount,
      totalWallets: analysis.totalWalletCount,
      avgAgeHours: analysis.avgAgeHours.toFixed(1),
      youngestMinutes: analysis.youngestWalletAgeMinutes.toFixed(1),
    });

    for (const handler of this.handlers) {
      try { handler(signal); } catch { /* handler errors are non-fatal */ }
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
      logger.debug('WalletAge cleanup', { cleaned, remaining: this.mintStates.size });
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
