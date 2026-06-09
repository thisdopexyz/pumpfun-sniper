/**
 * Signal type definitions.
 *
 * Signals emitted by detectors. Pure data — no decision logic.
 */

import type { MintAddress } from './token.js';
import type { WalletAddress } from './wallet.js';

/** Signal type discriminator */
export type SignalType = 'LAUNCH' | 'MOMENTUM' | 'MIGRATION' | 'LIQUIDITY_PHASE' | 'WASH_TRADE' | 'BUNDLE' | 'CABAL' | 'DAY_PHASE' | 'DEX_PAID' | 'CONCENTRATION' | 'SMART_MONEY' | 'REVOKE' | 'WALLET_AGE' | 'BUY_VELOCITY' | 'CROSS_TOKEN';

/** Unique signal identifier */
export type SignalId = string;

/** Base signal shape — all signals extend this */
export interface BaseSignal {
  readonly id: SignalId;
  readonly type: SignalType;
  readonly mint: MintAddress;
  readonly timestamp: number;
  readonly slot: number;
}

/** New token launch detected */
export interface LaunchSignal extends BaseSignal {
  readonly type: 'LAUNCH';
  readonly creator: WalletAddress;
  readonly signature: string;
}

/** Momentum threshold met */
export interface MomentumSignal extends BaseSignal {
  readonly type: 'MOMENTUM';
  readonly buyCount: number;
  readonly windowSeconds: number;
  readonly volumeSol: bigint;
  /** Number of unique slots with buys in the window (for bundle detection). */
  readonly uniqueSlotCount?: number;
  /** Number of unique wallets with buys in the window. */
  readonly uniqueWalletCount?: number;
  /** Number of sells in the 60s window (for sell pressure detection). */
  readonly sellCount?: number;
}

/** Token graduated / migrated to Raydium */
export interface MigrationSignal extends BaseSignal {
  readonly type: 'MIGRATION';
  readonly migrationSignature: string;
}

/** Liquidity phase change */
export interface LiquidityPhaseSignal extends BaseSignal {
  readonly type: 'LIQUIDITY_PHASE';
  readonly phase: 'BONDING' | 'GRADUATED';
}

/** Wash trade pattern detected */
export interface WashTradeSignal extends BaseSignal {
  readonly type: 'WASH_TRADE';
  readonly washScore: number;
  readonly washReasons: readonly string[];
}

/** Bundle detection: clustered wallets bought significant supply in early window */
export interface BundleSignal extends BaseSignal {
  readonly type: 'BUNDLE';
  /** Percentage of total supply bought by clustered wallets (0-100). */
  readonly bundlePct: number;
  /** Number of wallets in the detected cluster. */
  readonly clusteredWalletCount: number;
  /** Total number of buy transactions in the early window. */
  readonly totalBuyCount: number;
  /** Duration of the early window in milliseconds. */
  readonly windowMs: number;
}

/** Cabal / coordinated wallet cluster detected */
export interface CabalSignal extends BaseSignal {
  readonly type: 'CABAL';
  readonly cabalScore: number;
  readonly clusterSize: number;
  readonly wallets: readonly WalletAddress[];
}

/** Day phase analysis result */
export interface DayPhaseSignal extends BaseSignal {
  readonly type: 'DAY_PHASE';
  readonly fdv: number;
  readonly athDipPct: number;
  readonly sidewaysDays: number;
  readonly holderTrend: 'growing' | 'stable' | 'declining';
}

/** DEX paid listing detected (late entry signal) */
export interface DexPaidSignal extends BaseSignal {
  readonly type: 'DEX_PAID';
  readonly isPaid: boolean;
  readonly isLate: boolean;
  readonly gapMinutes: number;
  readonly paidTimestamp: number | null;
}

/** Holder concentration warning */
export interface ConcentrationSignal extends BaseSignal {
  readonly type: 'CONCENTRATION';
  readonly effectiveConcentration: number;
  readonly clusterCount: number;
  readonly topClusterWallets: readonly string[];
}

/** Smart money wallet activity detected */
export interface SmartMoneySignal extends BaseSignal {
  readonly type: 'SMART_MONEY';
  readonly smartWalletCount: number;
  readonly smartMoneyScore: number;
  readonly wallets: readonly string[];
}

/** Token authority revoke timing analysis */
export interface RevokeSignal extends BaseSignal {
  readonly type: 'REVOKE';
  readonly revoked: boolean;
  readonly revokeTimestamp: number | null;
  readonly revokedAfterDump: boolean;
  readonly isPositive: boolean;
}

/** Wallet age analysis — detects tokens bought primarily by brand-new wallets */
export interface WalletAgeSignal extends BaseSignal {
  readonly type: 'WALLET_AGE';
  readonly walletAgeScore: number;
  readonly newWalletCount: number;
  readonly totalWalletCount: number;
  readonly avgAgeHours: number;
  readonly creatorAgeHours: number | null;
  readonly creatorIsNew: boolean;
}

/** Buy velocity analysis — detects bot swarms and coordinated mass buys */
export interface BuyVelocitySignal extends BaseSignal {
  readonly type: 'BUY_VELOCITY';
  readonly velocityScore: number;
  readonly walletsInWindow: number;
  readonly windowSeconds: number;
  readonly avgIntervalMs: number;
}

/** Cross-token correlation — detects serial scammer wallet clusters */
export interface CrossTokenSignal extends BaseSignal {
  readonly type: 'CROSS_TOKEN';
  readonly crossTokenScore: number;
  readonly dumpClusterSize: number;
  readonly matchedWallets: number;
}

/** Parsed token launch event (protocol-agnostic). Used by detectors. */
export interface LaunchEvent {
  readonly mint: MintAddress;
  readonly creator: WalletAddress;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly slot: number;
  readonly signature: string;
  readonly timestamp: number;
}

/** Union of all signal types */
export type Signal = LaunchSignal | MomentumSignal | MigrationSignal | LiquidityPhaseSignal | WashTradeSignal | BundleSignal | CabalSignal | DayPhaseSignal | DexPaidSignal | ConcentrationSignal | SmartMoneySignal | RevokeSignal | WalletAgeSignal | BuyVelocitySignal | CrossTokenSignal;
