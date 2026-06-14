/**
 * launchParser — Parse Pump.fun token launch events from transaction logs.
 *
 * Structural parsing ONLY — no strategy decisions.
 * Adapter layer: protocol integration, no business logic.
 */

import { PublicKey } from '@solana/web3.js';
import type { LaunchEvent as PumpfunLaunchEvent } from '../../../core/types/signal.js';
import { createLogger } from '../../../telemetry/logging/logger.js';
import {
  PROGRAM_DATA_PREFIX,
  CREATE_INSTRUCTION_LOG,
  CREATE_INSTRUCTION_LOG_V2,
  readBorshString,
  readPublicKey,
  readU64LE,
} from './shared.js';

const logger = createLogger('adapters:pumpfun:launchParser');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Log line emitted by the Pump.fun program when a new token is created.
 * Source: observed from on-chain Pump.fun transaction logs.
 */
// CREATE_INSTRUCTION_LOG imported from ./shared.ts

/**
 * Prefix for Pump.fun program data log lines that contain event payloads.
 * The Pump.fun program emits structured data after the instruction log.
 */
// PROGRAM_DATA_PREFIX imported from ./shared.ts

/**
 * Prefix for general program log lines.
 */
const PROGRAM_LOG_PREFIX = 'Program log: ';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a JSON object from a log line that starts with
 * 'Program log: ' and contains JSON-like structured data.
 *
 * Returns null if the line doesn't contain valid JSON.
 */
function tryParseJsonLogLine(line: string): Record<string, unknown> | null {
  const jsonStart = line.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }
  try {
    const jsonStr = line.slice(jsonStart);
    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to decode a base64-encoded program data log line.
 * Pump.fun emits event data as base64 after 'Program data: ' prefix.
 *
 * The create event layout (observed from Pump.fun):
 * - 8 bytes: event discriminator
 * - 32 bytes: mint pubkey
 * - 32 bytes: bonding curve pubkey
 * - 32 bytes: creator pubkey
 * - 4 bytes + N bytes: name (borsh string: u32 length prefix + utf8)
 * - 4 bytes + N bytes: symbol (borsh string)
 * - 4 bytes + N bytes: uri (borsh string)
 *
 * @returns Partial event data or null if decoding fails.
 */
function tryDecodeBase64EventData(
  base64Data: string,
): { mint: string; creator: string; name: string; symbol: string; uri: string } | null {
  try {
    const buf = Buffer.from(base64Data, 'base64');

    // Minimum: 8 (disc) + 32 (mint) + 32 (bonding) + 32 (creator) + 3*(4+1) = 119
    const MIN_EVENT_LEN = 119;
    if (buf.length < MIN_EVENT_LEN) {
      return null;
    }

    // Skip 8-byte event discriminator.
    let offset = 8;

    // Read mint pubkey (32 bytes).
    const mintBytes = buf.subarray(offset, offset + 32);
    offset += 32;

    // Skip bonding curve pubkey (32 bytes).
    offset += 32;

    // Read creator pubkey (32 bytes).
    const creatorBytes = buf.subarray(offset, offset + 32);
    offset += 32;

    // Read borsh string: name.
    const nameResult = readBorshString(buf, offset);
    if (nameResult === null) return null;
    const name = nameResult.value;
    offset += nameResult.bytesRead;

    // Read borsh string: symbol.
    const symbolResult = readBorshString(buf, offset);
    if (symbolResult === null) return null;
    const symbol = symbolResult.value;
    offset += symbolResult.bytesRead;

    // Read borsh string: uri.
    const uriResult = readBorshString(buf, offset);
    if (uriResult === null) return null;
    const uri = uriResult.value;

    // Convert bytes to base58 using the top-level imported PublicKey.
    const mint = new PublicKey(mintBytes).toBase58();
    const creator = new PublicKey(creatorBytes).toBase58();

    return { mint, creator, name, symbol, uri };
  } catch {
    return null;
  }
}

// readBorshString imported from ./shared.ts

/**
 * Decode a Pump.fun CreateV2 program data payload.
 *
 * CreateV2 layout (verified from Pump.fun IDL — see
 * node_modules/@pump-fun/pump-sdk/src/idl/pump.ts createEvent struct):
 *   Offset  0-7  : event discriminator (8 bytes, skip)
 *   Offset  8-?  : name  (borsh string: u32 length + utf8)
 *   Offset  ?-?  : symbol (borsh string)
 *   Offset  ?-?  : uri    (borsh string)
 *   Offset  ?-?  : mint   (32 bytes pubkey)
 *   Offset  ?-?  : bondingCurve (32 bytes pubkey)
 *   Offset  ?-?  : user    (32 bytes pubkey)
 *   Offset  ?-?  : creator (32 bytes pubkey)
 *   Offset  ?-?  : timestamp (i64 LE, 8 bytes)
 *   Offset  ?-?  : virtualTokenReserves (u64 LE, 8 bytes)
 *   Offset  ?-?  : virtualSolReserves   (u64 LE, 8 bytes)
 *   Offset  ?-?  : realTokenReserves    (u64 LE, 8 bytes)
 *   Offset  ?-?  : tokenTotalSupply     (u64 LE, 8 bytes)
 *   Offset  ?-?  : tokenProgram         (32 bytes pubkey)
 *   Offset  ?-?  : isMayhemMode         (u8)
 *   Offset  ?-?  : isCashbackEnabled    (u8)
 *   Offset  ?-?  : quoteMint            (32 bytes pubkey)
 *   Offset  ?-?  : virtualQuoteReserves (u64 LE, 8 bytes)
 *
 * Min length: 8 (disc) + 3*(4+1) + 5*32 + 6*8 + 1 + 1 = 233 bytes.
 */
function tryDecodeCreateV2EventData(
  base64Data: string,
): {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
} | null {
  try {
    const buf = Buffer.from(base64Data, 'base64');

    // 8 disc + 3*(4+1) min strings + 5*32 pubkeys + 6*8 u64s + 2 bools
    const MIN_EVENT_LEN = 8 + 15 + 160 + 48 + 2;
    if (buf.length < MIN_EVENT_LEN) {
      return null;
    }

    let offset = 8; // skip discriminator

    // Strings: name, symbol, uri
    const nameResult = readBorshString(buf, offset);
    if (nameResult === null) return null;
    offset += nameResult.bytesRead;
    const symbolResult = readBorshString(buf, offset);
    if (symbolResult === null) return null;
    offset += symbolResult.bytesRead;
    const uriResult = readBorshString(buf, offset);
    if (uriResult === null) return null;
    offset += uriResult.bytesRead;

    // Pubkeys: mint, bondingCurve, user, creator
    if (offset + 4 * 32 > buf.length) return null;
    const mint = readPublicKey(buf, offset).toBase58();
    offset += 32;
    offset += 32; // skip bondingCurve (we derive it on demand)
    offset += 32; // skip user
    const creator = readPublicKey(buf, offset).toBase58();
    offset += 32;

    // Numerics we care about: virtualTokenReserves, virtualSolReserves
    if (offset + 8 + 8 > buf.length) return null;
    offset += 8; // skip timestamp (i64)
    const virtualTokenReserves = readU64LE(buf, offset);
    offset += 8;
    const virtualSolReserves = readU64LE(buf, offset);
    // remaining fields (realTokenReserves, tokenTotalSupply, tokenProgram,
    // isMayhemMode, isCashbackEnabled, quoteMint, virtualQuoteReserves)
    // are not needed for downstream launch detection — skip.

    return {
      mint,
      creator,
      name: nameResult.value,
      symbol: symbolResult.value,
      uri: uriResult.value,
      virtualSolReserves,
      virtualTokenReserves,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a Pump.fun token launch event from transaction log lines.
 *
 * Looks for the 'Instruction: Create' log emitted by the Pump.fun program,
 * then attempts to extract mint, creator, name, symbol, and uri from
 * subsequent log lines (either JSON or base64-encoded program data).
 *
 * @param logs      - Readonly array of transaction log lines.
 * @param slot      - Slot number of the transaction.
 * @param signature - Transaction signature.
 * @returns Parsed {@link PumpfunLaunchEvent} or `null` if not a launch tx.
 */
export function parseLaunchFromLogs(
  logs: readonly string[],
  slot: number,
  signature: string,
): PumpfunLaunchEvent | null {
  // Step 1: Find the 'Instruction: Create(V2)' log line.
  // CreateV2 (current default) must be checked first because
  // 'Instruction: Create' is a substring of 'Instruction: CreateV2'.
  let createIndex = -1;
  let isV2 = false;
  for (let i = 0; i < logs.length; i++) {
    const line = logs[i];
    if (line === undefined) continue;
    if (line === CREATE_INSTRUCTION_LOG_V2) {
      createIndex = i;
      isV2 = true;
      break;
    }
    if (line === CREATE_INSTRUCTION_LOG) {
      createIndex = i;
      break;
    }
  }

  if (createIndex === -1) {
    // Not a Pump.fun create transaction.
    return null;
  }

  logger.debug('Found Pump.fun Create instruction log', {
    slot,
    signature,
    logIndex: createIndex,
    variant: isV2 ? 'V2' : 'legacy',
  });

  // Step 2: Scan subsequent log lines for event data.
  // Strategy A: Look for base64-encoded 'Program data:' lines.
  for (let i = createIndex + 1; i < logs.length; i++) {
    const line = logs[i];
    if (line === undefined) continue;

    // Check for base64 program data.
    if (line.startsWith(PROGRAM_DATA_PREFIX)) {
      const base64Data = line.slice(PROGRAM_DATA_PREFIX.length).trim();

      // Try V2 layout first when this is a CreateV2 instruction
      // (V2 is the current Pump.fun default; legacy is only kept as fallback
      // for the rare case that V2 borsh parsing fails on a malformed tx).
      const decoded = isV2
        ? tryDecodeCreateV2EventData(base64Data) ?? tryDecodeBase64EventData(base64Data)
        : tryDecodeBase64EventData(base64Data) ?? tryDecodeCreateV2EventData(base64Data);
      if (decoded) {
        logger.info('Parsed Pump.fun launch event from program data', {
          mint: decoded.mint,
          creator: decoded.creator,
          name: decoded.name,
          symbol: decoded.symbol,
          slot,
          signature,
        });

        return {
          mint: decoded.mint,
          creator: decoded.creator,
          name: decoded.name,
          symbol: decoded.symbol,
          uri: decoded.uri,
          slot,
          signature,
          timestamp: Date.now(),
        };
      }
    }

    // Strategy B: Look for JSON-like log lines.
    if (line.startsWith(PROGRAM_LOG_PREFIX)) {
      const jsonData = tryParseJsonLogLine(line);
      if (jsonData) {
        const mint = typeof jsonData['mint'] === 'string' ? jsonData['mint'] : undefined;
        const creator = typeof jsonData['creator'] === 'string' ? jsonData['creator'] : undefined;
        const name = typeof jsonData['name'] === 'string' ? jsonData['name'] : undefined;
        const symbol = typeof jsonData['symbol'] === 'string' ? jsonData['symbol'] : undefined;
        const uri = typeof jsonData['uri'] === 'string' ? jsonData['uri'] : undefined;

        if (mint && creator && name !== undefined && symbol !== undefined && uri !== undefined) {
          logger.info('Parsed Pump.fun launch event from JSON log', {
            mint,
            creator,
            name,
            symbol,
            slot,
            signature,
          });

          return {
            mint,
            creator,
            name,
            symbol,
            uri,
            slot,
            signature,
            timestamp: Date.now(),
          };
        }
      }
    }
  }

  logger.debug('Found Create instruction but could not parse event data', {
    slot,
    signature,
    totalLogs: logs.length,
  });

  return null;
}
