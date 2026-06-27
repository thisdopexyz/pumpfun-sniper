/**
 * SOL Liquidity Floor Monitor
 *
 * Independent monitor that watches active positions and force-sells
 * any token whose bonding curve SOL reserves drop below threshold.
 *
 * Logic:
 *   - Polls every 10 seconds
 *   - For each active position, reads virtualSolReserves from bonding curve PDA
 *   - If SOL in curve < SOL_FLOOR → executeSell 100% immediately
 *   - No priority ordering, no conditions — SOL floor is absolute
 *
 * Data source: On-chain bonding curve RPC (independent, no dataProvider dependency)
 */

import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import type { PositionRegistry } from '../core/state/positionRegistry.js';
import type { ServiceContainer } from './container.js';
import { deriveBondingCurvePDA, readU64LE, BONDING_CURVE_MIN_LEN } from '../adapters/protocols/pumpfun/shared.js';
import type { SellParams, SellResult } from '../strategies/filteredSniper/filteredSniperStrategy.js';
import type { MintAddress } from '../core/types/token.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('solFloorMonitor');

// ── Constants ───────────────────────────────────────────────────────────────
const SOL_FLOOR = 35;           // Minimum SOL in bonding curve (~$2.5k mcap)
const POLL_INTERVAL_MS = 10_000;
const SLIPPAGE_BPS = 500;
const LAMPORTS_PER_SOL = 1_000_000_000;

// ── Types ───────────────────────────────────────────────────────────────────
interface SolFloorMonitorConfig {
  readonly container: ServiceContainer;
  readonly positionRegistry: PositionRegistry;
  readonly executeSell: (params: SellParams) => Promise<SellResult>;
}

// ── Independent SOL Reserves Fetcher ────────────────────────────────────────

/**
 * Fetch current virtualSolReserves for a PumpFun bonding curve token.
 * Returns SOL amount or null if account not found, graduated, or parse fails.
 */
async function fetchBondingCurveSol(
  connection: Connection,
  mint: MintAddress,
): Promise<number | null> {
  try {
    const mintPk = new PublicKey(mint);
    const pda = deriveBondingCurvePDA(mintPk);
    const account = await connection.getAccountInfo(pda);
    if (!account || account.data.length < BONDING_CURVE_MIN_LEN) return null;

    const buf = account.data;
    // Offset 16-23: virtualSolReserves (u64), offset 48: complete (bool)
    const virtualSolReserves = readU64LE(buf, 16);
    const complete = buf[48] === 1;

    if (complete || virtualSolReserves <= 0n) return null;

    return Number(virtualSolReserves) / LAMPORTS_PER_SOL;
  } catch (err: unknown) {
    logger.debug('SOL reserves fetch failed (will retry next cycle)', {
      mint: mint.slice(0, 12),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

/**
 * Start the SOL liquidity floor monitor.
 * Returns a stop function to clear the interval.
 */
export function startSolFloorMonitor(config: SolFloorMonitorConfig): () => void {
  const { container, positionRegistry, executeSell } = config;
  const connection = container.connection;
  const sellingMints = new Set<string>(); // prevent duplicate sells
  let tickInFlight = false; // prevents overlapping ticks if RPC > POLL_INTERVAL_MS

  const interval = setInterval(() => {
    // Skip if previous tick still in flight — prevents wasted RPC + duplicate
    // force-sell attempts when RPC latency exceeds POLL_INTERVAL_MS.
    if (tickInFlight) return;
    tickInFlight = true;
    (async () => {
    try {
      const activePositions = positionRegistry.getActive();
      if (activePositions.length === 0) return;

      for (const pos of activePositions) {
        if (sellingMints.has(pos.mint)) continue;

        const solInCurve = await fetchBondingCurveSol(connection, pos.mint);
        if (solInCurve === null) continue; // graduated or fetch failed

        if (solInCurve < SOL_FLOOR) {
          logger.warn('SOL FLOOR TRIGGERED — force selling', {
            tradeId: pos.id,
            mint: pos.mint.slice(0, 12),
            solInCurve: solInCurve.toFixed(2),
            floor: SOL_FLOOR,
          });

          sellingMints.add(pos.mint);

          // Fire and forget — don't block the polling loop
          void executeSell({
            tradeId: pos.id,
            mint: pos.mint,
            reason: 'SOL_FLOOR',
            slippageBps: SLIPPAGE_BPS,
            sellPct: 100,
          }).then((result) => {
            if (result.success) {
              logger.info('SOL floor sell executed', {
                tradeId: pos.id,
                mint: pos.mint.slice(0, 12),
                signature: result.signature,
              });
            } else {
              logger.error('SOL floor sell failed', {
                tradeId: pos.id,
                mint: pos.mint.slice(0, 12),
                error: result.error,
              });
            }
          }).catch((err: unknown) => {
            logger.error('SOL floor sell error', {
              tradeId: pos.id,
              mint: pos.mint.slice(0, 12),
              error: err instanceof Error ? err.message : String(err),
            });
          }).finally(() => {
            sellingMints.delete(pos.mint);
          });
        }
      }
    } catch (err: unknown) {
      logger.error('SOL floor monitor tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    })().finally(() => {
      tickInFlight = false;
    });
  }, POLL_INTERVAL_MS);

  logger.info('SOL floor monitor started', {
    floorSol: SOL_FLOOR,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  return () => {
    clearInterval(interval);
    logger.info('SOL floor monitor stopped');
  };
}
