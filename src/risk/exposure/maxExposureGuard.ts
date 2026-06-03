/**
 * Max Exposure Guard
 *
 * Prevents opening new positions when max concurrent positions
 * or max total exposure is reached.
 *
 * Dynamic behavior:
 *   - Base limit = DEFAULT_MAX_CONCURRENT_POSITIONS (2)
 *   - After scale-out tier 0: +1 (capital partially recovered)
 *   - Hard cap: MAX_POSITIONS_CAP (5)
 *   - On full exit: -1 (down to base)
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import { DEFAULT_MAX_CONCURRENT_POSITIONS } from '../../core/constants/defaults.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:maxExposureGuard');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Current exposure state. */
export interface ExposureState {
  /** Number of currently open positions. */
  readonly openPositionCount: number;
  /** Total SOL currently at risk (lamports). */
  readonly totalExposureLamports: bigint;
}

/** Exposure check result. */
export interface ExposureCheckResult {
  /** Whether a new position can be opened. */
  readonly allowed: boolean;
  /** Current number of open positions. */
  readonly currentPositions: number;
  /** Max allowed positions. */
  readonly maxPositions: number;
  /** Reason if not allowed. */
  readonly reason: string | null;
}

/** Provider to query current open positions. */
export interface PositionProvider {
  getOpenPositionCount(): Promise<number>;
  getTotalExposureLamports(): Promise<bigint>;
}

/** Configuration. */
export interface MaxExposureGuardConfig {
  /** Max concurrent positions. Default: 2. */
  readonly maxConcurrentPositions?: number;
}

// ---------------------------------------------------------------------------
// MaxExposureGuard
// ---------------------------------------------------------------------------

/** Hard cap — max positions can never exceed this. */
const MAX_POSITIONS_CAP = 5;

export class MaxExposureGuard {
  private maxPositions: number;
  /** Base limit — floor for maxPositions. */
  private readonly basePositions: number;
  /** Exposed for synchronous re-checks in buy flow. */
  get maxConcurrentPositions(): number { return this.maxPositions; }
  private readonly positionProvider: PositionProvider;

  constructor(positionProvider: PositionProvider, config?: MaxExposureGuardConfig) {
    this.positionProvider = positionProvider;
    this.basePositions = config?.maxConcurrentPositions ?? DEFAULT_MAX_CONCURRENT_POSITIONS;
    this.maxPositions = this.basePositions;
  }

  /**
   * Increment max concurrent positions (e.g. after scale-out tier 0).
   * Capped at MAX_POSITIONS_CAP.
   */
  addMaxPositions(delta: number): number {
    const prev = this.maxPositions;
    this.maxPositions = Math.min(this.maxPositions + delta, MAX_POSITIONS_CAP);
    logger.info('Max positions increased', {
      prev,
      newMax: this.maxPositions,
      delta,
      capped: this.maxPositions === MAX_POSITIONS_CAP,
    });
    return this.maxPositions;
  }

  /**
   * Decrement max concurrent positions (e.g. after full exit).
   * Floor at basePositions.
   */
  removeMaxPositions(delta: number): number {
    const prev = this.maxPositions;
    this.maxPositions = Math.max(this.maxPositions - delta, this.basePositions);
    logger.info('Max positions decreased', {
      prev,
      newMax: this.maxPositions,
      delta,
    });
    return this.maxPositions;
  }

  /**
   * Set max positions directly (for restoring from persisted state).
   * Clamped to [basePositions, MAX_POSITIONS_CAP].
   */
  setMaxPositions(value: number): void {
    this.maxPositions = Math.max(this.basePositions, Math.min(value, MAX_POSITIONS_CAP));
    logger.info('Max positions restored', { newMax: this.maxPositions });
  }

  /**
   * Check if a new position can be opened.
   */
  async canOpenPosition(): Promise<ExposureCheckResult> {
    const currentCount = await this.positionProvider.getOpenPositionCount();

    if (currentCount >= this.maxPositions) {
      logger.info('Max exposure reached — cannot open new position', {
        currentPositions: currentCount,
        maxPositions: this.maxPositions,
      });
      return {
        allowed: false,
        currentPositions: currentCount,
        maxPositions: this.maxPositions,
        reason: `Max concurrent positions reached: ${currentCount}/${this.maxPositions}`,
      };
    }

    logger.debug('Exposure check passed', {
      currentPositions: currentCount,
      maxPositions: this.maxPositions,
    });
    return {
      allowed: true,
      currentPositions: currentCount,
      maxPositions: this.maxPositions,
      reason: null,
    };
  }

  /**
   * Get current exposure state.
   */
  async getExposure(): Promise<ExposureState> {
    const [count, exposure] = await Promise.all([
      this.positionProvider.getOpenPositionCount(),
      this.positionProvider.getTotalExposureLamports(),
    ]);
    return {
      openPositionCount: count,
      totalExposureLamports: exposure,
    };
  }
}
