import { describe, it, expect, vi } from 'vitest';
import {
  MaxExposureGuard,
  type PositionProvider,
} from '../../../risk/exposure/maxExposureGuard.js';

function mockProvider(count: number, exposure = 0n): PositionProvider {
  return {
    getOpenPositionCount: vi.fn().mockResolvedValue(count),
    getTotalExposureLamports: vi.fn().mockResolvedValue(exposure),
  };
}

describe('MaxExposureGuard', () => {
  it('allows when no positions open', async () => {
    const guard = new MaxExposureGuard(mockProvider(0));
    const result = await guard.canOpenPosition();

    expect(result.allowed).toBe(true);
    expect(result.currentPositions).toBe(0);
    expect(result.maxPositions).toBe(2); // DEFAULT_MAX_CONCURRENT_POSITIONS (user config 2026-06-23)
    expect(result.reason).toBeNull();
  });

  it('blocks when max positions reached', async () => {
    const guard = new MaxExposureGuard(mockProvider(2));
    const result = await guard.canOpenPosition();

    expect(result.allowed).toBe(false);
    expect(result.currentPositions).toBe(2);
    expect(result.reason).toContain('Max concurrent positions reached');
  });

  it('blocks when over max positions', async () => {
    const guard = new MaxExposureGuard(mockProvider(3));
    const result = await guard.canOpenPosition();

    expect(result.allowed).toBe(false);
  });

  it('accepts custom max positions config', async () => {
    const guard = new MaxExposureGuard(mockProvider(2), { maxConcurrentPositions: 3 });
    const result = await guard.canOpenPosition();

    expect(result.allowed).toBe(true);

    const guard2 = new MaxExposureGuard(mockProvider(3), { maxConcurrentPositions: 3 });
    const blocked = await guard2.canOpenPosition();
    expect(blocked.allowed).toBe(false);
  });

  it('returns correct maxPositions value', async () => {
    const guard = new MaxExposureGuard(mockProvider(0));
    const result = await guard.canOpenPosition();
    expect(result.maxPositions).toBe(2);
  });

  it('getExposure() returns current state', async () => {
    const guard = new MaxExposureGuard(mockProvider(1, 100_000_000n));
    const state = await guard.getExposure();

    expect(state.openPositionCount).toBe(1);
    expect(state.totalExposureLamports).toBe(100_000_000n);
  });
});
