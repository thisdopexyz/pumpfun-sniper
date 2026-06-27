/**
 * Execution Delegate facade.
 *
 * Keeps strategy-facing orchestration small while buy/sell implementation lives
 * in app/execution/*. Lower-level tx helpers remain under execution/tx/*.
 */

import { PublicKey } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import type { ServiceContainer } from './container.js';
import type { StrategyExecutionDelegate } from '../strategies/filteredSniper/filteredSniperStrategy.js';
import type { PositionRegistry } from '../core/state/positionRegistry.js';
import type { CrossTokenCorrelator } from '../detectors/crossToken/crossTokenCorrelator.js';
import { deriveUserATA } from '../adapters/protocols/pumpfun/pumpfunTradeBuilder.js';
import { POSITION_SIZE_USD } from '../strategies/filteredSniper/filteredSniperRules.js';
import { PumpSdk } from '../adapters/protocols/pumpfun/officialPumpSdk.js';
import { DEFAULT_MAX_TX_RETRIES, DEFAULT_TX_RETRY_DELAY_MS } from '../core/constants/defaults.js';
import { executeBuy } from './execution/buyExecutor.js';
import { executeSell } from './execution/sellExecutor.js';
import type { ExecutionRuntime } from './execution/runtime.js';

const pumpSdk = new PumpSdk();

/** Check if an execution error is non-retryable. */
export function isNonRetryableExecutionError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('insufficient funds')
    || lower.includes('account not found')
    || lower.includes('custom\":6062')
    || lower.includes('custom:6062')
    || lower.includes('custom 6062')
    || lower.includes('custom\":2006')
    || lower.includes('custom:2006')
    || lower.includes('custom 2006')
    || lower.includes('custom\":3005')
    || lower.includes('custom:3005')
    || lower.includes('custom 3005')
    || lower.includes('custom\":3012')
    || lower.includes('custom:3012')
    || lower.includes('custom 3012')
    || lower.includes('custom\":6024')
    || lower.includes('custom:6024')
    || lower.includes('custom 6024');
}

/** Compute position size in lamports from current SOL price. */
export function computePositionSizeLamports(solPriceUsd: number, positionSizeUsd?: number): bigint {
  const usd = positionSizeUsd ?? POSITION_SIZE_USD;
  return BigInt(Math.floor((usd / solPriceUsd) * 1_000_000_000));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_TX_RETRIES = DEFAULT_MAX_TX_RETRIES;
const RETRY_DELAY_MS = DEFAULT_TX_RETRY_DELAY_MS;

/**
 * Real execution delegate — facade that wires runtime dependencies once.
 */
export function createExecutionDelegate(
  container: ServiceContainer,
  positionRegistry: PositionRegistry,
  crossTokenCorrelator?: CrossTokenCorrelator,
): StrategyExecutionDelegate {
  let tradeCounter = 0;

  async function getMintTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const account = await container.connection.getAccountInfo(mint);
    if (!account) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    return account.owner;
  }

  async function getUserTokenBalance(
    user: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey,
  ): Promise<bigint> {
    const ata = deriveUserATA(user, mint, tokenProgram);
    const account = await container.connection.getAccountInfo(ata);
    if (!account) return 0n;
    const decoded = AccountLayout.decode(account.data);
    return BigInt(decoded.amount.toString());
  }

  /**
   * Wait for on-chain confirmation after sendRawTransaction.
   * sendCoordinator only proves the RPC accepted the tx; Pump.fun can still fail
   * on-chain, so sell must not untrack/save CONFIRMED until this returns null.
   */
  async function confirmSubmittedTransaction(
    signature: string,
    blockhash?: string,
    lastValidBlockHeight?: number,
  ): Promise<string | null> {
    try {
      const confirmation = blockhash !== undefined && lastValidBlockHeight !== undefined
        ? await container.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        )
        : await container.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        return JSON.stringify(confirmation.value.err);
      }
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  const runtime: ExecutionRuntime = {
    container,
    positionRegistry,
    pumpSdk,
    crossTokenCorrelator,
    maxTxRetries: MAX_TX_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
    nextTradeId: () => {
      tradeCounter += 1;
      return `buy-${Date.now()}-${tradeCounter}`;
    },
    delay,
    isPermanentError: isNonRetryableExecutionError,
    getMintTokenProgram,
    getUserTokenBalance,
    confirmSubmittedTransaction,
    computePositionSizeLamports,
  };

  return {
    executeBuy: (params) => executeBuy(params, runtime),
    executeSell: (params) => executeSell(params, runtime),
  };
}
