/**
 * Position type definitions.
 *
 * Position lifecycle states and tracking.
 * Explicit states only — no ambiguous state (per rule.md).
 */

import type { MintAddress } from './token.js';
import type { TradeId } from './trade.js';
import type { ExitReason } from './strategy.js';

/** Position lifecycle states — LOCKED, explicit only */
export type PositionStatus =
  | 'DETECTED'
  | 'FILTERED'
  | 'ENTERING'
  | 'ENTERED'
  | 'EXIT_PENDING'
  | 'SCALE_OUT_PARTIAL'
  | 'EXITED'
  | 'FAILED'
  | 'STOPPED';

/** Unique position identifier */
export type PositionId = string;

/** Active position tracking */
export interface Position {
  readonly id: PositionId;
  readonly mint: MintAddress;
  readonly status: PositionStatus;
  readonly tradeId: TradeId | null;
  readonly entryAmountSol: bigint | null;
  readonly entryAmountTokens: bigint | null;
  readonly entryPriceSol: bigint | null;
  readonly entryTimestamp: number | null;
  readonly currentPnlPercent: number | null;
  readonly exitReason: ExitReason | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Scale-out tiers already completed (by index). */
  readonly scaleOutTiersCompleted?: readonly number[];
}

/** Position transition event */
export interface PositionTransition {
  readonly positionId: PositionId;
  readonly from: PositionStatus;
  readonly to: PositionStatus;
  readonly reason: string;
  readonly timestamp: number;
}
