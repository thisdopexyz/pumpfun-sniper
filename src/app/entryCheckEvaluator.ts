/**
 * Entry Check Evaluator — evaluates raw on-chain data into boolean checks.
 *
 * Pure evaluation logic. NO RPC calls, NO DB queries, NO IO.
 * Receives raw data from dataProvider, returns evaluated booleans.
 */

import type { AccountInfo, PublicKey } from '@solana/web3.js';
import type { MintAddress } from '../core/types/token.js';
import type { WalletAddress } from '../core/types/wallet.js';
import type { LaunchSignal } from '../core/types/signal.js';
import { AuthorityInspector } from '../adapters/protocols/pumpfun/authorityInspector.js';
import { parseTokenMetadata, parseBondingCurveData } from '../adapters/protocols/pumpfun/tokenParser.js';
import { parsePoolStateData } from '../adapters/protocols/bonkfun/tokenParser.js';
import { BONKFUN_PLATFORM_CONFIG, MIN_BONKFUN_POOL_STATE_SIZE } from '../core/constants/programs.js';
import {
  DEFAULT_MIN_SOL_RESERVES,
  DEFAULT_MIN_TOKEN_RESERVES,
  DEFAULT_MIN_NAME_LENGTH,
  DEFAULT_MAX_NAME_LENGTH,
  DEFAULT_MIN_SYMBOL_LENGTH,
  DEFAULT_MAX_SYMBOL_LENGTH,
  DEFAULT_METADATA_SCAM_PATTERNS,
  DEFAULT_METADATA_STRUCTURAL_PATTERNS,
  DEFAULT_MAX_WALLET_CONCENTRATION_PCT,
  DEFAULT_WALLET_CONCENTRATION_TOP_N,
} from '../core/constants/defaults.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('evaluator:entryCheck');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Individual evaluators
// ---------------------------------------------------------------------------

/** Check 4+5: Evaluate mint/freeze authority from raw mint account. */
export function evaluateAuthority(
  mint: MintAddress,
  mintAccount: AccountInfo<Buffer> | null,
): { mintAuthorityRevoked: boolean; freezeAuthorityRevoked: boolean } {
  if (mintAccount?.data && mintAccount.data.length >= 82) {
    const authority = AuthorityInspector.parseMintBuffer(mint, mintAccount.data as Buffer);
    logger.debug('Authority evaluated', {
      mint: mint.slice(0, 12),
      dataLength: mintAccount.data.length,
      mintAuthRevoked: authority.mintAuthorityRevoked,
      freezeAuthRevoked: authority.freezeAuthorityRevoked,
    });
    return {
      mintAuthorityRevoked: authority.mintAuthorityRevoked,
      freezeAuthorityRevoked: authority.freezeAuthorityRevoked,
    };
  }
  logger.warn('Mint account not available for authority check', {
    mint: mint.slice(0, 12),
    hasAccount: mintAccount !== null,
    dataLength: mintAccount?.data.length ?? 0,
  });
  return { mintAuthorityRevoked: false, freezeAuthorityRevoked: false };
}

/** Check 7: Evaluate liquidity sanity from raw bonding curve or LaunchLab pool state. */
export function evaluateLiquidity(
  bondingCurveAccount: AccountInfo<Buffer> | null,
  poolStateAccount?: AccountInfo<Buffer> | null,
): { liquiditySane: boolean; bondingCurveCreator: string | null } {
  // PumpFun bonding curve check (existing logic)
  if (bondingCurveAccount?.data && bondingCurveAccount.data.length >= 49) {
    const parsed = parseBondingCurveData(bondingCurveAccount.data);
    if (parsed) {
      const creator = parsed.creator?.toBase58() ?? null;
      const sane = parsed.virtualSolReserves >= DEFAULT_MIN_SOL_RESERVES
        && parsed.virtualTokenReserves >= DEFAULT_MIN_TOKEN_RESERVES
        && !parsed.complete;
      return { liquiditySane: sane, bondingCurveCreator: creator };
    }
  }

  // BonkFun / LaunchLab pool state check
  if (poolStateAccount?.data && poolStateAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
    try {
      const parsed = parsePoolStateData(Buffer.from(poolStateAccount.data));
      if (parsed && parsed.platformConfig.equals(BONKFUN_PLATFORM_CONFIG)) {
        const creator = parsed.creator?.toBase58() ?? null;
        const sane = parsed.realQuote >= DEFAULT_MIN_SOL_RESERVES
          && parsed.realBase >= DEFAULT_MIN_TOKEN_RESERVES
          && !parsed.complete;
        return { liquiditySane: sane, bondingCurveCreator: creator };
      }
    } catch {
      // Parse failed — fall through
    }
  }

  return { liquiditySane: false, bondingCurveCreator: null };
}

/** Check 1: Evaluate launch provenance. */
export function evaluateLaunchProvenance(
  launchSignals: readonly LaunchSignal[],
  liquiditySane: boolean,
  creatorAddress: WalletAddress | null,
): boolean {
  // Require at least one launch signal OR (liquidity sane AND creator exists).
  // Pure fallback was too loose — this requires both conditions.
  return launchSignals.length > 0 || (liquiditySane && creatorAddress !== null);
}

/** Check 6: Evaluate metadata sanity from raw metadata account or Token-2022 mint extension. */
export function evaluateMetadata(
  mint: MintAddress,
  metadataAccount: AccountInfo<Buffer> | null,
  mintAccount: AccountInfo<Buffer> | null,
): { metadataSane: boolean; parsed: { name: string; symbol: string; uri: string } | null } {
  // Try Metaplex metadata account first
  if (metadataAccount?.data) {
    const parsed = parseTokenMetadata(metadataAccount.data, mint);
    if (parsed) {
      return { metadataSane: checkMetadataFields(parsed), parsed };
    }
  }

  // Fallback: Token-2022 mint extension metadata
  if (mintAccount?.data && mintAccount.data.length > 165) {
    const parsed = parseToken2022Metadata(mintAccount.data);
    if (parsed) {
      return { metadataSane: checkMetadataFields(parsed), parsed };
    }
  }

  // Fail closed: no metadata found
  return { metadataSane: false, parsed: null };
}

/** Check name/symbol/URI/scam fields. */
export function checkMetadataFields(meta: { name: string; symbol: string; uri: string }): boolean {
  const nameOk = meta.name.length >= DEFAULT_MIN_NAME_LENGTH && meta.name.length <= DEFAULT_MAX_NAME_LENGTH;
  const symbolOk = meta.symbol.length >= DEFAULT_MIN_SYMBOL_LENGTH && meta.symbol.length <= DEFAULT_MAX_SYMBOL_LENGTH;
  const uriOk = meta.uri.length > 0;
  const noScam = !DEFAULT_METADATA_SCAM_PATTERNS.some(p => p.test(meta.name) || p.test(meta.symbol));
  const noStructuralJunk = !DEFAULT_METADATA_STRUCTURAL_PATTERNS.some(p => p.test(meta.name) || p.test(meta.symbol));
  const sane = nameOk && symbolOk && uriOk && noScam && noStructuralJunk;
  if (!sane) {
    logger.debug('Metadata sanity failed', { name: meta.name, symbol: meta.symbol, nameOk, symbolOk, uriOk, noScam });
  }
  return sane;
}

/**
 * Parse Token-2022 metadata extension from mint account data.
 * Token-2022 stores name (32 bytes), symbol (10 bytes), URI (128 bytes) in the extension.
 */
function parseToken2022Metadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  try {
    // Token-2022 extension data starts after the base mint account (165 bytes)
    // The metadata extension layout: discriminator(2) + name(32+4) + symbol(10+4) + uri(128+4)
    // But newer Pump.fun may use a different offset. Try common offsets.
    const TOKEN_2022_META_OFFSETS = [165, 170, 202, 230];
    
    for (const baseOffset of TOKEN_2022_META_OFFSETS) {
      if (data.length < baseOffset + 4) continue;
      
      // Try to read name length prefix (u32 LE) or fixed-size fields
      const nameLen = data.readUInt32LE(baseOffset);
      if (nameLen > 0 && nameLen <= 32 && baseOffset + 4 + nameLen <= data.length) {
        const name = data.slice(baseOffset + 4, baseOffset + 4 + nameLen).toString('utf8').replace(/\0/g, '').trim();
        const symbolOffset = baseOffset + 4 + nameLen;
        if (symbolOffset + 4 > data.length) continue;
        const symbolLen = data.readUInt32LE(symbolOffset);
        if (symbolLen > 0 && symbolLen <= 10 && symbolOffset + 4 + symbolLen <= data.length) {
          const symbol = data.slice(symbolOffset + 4, symbolOffset + 4 + symbolLen).toString('utf8').replace(/\0/g, '').trim();
          const uriOffset = symbolOffset + 4 + symbolLen;
          if (uriOffset + 4 > data.length) continue;
          const uriLen = data.readUInt32LE(uriOffset);
          if (uriLen > 0 && uriLen <= 128 && uriOffset + 4 + uriLen <= data.length) {
            const uri = data.slice(uriOffset + 4, uriOffset + 4 + uriLen).toString('utf8').replace(/\0/g, '').trim();
            if (name.length > 0 && symbol.length > 0) {
              return { name, symbol, uri };
            }
          }
        }
      }
    }

    // Fallback: try fixed-size fields (common in some Token-2022 implementations)
    // Name at offset 4 (after extension type u16), 32 bytes, then symbol 10 bytes, then URI 128 bytes
    if (data.length >= 165 + 32 + 10 + 128 + 6) {
      const extOffset = 165;
      const name = data.slice(extOffset + 2, extOffset + 2 + 32).toString('utf8').replace(/\0/g, '').trim();
      const symbol = data.slice(extOffset + 2 + 32, extOffset + 2 + 32 + 10).toString('utf8').replace(/\0/g, '').trim();
      const uri = data.slice(extOffset + 2 + 32 + 10, extOffset + 2 + 32 + 10 + 128).toString('utf8').replace(/\0/g, '').trim();
      if (name.length > 0 && symbol.length > 0) {
        return { name, symbol, uri };
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/** Check 8: Evaluate wallet concentration from raw holder data. */
export function evaluateConcentration(
  largestAccounts: readonly { readonly address: PublicKey | string; readonly amount: string }[] | null,
  totalSupplyStr: string | null,
): boolean {
  if (!largestAccounts || !totalSupplyStr) return false;
  const totalSupply = BigInt(totalSupplyStr);
  if (totalSupply <= 0n) return false;

  let topBalance = 0n;
  for (const account of largestAccounts.slice(0, DEFAULT_WALLET_CONCENTRATION_TOP_N)) {
    topBalance += BigInt(account.amount);
  }
  const concentrationPct = Number((topBalance * 10000n) / totalSupply) / 100;
  return concentrationPct < DEFAULT_MAX_WALLET_CONCENTRATION_PCT;
}
