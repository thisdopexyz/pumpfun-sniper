import type { PublicKey } from '@solana/web3.js';
import type { ServiceContainer } from '../container.js';
import type { PositionRegistry } from '../../core/state/positionRegistry.js';
import type { CrossTokenCorrelator } from '../../detectors/crossToken/crossTokenCorrelator.js';
import { PumpSdk } from '../../adapters/protocols/pumpfun/officialPumpSdk.js';

export interface ExecutionRuntime {
  readonly container: ServiceContainer;
  readonly positionRegistry: PositionRegistry;
  readonly pumpSdk: InstanceType<typeof PumpSdk>;
  readonly crossTokenCorrelator?: CrossTokenCorrelator;
  readonly maxTxRetries: number;
  readonly retryDelayMs: number;
  nextTradeId(): string;
  delay(ms: number): Promise<void>;
  isPermanentError(error: string): boolean;
  getMintTokenProgram(mint: PublicKey): Promise<PublicKey>;
  getUserTokenBalance(user: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Promise<bigint>;
  confirmSubmittedTransaction(
    signature: string,
    blockhash?: string,
    lastValidBlockHeight?: number,
  ): Promise<string | null>;
  computePositionSizeLamports(solPriceUsd: number, positionSizeUsd?: number): bigint;
}
