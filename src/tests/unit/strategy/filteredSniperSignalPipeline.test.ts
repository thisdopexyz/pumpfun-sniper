/**
 * Regression tests for live signal → entry-check pipeline wiring.
 *
 * These tests guard against fake/pass-through 9-check data:
 * - Strategy must not buy from LAUNCH/MIGRATION signals.
 * - Strategy must pass the full MOMENTUM signal context into the provider.
 * - Data provider must derive creator/momentum/launch checks from real signal history.
 */

import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { FilteredSniperStrategy } from '@strategies/filteredSniper/filteredSniperStrategy.js';
import type {
  BuyParams,
  BuyResult,
  SellParams,
  SellResult,
  StrategyDataProvider,
  StrategyExecutionDelegate,
} from '@strategies/filteredSniper/filteredSniperStrategy.js';
import type { EntryCheckData } from '@strategies/filteredSniper/entryDecision.js';
import type { PositionData } from '@strategies/filteredSniper/exitDecision.js';
import type { Signal, LaunchSignal, MomentumSignal, MigrationSignal } from '@core/types/signal.js';
import type { MintAddress } from '@core/types/token.js';
import { createDataProvider } from '@app/dataProvider.js';
import {
  CREATOR_HISTORY_MAX_LAUNCHES,
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_MS,
  MOMENTUM_WINDOW_SECONDS,
} from '@strategies/filteredSniper/filteredSniperRules.js';

const mint = '11111111111111111111111111111112' as MintAddress;
const creator = '11111111111111111111111111111113';

function makeLaunchSignal(overrides: Partial<LaunchSignal> = {}): LaunchSignal {
  return {
    id: 'sig-launch',
    type: 'LAUNCH',
    mint,
    creator,
    signature: 'launch-signature',
    timestamp: 1_000,
    slot: 10,
    ...overrides,
  } as LaunchSignal;
}

function makeMomentumSignal(overrides: Partial<MomentumSignal> = {}): MomentumSignal {
  return {
    id: 'sig-momentum',
    type: 'MOMENTUM',
    mint,
    buyCount: MOMENTUM_MIN_BUYS,
    windowSeconds: MOMENTUM_WINDOW_SECONDS,
    volumeSol: MOMENTUM_MIN_VOLUME_LAMPORTS,
    timestamp: 2_000,
    slot: 20,
    ...overrides,
  } as MomentumSignal;
}

function makeMigrationSignal(overrides: Partial<MigrationSignal> = {}): MigrationSignal {
  return {
    id: 'sig-migration',
    type: 'MIGRATION',
    mint,
    migrationSignature: 'migration-signature',
    timestamp: 3_000,
    slot: 30,
    ...overrides,
  } as MigrationSignal;
}

function passingEntryData(overrides: Partial<EntryCheckData> = {}): EntryCheckData {
  return {
    mint,
    launchDetected: true,
    creatorNotBlacklisted: true,
    creatorHistoryAcceptable: true,
    creatorScore: 50,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    metadataSane: true,
    liquiditySane: true,
    walletConcentrationAcceptable: true,
    buyCountInWindow: MOMENTUM_MIN_BUYS,
    volumeLamports: MOMENTUM_MIN_VOLUME_LAMPORTS,
    windowMs: MOMENTUM_WINDOW_MS,
    priceImpactBps: 100, // 1% — within limit
    bundlePct: 10,
    washTradeScore: 20,
    uniqueWallets: 25,
    sellCountInWindow: 3,
    realSolReservesLamports: 1_000_000_000n,
    holderCount: 50,
    marketCapUsd: 15000,
    volumeUsd: 5000,
    smartMoneyScore: 0,
    smartWalletCount: 0,
    walletAgeScore: 20,
    buyVelocityScore: 10,
    enhancedBundlePct: 10,
    crossTokenScore: 0,
    ...overrides,
  };
}

class RecordingProvider implements StrategyDataProvider {
  readonly calls: Signal[] = [];

  async getEntryCheckData(signal: Signal): Promise<EntryCheckData> {
    this.calls.push(signal);
    return passingEntryData({ mint: signal.mint });
  }

  async getPositionData(_tradeId: string): Promise<PositionData | null> {
    return null;
  }

  getActivePositionCount(): number {
    return 0;
  }

  isTokenBlacklisted(_mint: string): boolean {
    return false;
  }

  startAntiRugMonitoring(_mint: string): void {}
  stopAntiRugMonitoring(_mint: string): void {}
}

class RecordingExecutor implements StrategyExecutionDelegate {
  readonly buyHistory: BuyParams[] = [];
  readonly sellHistory: SellParams[] = [];

  async executeBuy(params: BuyParams): Promise<BuyResult> {
    this.buyHistory.push(params);
    return { success: true, tradeId: 'trade-001', signature: 'buy-sig', error: null };
  }

  async executeSell(params: SellParams): Promise<SellResult> {
    this.sellHistory.push(params);
    return { success: true, signature: 'sell-sig', error: null };
  }
}

describe('FilteredSniperStrategy signal pipeline', () => {
  it('ignores LAUNCH signals instead of buying before momentum is confirmed', async () => {
    const provider = new RecordingProvider();
    const executor = new RecordingExecutor();
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();

    const result = await strategy.onSignal(makeLaunchSignal());

    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect(executor.buyHistory).toHaveLength(0);
  });

  it('ignores MIGRATION signals so graduated tokens never enter the buy path', async () => {
    const provider = new RecordingProvider();
    const executor = new RecordingExecutor();
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();

    const result = await strategy.onSignal(makeMigrationSignal());

    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect(executor.buyHistory).toHaveLength(0);
  });

  it('uses the MOMENTUM signal payload for entry checks and buy mint', async () => {
    const provider = new RecordingProvider();
    const executor = new RecordingExecutor();
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();
    const signal = makeMomentumSignal({ buyCount: 6, windowSeconds: 12 });

    const result = await strategy.onSignal(signal);

    expect(result?.allowed).toBe(true);
    expect(provider.calls).toEqual([signal]);
    expect(executor.buyHistory).toHaveLength(1);
    expect(executor.buyHistory[0]?.mint).toBe(signal.mint);
  });
});

function makeMockContainer(overrides?: {
  readonly signals?: readonly Signal[];
  readonly creatorLaunches?: readonly LaunchSignal[];
  readonly blacklistedCreators?: readonly string[];
}): any {
  const signals = overrides?.signals ?? [];
  const creatorLaunches = overrides?.creatorLaunches ?? signals.filter((signal): signal is LaunchSignal => signal.type === 'LAUNCH');
  const blacklistedCreators = new Set(overrides?.blacklistedCreators ?? []);
  return {
    connection: {
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getTokenLargestAccounts: vi.fn().mockResolvedValue({ value: [] }),
      getTokenSupply: vi.fn().mockResolvedValue({ value: { amount: '0' } }),
    },
    signalRepository: {
      findByMint: vi.fn().mockResolvedValue(signals),
      findRecentLaunchesByCreator: vi.fn().mockResolvedValue(creatorLaunches),
    },
    creatorBlacklist: {
      isBlacklisted: vi.fn((wallet: string) => blacklistedCreators.has(wallet)),
    },
    killSwitch: {
      isAlive: vi.fn(() => true),
    },
  };
}

describe('createDataProvider signal-derived entry data', () => {
  it('fails launch/history/momentum checks when a momentum signal has no prior launch', async () => {
    const provider = createDataProvider(makeMockContainer(), { get: () => null, getActiveCount: () => 0 } as any);

    const data = await provider.getEntryCheckData(makeMomentumSignal({ buyCount: MOMENTUM_MIN_BUYS - 1, windowSeconds: MOMENTUM_WINDOW_SECONDS + 10 }));

    expect(data.launchDetected).toBe(false);
    expect(data.creatorNotBlacklisted).toBe(false);
    expect(data.creatorHistoryAcceptable).toBe(false);
    expect(data.buyCountInWindow).toBe(MOMENTUM_MIN_BUYS - 1);
    expect(data.windowMs).toBe((MOMENTUM_WINDOW_SECONDS + 10) * 1000);
  });

  it('uses launch creator history and runtime creator blacklist', async () => {
    const launch = makeLaunchSignal({ creator });
    const provider = createDataProvider(
      makeMockContainer({ signals: [launch], blacklistedCreators: [creator] }),
      { get: () => null, getActiveCount: () => 0 } as any,
    );

    const data = await provider.getEntryCheckData(makeMomentumSignal({ buyCount: MOMENTUM_MIN_BUYS, windowSeconds: MOMENTUM_WINDOW_SECONDS }));

    expect(data.launchDetected).toBe(true);
    expect(data.creatorNotBlacklisted).toBe(false);
    expect(data.creatorHistoryAcceptable).toBe(true);
    expect(data.buyCountInWindow).toBe(MOMENTUM_MIN_BUYS);
    expect(data.windowMs).toBe(MOMENTUM_WINDOW_MS);
  });

  it('rejects creator history when the same creator exceeds the recent launch limit', async () => {
    const signals = Array.from({ length: CREATOR_HISTORY_MAX_LAUNCHES + 1 }, (_value, index) => makeLaunchSignal({
      id: `launch-${index + 1}`,
      creator,
      mint: index === 0 ? mint : new PublicKey(index + 3).toBase58() as MintAddress,
    }));
    const provider = createDataProvider(makeMockContainer({ signals }), { get: () => null, getActiveCount: () => 0 } as any);

    const data = await provider.getEntryCheckData(makeMomentumSignal());

    expect(data.launchDetected).toBe(true);
    expect(data.creatorNotBlacklisted).toBe(true);
    expect(data.creatorHistoryAcceptable).toBe(false);
  });
});
