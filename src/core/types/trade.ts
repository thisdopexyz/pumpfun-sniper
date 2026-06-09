/**
 * Trade type definitions.
 *
 * Trade records and transaction data. Pure data shapes.
 */

import type { MintAddress } from './token.js';

/** Unique trade identifier */
export type TradeId = string;

/** Trade side */
export type TradeSide = 'BUY' | 'SELL';

/** Trade status */
export type TradeStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'EXPIRED';

/** Single trade record */
export interface TradeRecord {
  readonly id: TradeId;
  readonly mint: MintAddress;
  readonly side: TradeSide;
  readonly status: TradeStatus;
  readonly amountSol: bigint;
  readonly amountTokens: bigint;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly submittedAt: number;
  readonly confirmedAt: number | null;
  readonly failureReason: string | null;
  readonly exitReason: string | null;
}
