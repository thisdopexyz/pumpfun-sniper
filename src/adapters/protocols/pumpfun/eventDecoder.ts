/**
 * Pump.fun Program Event Decoder
 *
 * Decodes Pump.fun program events from transaction log data.
 * Supports CREATE, BUY, SELL, and MIGRATE event types.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import type { MintAddress } from '../../../core/types/token.js';
import { createLogger } from '../../../telemetry/logging/logger.js';
import {
  readU64LE,
  readPublicKey,
  PROGRAM_DATA_PREFIX,
} from './shared.js';

const logger = createLogger('pumpfun:eventDecoder');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PumpfunEventType = 'CREATE' | 'BUY' | 'SELL' | 'MIGRATE';

export interface PumpfunDecodedEvent {
  readonly type: PumpfunEventType;
  readonly data: Record<string, unknown>;
  readonly slot: number;
  readonly signature: string;
}

export interface PumpfunBuyEvent {
  readonly mint: MintAddress;
  readonly buyer: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
}

export interface PumpfunSellEvent {
  readonly mint: MintAddress;
  readonly seller: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Log patterns used to identify Pump.fun instruction types */
const INSTRUCTION_LOG_PATTERNS: ReadonlyMap<string, PumpfunEventType> = new Map([
  ['Program log: Instruction: CreateV2', 'CREATE'],
  ['Program log: Instruction: Create', 'CREATE'],
  ['Program log: Instruction: Buy', 'BUY'],
  ['Program log: Instruction: Sell', 'SELL'],
  ['Program log: Instruction: Migrate', 'MIGRATE'],
]);

// PROGRAM_DATA_PREFIX imported from ./shared.ts

/**
 * Minimum byte length for a valid trade event buffer.
 *
 * Trade event data layout (BUY / SELL) — verified from Pump.fun on-chain logs:
 *   Offset  0-7  : discriminator (8 bytes)
 *   Offset  8-39 : mint (32 bytes, PublicKey)
 *   Offset 40-47 : solAmount (u64 LE)
 *   Offset 48-55 : tokenAmount (u64 LE)
 *   Offset 56    : isBuy (u8)
 *   Offset 57-88 : user (32 bytes, PublicKey)
 *   Offset 89-96 : virtualSolReserves (u64 LE)
 *   Offset 97-104: virtualTokenReserves (u64 LE)
 */
const TRADE_EVENT_MIN_BYTES = 105;

// Byte offsets into the trade event buffer
const OFFSET_MINT = 8;
const OFFSET_SOL_AMOUNT = 40;
const OFFSET_TOKEN_AMOUNT = 48;
const OFFSET_IS_BUY = 56;
const OFFSET_USER = 57;
const OFFSET_VIRTUAL_SOL_RESERVES = 89;
const OFFSET_VIRTUAL_TOKEN_RESERVES = 97;

// PUBKEY_LENGTH imported from ./shared.ts

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// readU64LE imported from ./shared.ts

// readPublicKey imported from ./shared.ts

/**
 * Extract the first base64-encoded program data payload from the log lines
 * that appear *after* the instruction identification line.
 */
function extractProgramDataBase64(
  logs: readonly string[],
  instructionLogIndex: number,
): string | null {
  for (let i = instructionLogIndex + 1; i < logs.length; i++) {
    const line = logs[i];
    if (line === undefined) continue;
    if (line.startsWith(PROGRAM_DATA_PREFIX)) {
      return line.slice(PROGRAM_DATA_PREFIX.length).trim();
    }
  }
  return null;
}

/**
 * Parse a trade event (BUY or SELL) from a base64-encoded event buffer.
 */
function parseTradeEvent(
  base64Data: string,
): { isBuy: boolean; event: PumpfunBuyEvent | PumpfunSellEvent } | null {
  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.length < TRADE_EVENT_MIN_BYTES) {
    logger.warn('Trade event buffer too short', {
      expected: TRADE_EVENT_MIN_BYTES,
      actual: buffer.length,
    });
    return null;
  }

  // Skip discriminator bytes (8 bytes at offset 0) — already validated by
  // event type detection from instruction log patterns above.

  const mint = readPublicKey(buffer, OFFSET_MINT).toBase58();
  const solAmount = readU64LE(buffer, OFFSET_SOL_AMOUNT);
  const tokenAmount = readU64LE(buffer, OFFSET_TOKEN_AMOUNT);
  const isBuy = buffer.readUInt8(OFFSET_IS_BUY) === 1;
  const user = readPublicKey(buffer, OFFSET_USER).toBase58();
  const virtualSolReserves = readU64LE(buffer, OFFSET_VIRTUAL_SOL_RESERVES);
  const virtualTokenReserves = readU64LE(buffer, OFFSET_VIRTUAL_TOKEN_RESERVES);

  if (isBuy) {
    const buyEvent: PumpfunBuyEvent = {
      mint,
      buyer: user,
      solAmount,
      tokenAmount,
      virtualSolReserves,
      virtualTokenReserves,
    };
    return { isBuy: true, event: buyEvent };
  }

  const sellEvent: PumpfunSellEvent = {
    mint,
    seller: user,
    solAmount,
    tokenAmount,
    virtualSolReserves,
    virtualTokenReserves,
  };
  return { isBuy: false, event: sellEvent };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a Pump.fun program event from transaction log lines.
 *
 * Scans logs for known instruction patterns, then parses the subsequent
 * Program data: line for trade events (BUY / SELL).
 *
 * @returns The decoded event, or null for unrecognized / unparseable events.
 */
export function decodeEventFromLogs(
  logs: readonly string[],
  slot: number,
  signature: string,
): PumpfunDecodedEvent | null {
  let detectedType: PumpfunEventType | null = null;
  let instructionLogIndex = -1;

  for (let i = 0; i < logs.length; i++) {
    const line = logs[i];
    if (line === undefined) continue;

    for (const [pattern, eventType] of INSTRUCTION_LOG_PATTERNS) {
      if (line === pattern) {
        detectedType = eventType;
        instructionLogIndex = i;
        break;
      }
    }
    if (detectedType !== null) break;
  }

  if (detectedType === null) {
    return null;
  }

  // For CREATE and MIGRATE we return the event type without parsed trade data
  if (detectedType === 'CREATE' || detectedType === 'MIGRATE') {
    logger.debug('Decoded non-trade event', { type: detectedType, slot, signature });
    return {
      type: detectedType,
      data: {},
      slot,
      signature,
    };
  }

  // BUY and SELL: parse the trade event payload
  const base64Data = extractProgramDataBase64(logs, instructionLogIndex);
  if (base64Data === null) {
    logger.warn('No program data found after instruction log', {
      type: detectedType,
      slot,
      signature,
    });
    return null;
  }

  const parsed = parseTradeEvent(base64Data);
  if (parsed === null) {
    return null;
  }

  const eventType: PumpfunEventType = parsed.isBuy ? 'BUY' : 'SELL';

  // Both PumpfunBuyEvent and PumpfunSellEvent have mint field
  const eventMint = parsed.event.mint;

  logger.debug('Decoded trade event', {
    type: eventType,
    mint: eventMint,
    slot,
    signature,
  });

  return {
    type: eventType,
    data: parsed.event as unknown as Record<string, unknown>,
    slot,
    signature,
  };
}
