/**
 * Bundle Detector
 *
 * Detects bundled token purchases where a cluster of wallets buys a large
 * percentage of supply in a short early window. Clusters wallets by:
 *   (a) same-block purchases (same slot)
 *   (b) same funding source (wallets funded from the same parent wallet)
 *
 * Calculates bundlePct = total tokens bought by clustered wallets / total supply * 100
 * Emits a BUNDLE signal when bundlePct exceeds the configurable threshold (default 30%).
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { BundleSignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { UnionFind } from '../../core/utils/unionFind.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Gauge } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:bundle');

// ---------------------------------------------------------------------------
// CEX Hot Wallet Exclusion List
// ---------------------------------------------------------------------------
// These are known centralized exchange hot wallets. When tracing funding
// chains, we STOP at these addresses — they are shared by millions of users
// and cannot be used to cluster wallets.

const CEX_HOT_WALLETS = new Set([
  // Binance
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dKydWw',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSrm5PbVSJTEwMLuXw',
  'ANqY8h3sRFCwFronwDRcT5jvPacehtvkKjHRFRcMonVY',
  // OKX
  '6FEVkH1Jj6rmSr8H4jwzrFzLox6sM8YAB3CucyVHdUES',
  'FpwQQhRkB3TkXeRCQwHLMcPdDcLHwGMsCfMdB4iAE6cB',
  // Bybit
  '5PAhQiYdLBd6SV4z2B6pSBc6ECFgx7UMzKcEqRWwKFzX',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  // KuCoin
  'HVrJ8qFA1Je4p88Jq3J7B1jE4aPg7z3Lm8MJz9FCcTAD',
  // Bitfinex
  '3gJ7KiHcFuXfMehJqFmPF9iMPNKHLLDWRhZG3Y8yBLzC',
  // HTX (Huobi)
  '57vSaRTqN9iXaemMJRqQD6nFmL2AMXfM3Kj1JS3wBZaF',
  // Gate.io
  'u6PJ8DtQuPFnfmwHbGFb8jKMqXQdJPJi3x5G36RLbQE',
  // MEXC
  '7GBaRQFydqBBF7HxSNTdK2w2x3Zi7qgQHdj5GnFv2J3',
  // Phantom aggregator
  '9CLoQ1cMQ5PG3dJtEHq5eMNoFwYrPg3C4uL3FAcBoqFA',
]);

/** Multi-hop funding trace depth (A funds B funds C → 3 hops). */
const MAX_FUNDING_HOP_DEPTH = 3;

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const bundleDetectionsCounter = new Counter({
  name: 'pumpfun_bundle_detector_detections_total',
  help: 'Total bundle detections emitted by the bundle detector',
  registers: [register],
});

const bundlePctGauge = new Gauge({
  name: 'pumpfun_bundle_detector_latest_pct',
  help: 'Bundle percentage from the most recent analysis',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the bundle detector. */
export interface BundleDetectorConfig {
  /** Early window in seconds from first buy. Default: 60. */
  readonly windowSeconds?: number;
  /**
   * Minimum elapsed time (ms) before forceAnalyze will return data.
   * Default: 30000 (30s) — matches momentum detector's window so that
   * entry checks at momentum-signal time have bundle data available.
   * Must be <= windowMs. If a buyer's momentum signal fires at 30s but
   * the bundle window is 60s, forceAnalyze would otherwise return null
   * and the entry check would BLOCK with "Bundle % unavailable".
   */
  readonly forceAnalyzeMinMs?: number;
  /**
   * Safety margin added to partial-window bundle estimates (0-100 pct).
   * Default: 5. Compensates for the fact that 30-60s of additional buys
   * could push the pct higher than what we observed at forceAnalyzeMinMs.
   * Set to 0 to disable, or higher for stricter early-window analysis.
   */
  readonly partialWindowSafetyMarginPct?: number;
  /** Max bundle percentage before emitting signal. Default: 30. */
  readonly maxBundlePct?: number;
  /** Minimum buy count to analyze. Default: 5. */
  readonly minBuyCount?: number;
  /** Cooldown per mint in ms before re-emitting. Default: 120_000 (2 min). */
  readonly cooldownMs?: number;
}

/** A single buy event for bundle analysis. */
export interface BundleBuyEvent {
  readonly mint: MintAddress;
  readonly wallet: string;
  readonly slot: number;
  readonly timestamp: number;
  /** Amount of tokens bought (in smallest unit). */
  readonly tokenAmount: bigint;
  /** Optional: the funding wallet that funded this buyer wallet. */
  readonly fundingWallet?: string;
  /** Optional: multi-hop funding chain (oldest → newest). Used for CEX-aware tracing. */
  readonly fundingChain?: readonly string[];
}

/** Internal buy record stored per token. */
interface BuyRecord {
  readonly wallet: string;
  readonly slot: number;
  readonly timestamp: number;
  readonly tokenAmount: bigint;
  readonly fundingWallet?: string;
  /** Multi-hop funding chain for CEX-aware clustering. */
  readonly fundingChain?: readonly string[];
}

/** Per-token tracking state. */
interface TokenBundleState {
  /** Timestamp of the first buy (defines the early window start). */
  readonly windowStart: number;
  /** All buys within the early window. */
  buys: BuyRecord[];
  /** Last time a bundle signal was emitted for this token. */
  lastSignalAt: number;
  /** Whether the window has closed (we already computed or it expired). */
  windowClosed: boolean;
}

// ---------------------------------------------------------------------------
// BundleDetector
// ---------------------------------------------------------------------------

export class BundleDetector implements IDetector {
  readonly name = 'bundle-detector';

  private readonly handlers: SignalHandler[] = [];
  private readonly tokenStates = new Map<MintAddress, TokenBundleState>();
  private running = false;
  private signalCounter = 0;

  private readonly windowMs: number;
  private readonly forceAnalyzeMinMs: number;
  private readonly partialWindowSafetyMarginPct: number;
  private readonly maxBundlePct: number;
  private readonly minBuyCount: number;
  private readonly cooldownMs: number;

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: BundleDetectorConfig) {
    this.windowMs = (config?.windowSeconds ?? 180) * 1000; // Increased from 60s to 180s
    // Default forceAnalyzeMinMs = 30s (matches momentum detector's 30s window).
    // If a token's momentum signal fires at 30s but the bundle window is 60s,
    // we still need bundle data for the entry check — otherwise the check
    // blocks with "Bundle % unavailable" and we miss the trade entirely.
    // Must be <= windowMs; if user sets it higher, clamp to windowMs.
    const requestedMinMs = config?.forceAnalyzeMinMs ?? 30_000;
    this.forceAnalyzeMinMs = Math.min(requestedMinMs, this.windowMs);
    this.partialWindowSafetyMarginPct = config?.partialWindowSafetyMarginPct ?? 5;
    this.maxBundlePct = config?.maxBundlePct ?? 20; // Lowered from 30% to 20%
    this.minBuyCount = config?.minBuyCount ?? 5;
    this.cooldownMs = config?.cooldownMs ?? 120_000;
  }

  // -------------------------------------------------------------------------
  // IDetector implementation
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeStaleTokens();
    }, 30_000);

    logger.info('Bundle detector started', {
      windowMs: this.windowMs,
      maxBundlePct: this.maxBundlePct,
      minBuyCount: this.minBuyCount,
      cooldownMs: this.cooldownMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokenStates.clear();
    logger.info('Bundle detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Get the latest bundle percentage for a mint.
   * Returns null if no data available.
   */
  getLatestBundlePct(mint: string): number | null {
    const state = this.tokenStates.get(mint as MintAddress);
    if (!state || state.buys.length < 3) return null;
    return this.analyzeBundle(mint as MintAddress, state);
  }

  // -------------------------------------------------------------------------
  // Public API — called from ingestion pipeline
  // -------------------------------------------------------------------------

  /**
   * Process a buy event for bundle detection.
   * Only buy events are relevant — sells are ignored.
   */
  handleBuy(event: BundleBuyEvent): void {
    if (!this.running) return;

    let state = this.tokenStates.get(event.mint);
    if (state === undefined) {
      state = {
        windowStart: event.timestamp,
        buys: [],
        lastSignalAt: 0,
        windowClosed: false,
      };
      this.tokenStates.set(event.mint, state);
    }

    // If the window is still open and the event is within the window, record it
    if (!state.windowClosed && event.timestamp - state.windowStart <= this.windowMs) {
      state.buys.push({
        wallet: event.wallet,
        slot: event.slot,
        timestamp: event.timestamp,
        tokenAmount: event.tokenAmount,
        fundingWallet: event.fundingWallet,
        fundingChain: event.fundingChain,
      });
    }

    // If the window just closed (first buy outside window or enough time elapsed),
    // compute the bundle analysis
    if (!state.windowClosed) {
      // Use event-time only for window closure. Real-time check was removed
      // because under processing delays, real-time could close the window
      // before all early-window events arrived, causing understated bundle%.
      if (event.timestamp - state.windowStart > this.windowMs) {
        state.windowClosed = true;
        this.analyzeBundle(event.mint, state);
      }
    }
  }

  /**
   * Force-analyze a token's bundle state (e.g., at migration or when
   * the caller wants an immediate check). Returns the bundle pct.
   *
   * Two-tier analysis:
   *  - Window closed (elapsed >= windowMs): full authoritative analysis.
   *  - Window open but elapsed >= forceAnalyzeMinMs: partial-window
   *    analysis with a safety margin added (configurable, default +5%).
   *    This lets the entry check at momentum-signal time (~30s) have
   *    data, even when the full 60s bundle window hasn't closed yet.
   *    Risk: scammers spreading buys across 30-60s could push the
   *    real bundle % higher than our partial estimate — the safety
   *    margin compensates for this.
   *  - Window open AND elapsed < forceAnalyzeMinMs: returns null
   *    (truly insufficient data — token is too fresh).
   */
  forceAnalyze(mint: MintAddress): number | null {
    const state = this.tokenStates.get(mint);
    if (state === undefined || state.buys.length < 1) {
      return null; // Insufficient data — can't assess risk
    }

    const elapsed = nowMs() - state.windowStart;

    if (!state.windowClosed) {
      if (elapsed < this.forceAnalyzeMinMs) {
        // Window not yet at minimum threshold — token is too fresh
        // to assess bundle risk. Caller should treat as unavailable.
        logger.debug('Bundle forceAnalyze: too early in window, deferring', {
          mint: mint.slice(0, 12),
          elapsedMs: elapsed,
          forceAnalyzeMinMs: this.forceAnalyzeMinMs,
          remainingMs: this.forceAnalyzeMinMs - elapsed,
        });
        return null;
      }
      if (elapsed < this.windowMs) {
        // Partial-window estimate: run analysis now, add safety margin
        // to compensate for buys that will arrive in the remaining
        // windowMs - elapsed ms.
        const partial = this.analyzeBundle(mint, state);
        if (partial === null) return null;
        const adjusted = Math.min(100, partial + this.partialWindowSafetyMarginPct);
        if (adjusted !== partial) {
          logger.debug('Bundle forceAnalyze: partial-window estimate with safety margin', {
            mint: mint.slice(0, 12),
            partialPct: partial,
            safetyMarginPct: this.partialWindowSafetyMarginPct,
            adjustedPct: adjusted,
            elapsedMs: elapsed,
            windowMs: this.windowMs,
          });
        }
        return adjusted;
      }
      // Window has elapsed but no buy triggered closure yet — force close
      state.windowClosed = true;
    }

    return this.analyzeBundle(mint, state);
  }

  /**
   * Pre-warm the bundle detector with a launch event. Initializes an
   * empty token state so that handleBuy can record buys against it
   * even if a momentum signal fires before the first buy event reaches
   * the detector. Also used to ensure the elapsed time is measured from
   * the actual launch moment, not the first buy (which can lag by a
   * few hundred ms in WS processing).
   *
   * Returns true if a new state was created, false if one already
   * existed (idempotent — safe to call multiple times).
   */
  handleLaunch(mint: MintAddress, timestamp?: number): boolean {
    if (this.tokenStates.has(mint)) return false;
    this.tokenStates.set(mint, {
      windowStart: timestamp ?? nowMs(),
      buys: [],
      lastSignalAt: 0,
      windowClosed: false,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze buys for a mint, identify bundled wallets, and emit signal if threshold met.
   * Returns the computed bundlePct.
   */
  private analyzeBundle(mint: MintAddress, state: TokenBundleState): number | null {
    const buys = state.buys;
    if (buys.length < this.minBuyCount) return null; // Insufficient data

    // Calculate total tokens across all buys
    let totalTokenAmount = 0n;
    for (const buy of buys) {
      totalTokenAmount += buy.tokenAmount;
    }
    if (totalTokenAmount === 0n) return 0;

    // 1. Cluster wallets by same-slot (same block)
    const slotClusters = this.buildSlotClusters(buys);

    // 2. Cluster wallets by same funding source
    const fundingClusters = this.buildFundingClusters(buys);

    // 3. Merge clusters: union-find over both clustering methods
    const mergedClusters = this.mergeClusters(slotClusters, fundingClusters);

    // 4. Find the cluster with the highest token percentage
    let bestCluster: Set<string> = new Set();
    let bestClusterPct = 0;

    for (const cluster of mergedClusters) {
      let clusterTokens = 0n;
      for (const buy of buys) {
        if (cluster.has(buy.wallet)) {
          clusterTokens += buy.tokenAmount;
        }
      }
      const pct = Number((clusterTokens * 10000n) / totalTokenAmount) / 100;
      if (pct > bestClusterPct) {
        bestClusterPct = pct;
        bestCluster = cluster;
      }
    }

    // 5. Also check single-wallet "bundles": one wallet buying many times in same slot
    // This catches the case where a single wallet buys many times (no multi-wallet cluster)
    const walletTokenAmounts = new Map<string, bigint>();
    for (const buy of buys) {
      walletTokenAmounts.set(buy.wallet, (walletTokenAmounts.get(buy.wallet) ?? 0n) + buy.tokenAmount);
    }

    // Check if any single wallet bought more than the threshold
    for (const [wallet, tokens] of walletTokenAmounts) {
      const pct = Number((tokens * 10000n) / totalTokenAmount) / 100;
      if (pct > bestClusterPct) {
        bestClusterPct = pct;
        bestCluster = new Set([wallet]);
      }
    }

    // NOTE: Slot-level aggregation REMOVED — same slot != bundle.
    // On Solana many independent txs land in same block. Not evidence of coordination.
    // Valid bundle signals: same-funding-source clustering + single-wallet concentration only.

    const bundlePct = bestClusterPct;
    bundlePctGauge.set(bundlePct);

    const windowMs = buys[buys.length - 1]!.timestamp - state.windowStart;

    if (bundlePct > this.maxBundlePct) {
      const now = nowMs();
      if (now - state.lastSignalAt >= this.cooldownMs) {
        state.lastSignalAt = now;

        logger.info(
          `Bundle detected: ${bestCluster.size} wallet(s) bought ${bundlePct.toFixed(1)}% supply in ${windowMs}ms`,
          {
            mint: mint.slice(0, 12),
            bundlePct: bundlePct.toFixed(2),
            clusteredWalletCount: bestCluster.size,
            totalBuyCount: buys.length,
            windowMs,
          },
        );

        this.emitBundleSignal(mint, bundlePct, bestCluster.size, buys.length, windowMs);
      }
    }

    return bundlePct;
  }

  /**
   * Build clusters of wallets that bought in the same slot.
   * Returns an array of sets, each set = wallets that bought in a particular slot.
   */
  private buildSlotClusters(buys: BuyRecord[]): Array<Set<string>> {
    const slotMap = new Map<number, Set<string>>();
    for (const buy of buys) {
      let set = slotMap.get(buy.slot);
      if (set === undefined) {
        set = new Set();
        slotMap.set(buy.slot, set);
      }
      set.add(buy.wallet);
    }
    // Only return clusters with 2+ wallets (a single wallet in a slot isn't a cluster)
    const clusters: Array<Set<string>> = [];
    for (const set of slotMap.values()) {
      if (set.size >= 2) {
        clusters.push(set);
      }
    }
    return clusters;
  }

  /**
   * Build clusters of wallets that share the same funding source.
   * Now with CEX exclusion: stops tracing at known CEX hot wallets.
   * Also supports multi-hop funding chains (A → B → C).
   * Returns an array of sets, each set = wallets funded by the same non-CEX root.
   */
  private buildFundingClusters(buys: BuyRecord[]): Array<Set<string>> {
    const fundingMap = new Map<string, Set<string>>();
    for (const buy of buys) {
      if (buy.fundingWallet !== undefined && buy.fundingWallet !== '') {
        // Skip CEX hot wallets — can't cluster by CEX source
        if (CEX_HOT_WALLETS.has(buy.fundingWallet)) continue;

        let set = fundingMap.get(buy.fundingWallet);
        if (set === undefined) {
          set = new Set();
          fundingMap.set(buy.fundingWallet, set);
        }
        set.add(buy.wallet);
      }
    }

    // Multi-hop: also check if any funding wallets are themselves funded
    // by the same non-CEX source (merge clusters with shared upstream)
    const upstreamMap = new Map<string, string>(); // wallet → root funder
    for (const buy of buys) {
      if (buy.fundingChain && buy.fundingChain.length > 1) {
        // Walk the chain backwards to find the first non-CEX funder
        let root = buy.fundingChain[0] ?? buy.fundingWallet;
        for (let depth = 0; depth < Math.min(buy.fundingChain.length, MAX_FUNDING_HOP_DEPTH); depth++) {
          const hop = buy.fundingChain[depth];
          if (!hop) break;
          if (CEX_HOT_WALLETS.has(hop)) {
            // CEX reached — use previous hop as root
            break;
          }
          root = hop;
        }
        if (root && !CEX_HOT_WALLETS.has(root)) {
          upstreamMap.set(buy.wallet, root);
          let set = fundingMap.get(root);
          if (set === undefined) {
            set = new Set();
            fundingMap.set(root, set);
          }
          set.add(buy.wallet);
        }
      }
    }

    const clusters: Array<Set<string>> = [];
    for (const set of fundingMap.values()) {
      if (set.size >= 2) {
        clusters.push(set);
      }
    }
    return clusters;
  }

  /**
   * Merge clusters from different sources using union-find.
   * If two clusters share any wallet, they are merged into one.
   */
  private mergeClusters(
    ...clusterSources: Array<Array<Set<string>>>
  ): Array<Set<string>> {
    // Flatten all clusters
    const allClusters: Array<Set<string>> = [];
    for (const source of clusterSources) {
      allClusters.push(...source);
    }

    if (allClusters.length === 0) {
      return [];
    }

    const uf = new UnionFind();

    // For each cluster, union all wallets together
    for (const cluster of allClusters) {
      const wallets = [...cluster];
      if (wallets.length === 0) continue;

      const first = wallets[0]!;
      for (let i = 1; i < wallets.length; i++) {
        uf.union(first, wallets[i]!);
      }
    }

    // Return only clusters with 2+ wallets
    return uf.getConnectedComponents(2);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emitBundleSignal(
    mint: MintAddress,
    bundlePct: number,
    clusteredWalletCount: number,
    totalBuyCount: number,
    windowMs: number,
  ): void {
    this.signalCounter += 1;
    const signalId = `bundle-${this.signalCounter}-${nowMs()}`;

    const signal: BundleSignal = {
      id: signalId,
      type: 'BUNDLE',
      mint,
      timestamp: nowMs(),
      slot: 0, // Bundle signals span multiple slots — use 0
      bundlePct,
      clusteredWalletCount,
      totalBuyCount,
      windowMs,
    };

    logger.debug('Bundle signal emitted', {
      signalId,
      mint,
      bundlePct: bundlePct.toFixed(2),
      clusteredWalletCount,
      totalBuyCount,
      windowMs,
    });

    bundleDetectionsCounter.inc();

    for (const handler of this.handlers) {
      try {
        handler(signal);
      } catch (err: unknown) {
        logger.error('Signal handler threw', {
          signalId: signal.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private purgeStaleTokens(): void {
    const cutoff = nowMs() - this.windowMs * 3;
    for (const [mint, state] of this.tokenStates) {
      // Remove tokens whose window closed and are stale
      if (state.windowClosed) {
        const latestBuy = state.buys[state.buys.length - 1];
        if (latestBuy === undefined || latestBuy.timestamp < cutoff) {
          this.tokenStates.delete(mint);
        }
      } else {
        // If the window hasn't closed but the windowStart is way past, force-close
        if (nowMs() - state.windowStart > this.windowMs * 2) {
          state.windowClosed = true;
          this.analyzeBundle(mint, state);
          // After analysis, if still stale (buys all old), it'll get cleaned next cycle
        }
      }
    }
  }
}
