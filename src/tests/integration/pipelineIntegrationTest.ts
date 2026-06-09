/**
 * Full Pipeline Integration Test
 *
 * Tests the complete flow: detect → filter → decide → execute (mock)
 * All external dependencies are mocked. No Redis, Postgres, or RPC needed.
 *
 * This validates that all layers wire together correctly:
 *   1. Signal arrives (mock detector)
 *   2. Strategy evaluates entry (all 9 checks)
 *   3. Execution mock simulates buy
 *   4. Exit monitor triggers (TP/SL/timeout)
 *   5. Execution mock simulates sell
 *   6. P&L is tracked
 */

import type { MintAddress } from '../../core/types/token.js';
import type { Signal, MomentumSignal } from '../../core/types/signal.js';
import type { EntryCheckData, EntryDecisionResult } from '../../strategies/filteredSniper/entryDecision.js';
import type { PositionData, ExitReason } from '../../strategies/filteredSniper/exitDecision.js';
import type {
  StrategyDataProvider,
  StrategyExecutionDelegate,
  BuyParams,
  BuyResult,
  SellParams,
  SellResult,
} from '../../strategies/filteredSniper/filteredSniperStrategy.js';
import { FilteredSniperStrategy } from '../../strategies/filteredSniper/filteredSniperStrategy.js';
import {
  MAX_CONCURRENT_POSITIONS,
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_SECONDS,
  STOP_LOSS_PERCENT,
  TAKE_PROFIT_PERCENT,
  TIMEOUT_MS,
} from '../../strategies/filteredSniper/filteredSniperRules.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('integration:pipelineTest');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Integration test result */
export interface PipelineTestResult {
  readonly passed: boolean;
  readonly testsRun: number;
  readonly testsPassed: number;
  readonly testsFailed: number;
  readonly results: readonly TestCaseResult[];
  readonly durationMs: number;
}

/** Individual test case result */
export interface TestCaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Mock Data Provider
// ---------------------------------------------------------------------------

/**
 * Mock data provider that returns configurable entry check data.
 */
export class MockDataProvider implements StrategyDataProvider {
  private entryCheckData: Map<string, EntryCheckData> = new Map();
  private positionData: Map<string, PositionData> = new Map();
  private activePositionCount = 0;

  setEntryCheckData(mint: MintAddress, data: EntryCheckData): void {
    this.entryCheckData.set(mint, data);
  }

  setPositionData(tradeId: string, data: PositionData): void {
    this.positionData.set(tradeId, data);
  }

  setActivePositionCount(count: number): void {
    this.activePositionCount = count;
  }

  async getEntryCheckData(signal: Signal): Promise<EntryCheckData> {
    const data = this.entryCheckData.get(signal.mint);
    if (data === undefined) {
      throw new Error(`No mock entry check data for mint: ${signal.mint}`);
    }
    return data;
  }

  async getPositionData(tradeId: string): Promise<PositionData | null> {
    return this.positionData.get(tradeId) ?? null;
  }

  getActivePositionCount(): number {
    return this.activePositionCount;
  }

  isTokenBlacklisted(_mint: string): boolean {
    return false;
  }

  startAntiRugMonitoring(_mint: string): void {}
  stopAntiRugMonitoring(_mint: string): void {}
}

// ---------------------------------------------------------------------------
// Mock Execution Delegate
// ---------------------------------------------------------------------------

/**
 * Mock execution delegate that records all buy/sell calls.
 */
export class MockExecutionDelegate implements StrategyExecutionDelegate {
  readonly buyHistory: BuyParams[] = [];
  readonly sellHistory: SellParams[] = [];
  private nextBuyResult: BuyResult = {
    success: true,
    tradeId: 'mock-trade-001',
    signature: 'mock-sig-buy-001',
    error: null,
  };
  private nextSellResult: SellResult = {
    success: true,
    signature: 'mock-sig-sell-001',
    error: null,
  };

  setNextBuyResult(result: BuyResult): void {
    this.nextBuyResult = result;
  }

  setNextSellResult(result: SellResult): void {
    this.nextSellResult = result;
  }

  async executeBuy(params: BuyParams): Promise<BuyResult> {
    this.buyHistory.push(params);
    logger.info('Mock buy executed', {
      mint: params.mint,
      venue: params.venue,
      positionSizeUsd: params.positionSizeUsd,
    });
    return this.nextBuyResult;
  }

  async executeSell(params: SellParams): Promise<SellResult> {
    this.sellHistory.push(params);
    logger.info('Mock sell executed', {
      tradeId: params.tradeId,
      mint: params.mint,
      reason: params.reason,
    });
    return this.nextSellResult;
  }
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeMomentumSignal(mint: MintAddress): MomentumSignal {
  return {
    id: `momentum-${mint}`,
    type: 'MOMENTUM',
    mint,
    timestamp: Date.now(),
    slot: 1,
    buyCount: MOMENTUM_MIN_BUYS,
    windowSeconds: MOMENTUM_WINDOW_SECONDS,
    volumeSol: MOMENTUM_MIN_VOLUME_LAMPORTS,
  };
}

/** Create entry check data where all 9 checks pass. */
export function createPassingEntryData(mint: MintAddress): EntryCheckData {
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
    volumeLamports: 15_000_000_000n,
    windowMs: MOMENTUM_WINDOW_SECONDS * 1000,
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
  };
}

/** Create entry check data where one specific check fails. */
export function createFailingEntryData(
  mint: MintAddress,
  failCheck: keyof Omit<EntryCheckData, 'mint' | 'buyCountInWindow' | 'volumeLamports' | 'windowMs'>,
): EntryCheckData {
  const passing = createPassingEntryData(mint);
  return {
    ...passing,
    [failCheck]: false,
  };
}

// ---------------------------------------------------------------------------
// Pipeline Integration Tests
// ---------------------------------------------------------------------------

/**
 * Run all pipeline integration tests.
 */
export async function runPipelineTests(): Promise<PipelineTestResult> {
  const startTime = Date.now();
  const results: TestCaseResult[] = [];

  // Test 1: Full entry flow — all checks pass → buy executed
  results.push(await testFullEntryFlow());

  // Test 2: Entry rejected — creator blacklisted
  results.push(await testEntryRejected());

  // Test 3: Max concurrent positions reached
  results.push(await testMaxConcurrentPositions());

  // Test 4: Strategy not running — signals ignored
  results.push(await testStrategyNotRunning());

  // Test 5: Buy execution failure
  results.push(await testBuyExecutionFailure());

  // Test 6: Exit flow — stop loss triggered
  results.push(await testExitStopLoss());

  // Test 7: Exit flow — take profit triggered
  results.push(await testExitTakeProfit());

  // Test 8: Exit flow — timeout triggered
  results.push(await testExitTimeout());

  // Test 9: Exit flow — kill switch
  results.push(await testExitKillSwitch());

  // Test 10: Full lifecycle — entry → monitor → exit
  results.push(await testFullLifecycle());

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  logger.info('Pipeline integration tests complete', {
    total: results.length,
    passed,
    failed,
    durationMs: Date.now() - startTime,
  });

  return {
    passed: failed === 0,
    testsRun: results.length,
    testsPassed: passed,
    testsFailed: failed,
    results,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Individual Tests
// ---------------------------------------------------------------------------

async function testFullEntryFlow(): Promise<TestCaseResult> {
  const name = 'full_entry_flow_all_checks_pass';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();

    const mint = 'TestMint111111111111111111111111111111111111';
    provider.setEntryCheckData(mint, createPassingEntryData(mint));
    provider.setActivePositionCount(0);

    const result = await strategy.onSignal(makeMomentumSignal(mint));

    if (result === null) {
      return { name, passed: false, error: 'Expected non-null result' };
    }
    if (!result.allowed) {
      return { name, passed: false, error: `Expected allowed=true, got failedCount=${result.failedCount}` };
    }
    if (executor.buyHistory.length !== 1) {
      return { name, passed: false, error: `Expected 1 buy, got ${executor.buyHistory.length}` };
    }
    if (executor.buyHistory[0]?.mint !== mint) {
      return { name, passed: false, error: 'Buy mint mismatch' };
    }

    strategy.stop();
    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testEntryRejected(): Promise<TestCaseResult> {
  const name = 'entry_rejected_creator_blacklisted';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();

    const mint = 'TestMint222222222222222222222222222222222222';
    provider.setEntryCheckData(mint, createFailingEntryData(mint, 'creatorNotBlacklisted'));
    provider.setActivePositionCount(0);

    const result = await strategy.onSignal(makeMomentumSignal(mint));

    if (result === null) {
      return { name, passed: false, error: 'Expected non-null result' };
    }
    if (result.allowed) {
      return { name, passed: false, error: 'Expected allowed=false for blacklisted creator' };
    }
    if (executor.buyHistory.length !== 0) {
      return { name, passed: false, error: 'No buy should have been executed' };
    }

    strategy.stop();
    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testMaxConcurrentPositions(): Promise<TestCaseResult> {
  const name = 'max_concurrent_positions_reached';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();

    const mint = 'TestMint333333333333333333333333333333333333';
    provider.setEntryCheckData(mint, createPassingEntryData(mint));
    provider.setActivePositionCount(MAX_CONCURRENT_POSITIONS);

    const result = await strategy.onSignal(makeMomentumSignal(mint));

    if (result !== null) {
      return { name, passed: false, error: 'Expected null (signal should be ignored)' };
    }
    if (executor.buyHistory.length !== 0) {
      return { name, passed: false, error: 'No buy should have been executed' };
    }

    strategy.stop();
    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testStrategyNotRunning(): Promise<TestCaseResult> {
  const name = 'strategy_not_running_signals_ignored';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();
    const strategy = new FilteredSniperStrategy(provider, executor);
    // Don't call start()

    const mint = 'TestMint444444444444444444444444444444444444';
    provider.setEntryCheckData(mint, createPassingEntryData(mint));
    provider.setActivePositionCount(0);

    const result = await strategy.onSignal(makeMomentumSignal(mint));

    if (result !== null) {
      return { name, passed: false, error: 'Expected null when strategy not running' };
    }

    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testBuyExecutionFailure(): Promise<TestCaseResult> {
  const name = 'buy_execution_failure';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();
    executor.setNextBuyResult({
      success: false,
      tradeId: null,
      signature: null,
      error: 'Mock execution failure',
    });
    const strategy = new FilteredSniperStrategy(provider, executor);
    strategy.start();

    const mint = 'TestMint555555555555555555555555555555555555';
    provider.setEntryCheckData(mint, createPassingEntryData(mint));
    provider.setActivePositionCount(0);

    const result = await strategy.onSignal(makeMomentumSignal(mint));

    if (result === null) {
      return { name, passed: false, error: 'Expected non-null result' };
    }
    if (!result.allowed) {
      return { name, passed: false, error: 'Entry should be allowed (failure is in execution)' };
    }
    if (executor.buyHistory.length !== 1) {
      return { name, passed: false, error: 'Buy should have been attempted' };
    }

    strategy.stop();
    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testExitStopLoss(): Promise<TestCaseResult> {
  const name = 'exit_stop_loss_triggered';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();

    const mint = 'TestMintSL6666666666666666666666666666666666';
    const tradeId = 'trade-sl-001';

    // Set position data: entry 1000, current 700 → -30% (current locked SL)
    provider.setPositionData(tradeId, {
      mint,
      tradeId,
      entryPriceLamports: 1000n,
      currentPriceLamports: BigInt(1000 + (1000 * STOP_LOSS_PERCENT) / 100),
      openedAt: Date.now() - 60_000, // 1 min ago
      killSwitchActive: false,
    });

    const { evaluateExit } = await import('../../strategies/filteredSniper/exitDecision.js');
    const exitResult = evaluateExit({
      mint,
      tradeId,
      entryPriceLamports: 1000n,
      currentPriceLamports: BigInt(1000 + (1000 * STOP_LOSS_PERCENT) / 100),
      openedAt: Date.now() - 60_000,
      killSwitchActive: false,
    });

    if (!exitResult.shouldExit) {
      return { name, passed: false, error: 'Expected exit to be triggered' };
    }
    if (exitResult.reason !== 'STOP_LOSS') {
      return { name, passed: false, error: `Expected STOP_LOSS (${STOP_LOSS_PERCENT}%), got ${exitResult.reason}` };
    }

    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testExitTakeProfit(): Promise<TestCaseResult> {
  const name = 'exit_take_profit_triggered';
  try {
    const { evaluateExit } = await import('../../strategies/filteredSniper/exitDecision.js');
    const mint = 'TestMintTP7777777777777777777777777777777777';

    // Entry 1000, current 1500 → +50% (current locked TP)
    const exitResult = evaluateExit({
      mint,
      tradeId: 'trade-tp-001',
      entryPriceLamports: 1000n,
      currentPriceLamports: BigInt(1000 + (1000 * TAKE_PROFIT_PERCENT) / 100),
      openedAt: Date.now() - 60_000,
      killSwitchActive: false,
      scaleOutTiersCompleted: [0, 1, 2], // All scale-out tiers done
    });

    if (!exitResult.shouldExit) {
      return { name, passed: false, error: 'Expected exit to be triggered' };
    }
    if (exitResult.reason !== 'TAKE_PROFIT') {
      return { name, passed: false, error: `Expected TAKE_PROFIT (${TAKE_PROFIT_PERCENT}%), got ${exitResult.reason}` };
    }

    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testExitTimeout(): Promise<TestCaseResult> {
  const name = 'exit_timeout_triggered';
  try {
    const { evaluateExit } = await import('../../strategies/filteredSniper/exitDecision.js');
    const mint = 'TestMintTO8888888888888888888888888888888888';

    // Entry 1000, current 1000, opened just past the current locked timeout
    const exitResult = evaluateExit({
      mint,
      tradeId: 'trade-to-001',
      entryPriceLamports: 1000n,
      currentPriceLamports: 1000n,
      openedAt: Date.now() - (TIMEOUT_MS + 1000),
      killSwitchActive: false,
    });

    if (!exitResult.shouldExit) {
      return { name, passed: false, error: 'Expected exit to be triggered' };
    }
    if (exitResult.reason !== 'TIMEOUT') {
      return { name, passed: false, error: `Expected TIMEOUT, got ${exitResult.reason}` };
    }

    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testExitKillSwitch(): Promise<TestCaseResult> {
  const name = 'exit_kill_switch_triggered';
  try {
    const { evaluateExit } = await import('../../strategies/filteredSniper/exitDecision.js');
    const mint = 'TestMintKS9999999999999999999999999999999999';

    // Kill switch active → immediate exit regardless of P&L
    const exitResult = evaluateExit({
      mint,
      tradeId: 'trade-ks-001',
      entryPriceLamports: 1000n,
      currentPriceLamports: 1100n,
      openedAt: Date.now() - 10_000,
      killSwitchActive: true,
    });

    if (!exitResult.shouldExit) {
      return { name, passed: false, error: 'Expected exit to be triggered' };
    }
    if (exitResult.reason !== 'KILL_SWITCH') {
      return { name, passed: false, error: `Expected KILL_SWITCH, got ${exitResult.reason}` };
    }

    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testFullLifecycle(): Promise<TestCaseResult> {
  const name = 'full_lifecycle_entry_to_exit';
  try {
    const provider = new MockDataProvider();
    const executor = new MockExecutionDelegate();
    const strategy = new FilteredSniperStrategy(provider, executor, undefined, 50); // Fast poll
    strategy.start();

    const mint = 'TestMintLC0000000000000000000000000000000000';
    const tradeId = 'mock-trade-001';

    // Setup: all checks pass
    provider.setEntryCheckData(mint, createPassingEntryData(mint));
    provider.setActivePositionCount(0);

    // Entry
    const entryResult = await strategy.onSignal(makeMomentumSignal(mint));
    if (entryResult === null || !entryResult.allowed) {
      strategy.stop();
      return { name, passed: false, error: 'Entry should have been allowed' };
    }
    if (executor.buyHistory.length !== 1) {
      strategy.stop();
      return { name, passed: false, error: `Expected 1 buy, got ${executor.buyHistory.length}` };
    }

    // Setup exit data: stop loss scenario
    provider.setPositionData(tradeId, {
      mint,
      tradeId,
      entryPriceLamports: 1000n,
      currentPriceLamports: BigInt(1000 + (1000 * STOP_LOSS_PERCENT) / 100), // -30%
      openedAt: Date.now() - 60_000,
      killSwitchActive: false,
    });

    // Wait for exit monitor to trigger (poll at 50ms)
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Verify sell was executed
    if (executor.sellHistory.length !== 1) {
      strategy.stop();
      return { name, passed: false, error: `Expected 1 sell, got ${executor.sellHistory.length}` };
    }

    const sell = executor.sellHistory[0];
    if (sell === undefined) {
      strategy.stop();
      return { name, passed: false, error: 'Sell history entry undefined' };
    }
    if (sell.reason !== 'STOP_LOSS') {
      strategy.stop();
      return { name, passed: false, error: `Expected STOP_LOSS reason, got ${sell.reason}` };
    }

    strategy.stop();
    return { name, passed: true, error: null };
  } catch (err: unknown) {
    return { name, passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

