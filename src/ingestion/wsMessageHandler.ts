/**
 * WebSocket Message Handler
 *
 * Parses raw Helius WebSocket messages, decodes events from logs,
 * and routes them through the normalizer → dispatcher pipeline.
 *
 * Supports TWO programs:
 *   - Pump.fun (PumpFun) — event decoding from program data
 *   - Raydium LaunchLab (BonkFun) — initialize detection via tx fetch
 *
 * Pure ingestion logic — no business decisions here.
 */

import type { Connection } from '@solana/web3.js';
import { decodeEventFromLogs } from '../adapters/protocols/pumpfun/eventDecoder.js';
import { parseLaunchFromLogs } from '../adapters/protocols/pumpfun/launchParser.js';
import {
  isLaunchLabInitializeCandidate,
  verifyAndParseLaunchLabTx,
  isLaunchLabBuyExactIn,
  isLaunchLabSellExactIn,
  extractMintFromLaunchLabTx,
} from '../adapters/protocols/bonkfun/launchLabParser.js';
import type { RawEvent } from './pipeline/eventNormalizer.js';
import type { EventNormalizer } from './pipeline/eventNormalizer.js';
import type { EventDispatcher } from './pipeline/eventDispatcher.js';
import { nowMs } from '../core/utils/time.js';
import { createLogger } from '../telemetry/logging/logger.js';
import {
  PUMPFUN_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
} from '../core/constants/programs.js';

const logger = createLogger('ingestion:wsMessageHandler');

// Cached program ID strings for fast log comparison
const LAUNCHLAB_PROGRAM_ID_STR = RAYDIUM_LAUNCHLAB_PROGRAM_ID.toBase58();

/**
 * Handle a raw WebSocket message from Helius.
 *
 * Flow:
 *   1. Parse JSON-RPC notification → extract logs, slot, signature
 *   2. Check if logs are from LaunchLab program → handle BonkFun
 *   3. Otherwise, try PumpFun event decoding
 *
 * @param raw        - Raw message buffer/string from the WebSocket.
 * @param normalizer - EventNormalizer instance for transforming raw events.
 * @param dispatcher - EventDispatcher instance for routing events to detectors.
 * @param connection - Solana RPC connection (for tx fetching on LaunchLab detection).
 */
export async function handleWsMessage(
  raw: string,
  normalizer: EventNormalizer,
  dispatcher: EventDispatcher,
  connection: Connection,
  source: 'pumpfun' | 'launchlab' = 'pumpfun',
): Promise<void> {
  try {
    const message = JSON.parse(raw) as Record<string, unknown>;
    const params = message['params'] as Record<string, unknown> | undefined;
    if (!params) return;
    const result = params['result'] as Record<string, unknown> | undefined;
    if (!result) return;
    const value = result['value'] as Record<string, unknown> | undefined;
    if (!value) return;
    const logs = value['logs'] as string[] | undefined;
    const slot = (result['context'] as Record<string, unknown>)?.['slot'] as number ?? 0;
    const signature = value['signature'] as string ?? '';
    if (!logs || logs.length === 0) return;

    // ── Step 1: Check if this is a LaunchLab (BonkFun) transaction ──────
    const isLaunchLab = logs.some(l => l.includes(LAUNCHLAB_PROGRAM_ID_STR));

    // ── Step 0: If message from LaunchLab WS, ONLY process initialize ──
    // Non-initialize LaunchLab messages (buy/sell/trade) must not fall through to PumpFun decoder
    if (source === 'launchlab' && !isLaunchLab) {
      // Helius mentions filter delivered a tx that doesn't have LaunchLab program ID in logs
      return;
    }

    if (isLaunchLab) {
      const isCandidate = isLaunchLabInitializeCandidate(logs);


      if (isCandidate) {
        logger.info('LaunchLab initialize candidate detected', {
          signature: signature.slice(0, 16),
          slot,
        });

        // Async: fetch tx to verify platform_config and extract mint
        const launchEvent = await verifyAndParseLaunchLabTx(signature, slot, connection);

        if (launchEvent) {
          logger.info('BonkFun launch confirmed — dispatching', {
            mint: launchEvent.mint,
            creator: launchEvent.creator,
            slot,
          });

          const rawEvent: RawEvent = {
            source: 'helius-ws',
            type: 'launch',
            data: { ...launchEvent, signature },
            receivedAt: nowMs(),
            slot,
          };
          const normalizedEvent = normalizer.normalize(rawEvent);
          void dispatcher.dispatch(normalizedEvent);
        }
        return;  // Don't also try PumpFun decoding
      }

      // LaunchLab logs but not an initialize — check if buy/sell trade
      const isBuyTrade = isLaunchLabBuyExactIn(logs);
      const isSellTrade = isLaunchLabSellExactIn(logs);


      if (isBuyTrade || isSellTrade) {
        // Dispatch trade event for momentum tracking
        const mint = await extractMintFromLaunchLabTx(signature, connection);
        if (mint) {
          const rawEvent: RawEvent = {
            source: 'helius-ws',
            type: 'trade',
            data: { mint, isBuy: isBuyTrade, signature },
            receivedAt: nowMs(),
            slot,
          };
          const normalizedEvent = normalizer.normalize(rawEvent);
          void dispatcher.dispatch(normalizedEvent);
        }
        return;
      }

      // Other LaunchLab instructions (ClaimPlatformFee, etc.) — skip
      logger.debug('LaunchLab logs not trade or initialize — skipping', {
        signature: signature.slice(0, 16),
      });
      return;
    }

    // ── Step 2: PumpFun event decoding (existing flow) ──────────────────
    const decoded = decodeEventFromLogs(logs, slot, signature);
    if (!decoded) {
      const pfId = PUMPFUN_PROGRAM_ID.toBase58();
      const hasPf = logs.some(l => l.includes(pfId));
      if (hasPf) {
        logger.debug('Pump.fun logs not decoded', { logCount: logs.length, sample: logs.slice(0, 5) });
      }
      return;
    }

    logger.info('Event decoded', { type: decoded.type, slot, signature: signature.slice(0, 12) });

    let dispatchType: string;
    let eventData: Record<string, unknown> = { ...decoded.data, signature };
    switch (decoded.type) {
      case 'CREATE': {
        dispatchType = 'launch';
        const launch = parseLaunchFromLogs(logs, slot, signature);
        if (launch !== null) {
          eventData = { ...eventData, ...launch };
        }
        break;
      }
      case 'BUY':
      case 'SELL':
        dispatchType = 'trade';
        eventData['isBuy'] = decoded.type === 'BUY';
        break;
      case 'MIGRATE':
        dispatchType = 'migration';
        eventData['logs'] = logs;
        break;
      default: return;
    }

    const rawEvent: RawEvent = {
      source: 'helius-ws', type: dispatchType, data: eventData,
      receivedAt: nowMs(), slot,
    };
    const normalizedEvent = normalizer.normalize(rawEvent);
    logger.info('Dispatching event', { type: normalizedEvent.type, mint: normalizedEvent.mint?.slice(0, 8) });
    void dispatcher.dispatch(normalizedEvent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error processing WebSocket message', { error: msg });
  }
}
