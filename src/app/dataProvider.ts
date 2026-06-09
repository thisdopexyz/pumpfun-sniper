/**
 * Data Provider — fetches on-chain data for entry checks + position monitoring.
 *
 * Extracted from main.ts. Pure data-fetching, no execution logic.
 */

import { PublicKey } from '@solana/web3.js';
import type { ServiceContainer } from './container.js';
import type { StrategyDataProvider } from '../strategies/filteredSniper/filteredSniperStrategy.js';
import type { EntryCheckData } from '../strategies/filteredSniper/entryDecision.js';
import type { PositionData } from '../strategies/filteredSniper/exitDecision.js';
import type { MintAddress } from '../core/types/token.js';
import type { Signal, LaunchSignal, MomentumSignal } from '../core/types/signal.js';
import type { WalletAddress } from '../core/types/wallet.js';
import type { PositionRegistry } from '../core/state/positionRegistry.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { AntiRugMonitor } from '../risk/controls/antiRug.js';
import { createLogger } from '../telemetry/logging/logger.js';
import { deriveBondingCurvePDA } from '../adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from '../adapters/protocols/pumpfun/tokenParser.js';
import { derivePoolStatePDA } from '../adapters/protocols/bonkfun/bonkfunTradeBuilder.js';
import { parsePoolStateData, calculatePriceLamports as bonkfunPriceLamports } from '../adapters/protocols/bonkfun/tokenParser.js';
import { BONKFUN_PLATFORM_CONFIG, METADATA_PROGRAM_ID, MIN_BONKFUN_POOL_STATE_SIZE, TOKEN_2022_PROGRAM_ID } from '../core/constants/programs.js';
import { SOL_FALLBACK_PRICE_USD } from '../core/constants/defaults/infrastructure.js';
import { nowMs } from '../core/utils/time.js';
import { computeBondingCurvePriceScaled } from '../core/utils/price.js';
import {
  CREATOR_HISTORY_MAX_LAUNCHES,
  CREATOR_HISTORY_WINDOW_MS,
} from '../strategies/filteredSniper/filteredSniperRules.js';
import { computePositionSizeLamports } from './executionDelegate.js';
import { getRealHolderCount } from './heliusHolderCount.js';
import { getRealVolume1h } from './realVolumeFetcher.js';
import {
  evaluateAuthority,
  evaluateLiquidity,
  evaluateLaunchProvenance,
  evaluateMetadata,
  evaluateConcentration,
} from './entryCheckEvaluator.js';

const logger = createLogger('main:dataProvider');

/** Cached SOL price with fallback — prevents oracle outage from disabling checks 10/17/18. */
let cachedSolPriceUsd: number = SOL_FALLBACK_PRICE_USD;
let solPriceCacheTime = 0;
const SOL_PRICE_CACHE_TTL_MS = 60_000; // 60s cache

async function getSolPriceWithFallback(oracle: { getSolPriceUsd(): Promise<number> }): Promise<number> {
  try {
    const price = await oracle.getSolPriceUsd();
    if (price > 0) {
      cachedSolPriceUsd = price;
      solPriceCacheTime = Date.now();
      return price;
    }
  } catch { /* fall through to cache */ }
  // Return cached if fresh, otherwise fallback constant
  return (Date.now() - solPriceCacheTime < SOL_PRICE_CACHE_TTL_MS)
    ? cachedSolPriceUsd
    : SOL_FALLBACK_PRICE_USD;
}

/** In-memory highest price tracking per trade. */
const highestPriceTracker = new Map<string, bigint>();

/** Get a copy of the highest price tracker for persistence. */
export function getHighestPricesForPersist(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [tradeId, price] of highestPriceTracker) {
    if (price > 0n) result[tradeId] = price.toString();
  }
  return result;
}

/** Restore highest prices from persisted state (on startup). */
export function restoreHighestPrices(data: Record<string, string>): void {
  for (const [tradeId, priceStr] of Object.entries(data)) {
    try {
      const price = BigInt(priceStr);
      if (price > 0n) highestPriceTracker.set(tradeId, price);
    } catch { /* skip invalid entries */ }
  }
}

/** Clean up highest price + graduation ratio tracking for a trade. */
export function cleanupHighestPriceTracking(tradeId: string): void {
  highestPriceTracker.delete(tradeId);
  graduationPriceRatio.delete(tradeId);
}

/**
 * Graduation price ratio per trade.
 * When a token transitions from BC to Jupiter, the two price systems use
 * different magnitudes (BC virtual reserves vs real market). This ratio
 * scales Jupiter prices to be BC-equivalent, keeping PNL continuous.
 * ratio = lastBCPrice / firstJupiterPrice (computed once on graduation)
 */
const graduationPriceRatio = new Map<string, bigint>();

/** Anti-rug triggered flags per mint (set by AntiRugMonitor callback). */
const antiRugTriggeredMints = new Set<string>();

/** Jupiter price cache per mint (price in SOL per raw token). Avoids hammering API every 1s poll. */
const graduatedPriceCache = new Map<string, { priceLamports: bigint; fetchedAt: number }>();
const JUPITER_PRICE_CACHE_TTL_MS = 5_000; // 5s cache for graduated token prices
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Fetch graduated token price from external APIs.
 * Returns a scaled BigInt price (NOT lamports per raw token).
 * The graduationPriceRatio mechanism in getPositionData handles the unit
 * conversion to match BC/entry prices.
 *
 * Scaling: 10^9 (not 10^6) to preserve precision for very cheap tokens
 * (e.g., $0.000001 per token → 10^6 would round to 0).
 *
 * Sources (in order):
 *   1. Jupiter Price API v2 (currently 404 — kept for when it returns)
 *   2. DexScreener (priceNative = SOL per whole token, no CoinGecko needed)
 *
 * Cached for 5s to avoid hammering APIs on every exit monitor poll.
 */
async function fetchGraduatedPriceLamports(mint: string): Promise<bigint | null> {
  const cached = graduatedPriceCache.get(mint);
  if (cached && nowMs() - cached.fetchedAt < JUPITER_PRICE_CACHE_TTL_MS) {
    return cached.priceLamports;
  }

  // Try Jupiter Price API first
  try {
    const url = `${JUPITER_PRICE_API}?ids=${mint}&vsToken=${SOL_MINT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (response.ok) {
      const data = await response.json() as { data?: Record<string, { price?: number }> };
      const priceSol = data.data?.[mint]?.price;

      if (typeof priceSol === 'number' && priceSol > 0) {
        // Scale by 10^9 for precision (cheap tokens need more digits)
        const priceScaled = BigInt(Math.round(priceSol * 1_000_000_000));
        if (priceScaled > 0n) {
          graduatedPriceCache.set(mint, { priceLamports: priceScaled, fetchedAt: nowMs() });
          logger.debug('Jupiter graduated price fetched', { mint, priceSol, priceScaled: priceScaled.toString() });
          return priceScaled;
        }
      }
    }
  } catch (err: unknown) {
    logger.debug('Jupiter graduated price fetch failed, trying DexScreener', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: DexScreener (priceNative = SOL per whole token, direct — no CoinGecko)
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (response.ok) {
      const data = await response.json() as { pairs?: Array<{ priceNative?: string; priceUsd?: string }> };
      const pair = data.pairs?.[0];

      // Prefer priceNative (SOL per token) — no CoinGecko dependency
      if (pair?.priceNative) {
        const priceSol = parseFloat(pair.priceNative);
        if (priceSol > 0) {
          const priceScaled = BigInt(Math.round(priceSol * 1_000_000_000));
          if (priceScaled > 0n) {
            graduatedPriceCache.set(mint, { priceLamports: priceScaled, fetchedAt: nowMs() });
            logger.info('DexScreener graduated price fetched (priceNative)', {
              mint, priceSol, priceScaled: priceScaled.toString(),
            });
            return priceScaled;
          }
        }
      }

      // Fallback: priceUsd + CoinGecko conversion
      if (pair?.priceUsd) {
        const priceUsd = parseFloat(pair.priceUsd);
        if (priceUsd > 0) {
          const cgCtrl = new AbortController();
          const cgTimeout = setTimeout(() => cgCtrl.abort(), 5000);
          const solResp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: cgCtrl.signal });
          clearTimeout(cgTimeout);
          const solData = await solResp.json() as { solana?: { usd?: number } };
          const solPrice = solData?.solana?.usd ?? SOL_FALLBACK_PRICE_USD;
          const priceSol = priceUsd / solPrice;
          const priceScaled = BigInt(Math.round(priceSol * 1_000_000_000));
          if (priceScaled > 0n) {
            graduatedPriceCache.set(mint, { priceLamports: priceScaled, fetchedAt: nowMs() });
            logger.info('DexScreener graduated price fetched (priceUsd+CoinGecko)', {
              mint, priceUsd, priceSol, priceScaled: priceScaled.toString(),
            });
            return priceScaled;
          }
        }
      }
    }
  } catch (err: unknown) {
    logger.debug('DexScreener graduated price fetch also failed', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Both failed — return cached if available
  return cached?.priceLamports ?? null;
}

// Metaplex Token Metadata PDA
function deriveMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Real Data Provider — fetches on-chain data for 9 entry checks
 * + tracks open positions for exit evaluation.
 */
export function createDataProvider(
  container: ServiceContainer,
  positionRegistry: PositionRegistry,
  detectors?: { bundleDetector?: { getLatestBundlePct(mint: string): number | null; forceAnalyze(mint: string): number | null }; washTradeDetector?: { getLatestWashScore(mint: string): number | null; forceAnalyze(mint: string): number | null }; smartMoneyDetector?: { checkSmartMoney(mint: string): { smartMoneyScore: number; smartWalletCount: number } | null }; walletAgeDetector?: { getLatestScore(mint: string): number | null; forceAnalyze(mint: string): number | null }; buyVelocityAnalyzer?: { getLatestScore(mint: string): number | null; forceAnalyze(mint: string): number | null }; crossTokenCorrelator?: { getLatestScore(mint: string): number | null; forceAnalyze(mint: string): number | null } },
  antiRugMonitor?: AntiRugMonitor,
): StrategyDataProvider {
  const conn = container.connection;

  // In-memory caches (per session)
  const metadataCache = new Map<string, { name: string; symbol: string; uri: string } | null>();

  // Periodic cache cleanup (every 60s) to prevent memory leaks
  const CLEANUP_INTERVAL_MS = 60_000;
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    // Clean graduated price cache (entries older than 30s)
    for (const [key, val] of graduatedPriceCache) {
      if (now - val.fetchedAt > 30_000) graduatedPriceCache.delete(key);
    }
    // Cap metadata cache at 5000 entries
    if (metadataCache.size > 5000) {
      const keys = [...metadataCache.keys()];
      for (let i = 0; i < keys.length - 3000; i++) metadataCache.delete(keys[i]!);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref(); // Don't prevent process exit

  return {
    startAntiRugMonitoring(mint: string): void {
      if (!antiRugMonitor) return;
      antiRugMonitor.startMonitoring(mint, (detectedMint: string, _details: string) => {
        antiRugTriggeredMints.add(detectedMint);
        logger.warn('Anti-rug triggered for mint', { mint: detectedMint.slice(0, 12) });
      });
    },

    stopAntiRugMonitoring(mint: string): void {
      if (!antiRugMonitor) return;
      antiRugMonitor.stopMonitoring(mint);
      antiRugTriggeredMints.delete(mint);
    },

    transitionPosition(tradeId: string, to: string, reason: string): void {
      positionRegistry.transition(tradeId, to as any, reason);
    },

    async getEntryCheckData(signal: Signal): Promise<EntryCheckData> {
      const mint = signal.mint;
      const mintPk = new PublicKey(mint);
      const results = await Promise.allSettled([
        // Fetch 1: Token Mint account (authority checks)
        conn.getAccountInfo(mintPk),
        // Fetch 2: Bonding curve account (liquidity + creator fallback)
        conn.getAccountInfo(deriveBondingCurvePDA(mintPk)),
        // Fetch 3: Metaplex metadata account (metadata check)
        conn.getAccountInfo(deriveMetadataPDA(mintPk)),
        // Fetch 4: Token largest accounts (wallet concentration)
        conn.getTokenLargestAccounts(mintPk),
        // Fetch 5: Token supply
        conn.getTokenSupply(mintPk),
        // Fetch 6: Previously persisted signals for launch provenance
        container.signalRepository.findByMint(mint),
        // Fetch 7: BonkFun/LaunchLab pool state (venue-aware liquidity + price)
        conn.getAccountInfo(derivePoolStatePDA(mintPk)),
      ]);

      const signalsForMint = results[5].status === 'fulfilled' ? results[5].value : [];
      if (results[5].status === 'rejected') {
        logger.warn('Failed to load signal history for entry checks', {
          mint: mint.slice(0, 12),
          error: results[5].reason instanceof Error ? results[5].reason.message : String(results[5].reason),
        });
      }

      const launchSignals = signalsForMint.filter((item): item is LaunchSignal => item.type === 'LAUNCH');
      const latestLaunch = launchSignals[launchSignals.length - 1] ?? null;

      const mintAccount = results[0].status === 'fulfilled' ? results[0].value : null;
      const { mintAuthorityRevoked, freezeAuthorityRevoked } = evaluateAuthority(mint, mintAccount);

      const bondingCurveAccount = results[1].status === 'fulfilled' ? results[1].value : null;
      const poolStateAccount = results[6].status === 'fulfilled' ? results[6].value : null;
      const { liquiditySane, bondingCurveCreator } = evaluateLiquidity(bondingCurveAccount, poolStateAccount);

      const creatorAddress = (latestLaunch?.creator ?? bondingCurveCreator) as WalletAddress | null;
      const launchDetected = evaluateLaunchProvenance(launchSignals, liquiditySane, creatorAddress);

      // --- Check 2: Creator not blacklisted ---
      const creatorNotBlacklisted = creatorAddress !== null
        ? !container.creatorBlacklist.isBlacklisted(creatorAddress)
        : false;

      // --- Check 3: Creator history acceptable ---
      let creatorHistoryAcceptable = false;
      let creatorLaunchCount = 0;
      if (creatorAddress !== null) {
        try {
          const launches = await container.signalRepository.findRecentLaunchesByCreator(
            creatorAddress,
            signal.timestamp - CREATOR_HISTORY_WINDOW_MS,
          );
          creatorLaunchCount = launches.length;
          creatorHistoryAcceptable = creatorLaunchCount <= CREATOR_HISTORY_MAX_LAUNCHES;
        } catch (err: unknown) {
          logger.warn('Failed to load creator history for entry checks', {
            mint: mint.slice(0, 12),
            creator: creatorAddress.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
          creatorHistoryAcceptable = false;
        }
      }

      const metadataAccount = results[2].status === 'fulfilled' ? results[2].value : null;
      const { metadataSane, parsed: metadataParsed } = evaluateMetadata(mint, metadataAccount, mintAccount);
      if (metadataParsed) {
        metadataCache.set(mint, metadataParsed);
      }

      const largestAccounts = results[3].status === 'fulfilled' ? results[3].value : null;
      const supply = results[4].status === 'fulfilled' ? results[4].value : null;

      // Filter out bonding curve ATA from largest accounts for PumpFun tokens
      // Bonding curve holds unsold supply — not a real "whale"
      // Must filter BOTH standard Token Program ATA AND Token-2022 ATA
      let filteredLargestAccounts = largestAccounts?.value ?? null;
      if (filteredLargestAccounts && bondingCurveAccount) {
        const bcPDA = deriveBondingCurvePDA(mintPk);
        const bcATA = getAssociatedTokenAddressSync(mintPk, bcPDA, true, TOKEN_PROGRAM_ID);
        const bcATA2022 = getAssociatedTokenAddressSync(mintPk, bcPDA, true, TOKEN_2022_PROGRAM_ID);
        const bcPDAStr = bcPDA.toBase58();
        const bcATAStr = bcATA.toBase58();
        const bcATA2022Str = bcATA2022.toBase58();
        // Filter out BC PDA, standard ATA, and Token-2022 ATA
        filteredLargestAccounts = filteredLargestAccounts.filter(
          acc => {
            const addr = typeof acc.address === 'string' ? acc.address : acc.address.toBase58();
            return addr !== bcPDAStr && addr !== bcATAStr && addr !== bcATA2022Str;
          },
        );
      }

      const walletConcentrationAcceptable = evaluateConcentration(
        filteredLargestAccounts,
        supply?.value.amount ?? null,
      );

      // --- Check 9: Momentum data from the actual MOMENTUM signal payload ---
      const buyCountInWindow = signal.type === 'MOMENTUM' ? signal.buyCount : 0;
      const volumeLamports = signal.type === 'MOMENTUM' ? signal.volumeSol : 0n;
      const windowMs = signal.type === 'MOMENTUM' ? signal.windowSeconds * 1000 : Number.POSITIVE_INFINITY;

      // --- Check 10: Price impact of position size on bonding curve ---
      // Parse bonding curve data ONCE and reuse for both price impact and market cap
      let parsedBC: { virtualSolReserves: bigint; virtualTokenReserves: bigint; realSolReserves: bigint; complete: boolean } | null = null;
      if (bondingCurveAccount?.data && bondingCurveAccount.data.length >= 49) {
        parsedBC = parseBondingCurveData(bondingCurveAccount.data);
      }

      // --- BonkFun pool state (venue-aware) ---
      // If bonding curve doesn't exist, check LaunchLab pool state
      const poolAccount = results[6].status === 'fulfilled' ? results[6].value : null;
      let parsedPool: { virtualBase: bigint; virtualQuote: bigint; realBase: bigint; realQuote: bigint; complete: boolean; platformConfig: { equals(pk: PublicKey): boolean } } | null = null;
      if (!parsedBC && poolAccount?.data && poolAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
        const raw = parsePoolStateData(Buffer.from(poolAccount.data), mint);
        if (raw && raw.platformConfig.equals(BONKFUN_PLATFORM_CONFIG)) {
          parsedPool = raw;
        }
      }

      // Re-evaluate concentration for BonkFun: exclude pool's base_vault
      // The vault holds pool reserves and would artificially inflate concentration
      let finalConcentration = walletConcentrationAcceptable;
      if (parsedPool && filteredLargestAccounts && poolAccount?.data && poolAccount.data.length >= 301) {
        const baseVaultPk = new PublicKey(poolAccount.data.subarray(269, 301)); // 8+261, verified on-chain
        const baseVaultStr = baseVaultPk.toBase58();
        const filtered = filteredLargestAccounts.filter(
          acc => (typeof acc.address === 'string' ? acc.address : acc.address.toBase58()) !== baseVaultStr,
        );
        finalConcentration = evaluateConcentration(filtered, supply?.value.amount ?? null);
      }

      let priceImpactBps: number | null = null;
      if (parsedBC && parsedBC.virtualSolReserves > 0n) {
        try {
          const solPriceUsd = await getSolPriceWithFallback(container.solPriceOracle);
          const positionSizeLamports = computePositionSizeLamports(solPriceUsd);
          // virtualSolReserves is in lamports (PumpFun confirmed)
          priceImpactBps = Number(positionSizeLamports * 10000n) / Number(parsedBC.virtualSolReserves + positionSizeLamports);
        } catch (err: unknown) {
          logger.warn('Failed to compute price impact — SOL price unavailable', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (parsedPool && parsedPool.virtualQuote > 0n) {
        // BonkFun price impact: use virtualQuote (SOL reserves)
        try {
          const solPriceUsd = await getSolPriceWithFallback(container.solPriceOracle);
          const positionSizeLamports = computePositionSizeLamports(solPriceUsd);
          priceImpactBps = Number(positionSizeLamports * 10000n) / Number(parsedPool.virtualQuote + positionSizeLamports);
        } catch (err: unknown) {
          logger.warn('Failed to compute BonkFun price impact — SOL price unavailable', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // --- Creator score from historical performance ---
      let creatorScore: number | null = null;
      if (creatorAddress !== null) {
        try {
          creatorScore = await container.creatorStatsRepository.getScore(creatorAddress);
        } catch (err: unknown) {
          logger.warn('Failed to load creator score', {
            mint: mint.slice(0, 12),
            creator: creatorAddress.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Calculate seconds since launch for late momentum detection
      // Primary: from persisted launch signal
      // Fallback: fetch from PumpFun API if signal not yet persisted
      let launchTimestamp = latestLaunch?.timestamp ?? null;
      if (launchTimestamp === null) {
        try {
          const pfUrl = `https://frontend-api-v3.pump.fun/coins/${mint}`;
          const pfRes = await fetch(pfUrl, { signal: AbortSignal.timeout(3000) });
          if (pfRes.ok) {
            const pfData = await pfRes.json() as { created_timestamp?: number | string };
            if (pfData.created_timestamp) {
              launchTimestamp = typeof pfData.created_timestamp === 'string'
                ? new Date(pfData.created_timestamp).getTime()
                : pfData.created_timestamp;
              logger.debug('Launch timestamp from PumpFun API fallback', {
                mint: mint.slice(0, 12),
                launchTimestamp,
              });
            }
          }
        } catch (err: unknown) {
          logger.debug('PumpFun API fallback failed for launch timestamp', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const secondsSinceLaunch = launchTimestamp !== null
        ? Math.floor((nowMs() - launchTimestamp) / 1000)
        : null;

      // Calculate market cap from bonding curve data
      // Market cap = price * total supply
      // Price = virtualSolReserves / virtualTokenReserves (in SOL per token)
      // Market cap = price * supply in lamports
      let marketCapUsd: number | null = null;
      if (parsedBC && parsedBC.virtualTokenReserves > 0n && supply?.value) {
        try {
          const pricePerTokenLamports = computeBondingCurvePriceScaled(parsedBC.virtualSolReserves, parsedBC.virtualTokenReserves);
          const totalSupplyRaw = BigInt(supply.value.amount);
          const marketCapLamports = pricePerTokenLamports * totalSupplyRaw;
          const solPriceUsd = await getSolPriceWithFallback(container.solPriceOracle);
          // pricePerTokenScaled is in (lamports * 10^6) / raw_token units.
          // marketCapLamports = priceScaled * supply → in (lamports * 10^6) units.
          // To get SOL: /10^6 (undo scaling) / 10^9 (lamports→SOL) = /10^15
          marketCapUsd = Number(marketCapLamports / 10n ** 15n) * solPriceUsd;
        } catch (err: unknown) {
          logger.warn('Failed to calculate market cap', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (parsedPool && parsedPool.virtualBase > 0n && supply?.value) {
        // BonkFun market cap: use virtualQuote/virtualBase for price
        try {
          const totalSupplyRaw = BigInt(supply.value.amount);
          const marketCapLamports = (parsedPool.virtualQuote * totalSupplyRaw) / parsedPool.virtualBase;
          const solPriceUsd = await getSolPriceWithFallback(container.solPriceOracle);
          // virtualQuote is in 10-lamport units. Actual SOL = virtualQuote / 10 / 10^9
          marketCapUsd = Number(marketCapLamports / 10n ** 10n) * solPriceUsd;
        } catch (err: unknown) {
          logger.warn('Failed to calculate BonkFun market cap', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.debug('Entry check data fetched', {
        mint: mint.slice(0, 12),
        signalType: signal.type,
        launchDetected,
        creator: creatorAddress?.slice(0, 12) ?? null,
        creatorLaunchCount,
        creatorScore,
        mintAuthorityRevoked,
        freezeAuthorityRevoked,
        metadataSane,
        liquiditySane,
        walletConcentrationAcceptable: finalConcentration,
        creatorNotBlacklisted,
        priceImpactBps,
        secondsSinceLaunch,
        marketCapUsd,
      });

      // Cache bundle result — same detector for checks 11 and 26
      // Calling once guarantees snapshot consistency (fixes issue #5 and #10)
      const bundlePctCached = detectors?.bundleDetector?.forceAnalyze(mint as any) ?? null;

      return {
        mint,
        launchDetected,
        creatorNotBlacklisted,
        creatorHistoryAcceptable,
        creatorScore,
        mintAuthorityRevoked,
        freezeAuthorityRevoked,
        metadataSane,
        liquiditySane,
        walletConcentrationAcceptable: finalConcentration,
        buyCountInWindow,
        volumeLamports,
        windowMs,
        priceImpactBps,
        bundlePct: bundlePctCached,
        washTradeScore: detectors?.washTradeDetector?.forceAnalyze(mint) ?? null,
        uniqueWallets: signal.type === 'MOMENTUM' ? (signal as MomentumSignal).uniqueWalletCount : undefined,
        // Check 14: Sell pressure — now available from momentum signal
        sellCountInWindow: signal.type === 'MOMENTUM' ? (signal as MomentumSignal).sellCount : undefined,
        // Check 15: Real SOL reserves in bonding curve (or BonkFun pool)
        // Both PumpFun realSolReserves and BonkFun realQuote are in lamports
        realSolReservesLamports: parsedBC ? parsedBC.realSolReserves : (parsedPool ? parsedPool.realQuote : null),
        // Check 16: Real holder count from Helius API (not just top 20)
        holderCount: await getRealHolderCount(mint, container.heliusApiKey).catch(() => largestAccounts?.value?.length ?? null),
        // Check 18: Volume in USD — try DexScreener first, fallback to momentum window
        volumeUsd: await getRealVolume1h(mint).catch(() => null)
          ?? await (async () => {
            if (Number(volumeLamports) <= 0) return undefined;
            try {
              const solPrice = await getSolPriceWithFallback(container.solPriceOracle);
              return Number(volumeLamports) / 1e9 * solPrice;
            } catch { return undefined; }
          })(),
        secondsSinceLaunch: secondsSinceLaunch ?? undefined,
        marketCapUsd,
        // Check 19: Smart money detection (single call, reuse result)
        ...(() => {
          try {
            const sm = detectors?.smartMoneyDetector?.checkSmartMoney(mint as any);
            return { smartMoneyScore: sm?.smartMoneyScore ?? null, smartWalletCount: sm?.smartWalletCount ?? 0 };
          } catch { return { smartMoneyScore: null, smartWalletCount: 0 }; }
        })(),
        // Check 24: Wallet age score (Dev Multi-Wallet Defense)
        walletAgeScore: detectors?.walletAgeDetector?.forceAnalyze(mint as any) ?? null,
        // Check 25: Buy velocity score (Dev Multi-Wallet Defense)
        buyVelocityScore: detectors?.buyVelocityAnalyzer?.forceAnalyze(mint as any) ?? null,
        // Check 26: Reuse cached bundlePct — same value, snapshot consistency
        enhancedBundlePct: bundlePctCached,
        // Check 27: Cross-token correlation score (Dev Multi-Wallet Defense)
        crossTokenScore: detectors?.crossTokenCorrelator?.forceAnalyze(mint as any) ?? null,
      };
    },

    async getPositionData(tradeId: string): Promise<PositionData | null> {
      const pos = positionRegistry.get(tradeId);
      if (!pos) {
        // Clean up price trackers for exited positions to prevent memory leak
        highestPriceTracker.delete(tradeId);
        graduationPriceRatio.delete(tradeId);
        return null;
      }

      // Fetch current price from bonding curve (or Jupiter if graduated)
      const mintPk = new PublicKey(pos.mint);
      const bcPDA = deriveBondingCurvePDA(mintPk);

      // Track highest price for trailing stop (moved up — needed by fallback)
      const posTradeId = pos.tradeId ?? pos.id;
      const prevHighest = highestPriceTracker.get(posTradeId) ?? 0n;

      let currentPriceLamports = 0n;
      let graduated = false;
      let rugPullDetected = false;
      

      // Fetch bonding curve account with error handling (RPC can fail)
      let bcAccount = null;
      let rpcFailed = false;
      try {
        bcAccount = await conn.getAccountInfo(bcPDA);
      } catch (rpcErr: unknown) {
        rpcFailed = true;
        logger.warn('RPC getAccountInfo failed — using prevHighest fallback', {
          mint: pos.mint,
          error: rpcErr instanceof Error ? rpcErr.message : String(rpcErr),
        });
      }

      // BC calibration price — even if graduated, fetch for graduationPriceRatio
      let bcCalibrationPrice: bigint | null = null;

      if (bcAccount?.data && bcAccount.data.length >= 49) {
        const parsed = parseBondingCurveData(bcAccount.data);
        if (parsed) {
          graduated = parsed.complete;
          if (!graduated && parsed.virtualTokenReserves > 0n) {
            currentPriceLamports = computeBondingCurvePriceScaled(parsed.virtualSolReserves, parsed.virtualTokenReserves);
          }
          // Always compute BC price for ratio calibration (even if graduated)
          // BC account persists after graduation — use last BC price to bridge
          // the 10^6 (BC) vs 10^9 (DexScreener) scaling gap.
          if (parsed.virtualTokenReserves > 0n) {
            bcCalibrationPrice = computeBondingCurvePriceScaled(parsed.virtualSolReserves, parsed.virtualTokenReserves);
          }
        } else {
          // Parse failed — bonding curve data is corrupt or format changed.
          // Use prevHighest to avoid false STOP_LOSS at -100%.
          if (prevHighest > 0n) {
            currentPriceLamports = prevHighest;
            logger.warn('Bonding curve parse failed — using prevHighest', {
              mint: pos.mint,
              dataLength: bcAccount.data.length,
              fallbackPrice: prevHighest.toString(),
            });
          }
        }
      } else if (!bcAccount && !rpcFailed) {
        // Bonding curve doesn't exist — check if it's a BonkFun (LaunchLab) token
        const poolPDA = derivePoolStatePDA(mintPk);
        let foundBonkfun = false;
        try {
          const poolAccount = await conn.getAccountInfo(poolPDA);
          if (poolAccount?.data && poolAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
            const parsedPool = parsePoolStateData(Buffer.from(poolAccount.data), pos.mint);
            if (parsedPool && parsedPool.platformConfig.equals(BONKFUN_PLATFORM_CONFIG)) {
              foundBonkfun = true;
              graduated = parsedPool.complete;
              if (!graduated && parsedPool.virtualBase > 0n) {
                currentPriceLamports = bonkfunPriceLamports(parsedPool);
                logger.debug('BonkFun price fetched', {
                  mint: pos.mint,
                  priceLamports: currentPriceLamports.toString(),
                });
              }
            }
          }
        } catch (poolErr: unknown) {
          logger.warn('Failed to fetch BonkFun pool state', {
            mint: pos.mint,
            error: poolErr instanceof Error ? poolErr.message : String(poolErr),
          });
        }
        // If not BonkFun, BC deleted = PumpFun graduated → try Jupiter
        if (!foundBonkfun && !graduated) {
          const jupiterPrice = await fetchGraduatedPriceLamports(pos.mint);
          if (jupiterPrice !== null && jupiterPrice > 0n) {
            graduated = true;
            currentPriceLamports = jupiterPrice;
            logger.info('PumpFun graduated — BC deleted, Jupiter price fetched', {
              mint: pos.mint,
              priceLamports: jupiterPrice.toString(),
            });
          }
        }
      } else if (!bcAccount) {
        if (rpcFailed) {
          // RPC failure (transient) — safe to use prevHighest
          if (prevHighest > 0n) {
            currentPriceLamports = prevHighest;
            logger.warn('Bonding curve RPC failed — using prevHighest', {
              mint: pos.mint,
              fallbackPrice: prevHighest.toString(),
            });
          }
        } else {
          // RPC succeeded but account is null → bonding curve deleted.
          // This is a strong rug pull signal. Do NOT use prevHighest —
          // let price stay at 0 so stop-loss triggers.
          rugPullDetected = true;
          logger.error('Bonding curve account GONE (rug pull?) — NOT using prevHighest fallback', {
            mint: pos.mint,
            prevHighest: prevHighest.toString(),
          });
        }
      }

      // Graduated: bonding curve drained → fetch real price from Jupiter/Raydium
    // Jupiter Price API returns SOL per whole token (post-decimal), while BC/entry
    // prices are in lamports per raw token unit (pre-decimal). The scale difference
    // depends on the token's decimals (typically 10^3 for 6-decimal tokens).
    //
    // Fix: always compute a ratio = prevBCPrice / firstJupiterPrice on first
    // graduation detection. This captures the exact scale difference without
    // needing to know the token's decimals. All subsequent Jupiter prices are
    // scaled by this ratio to maintain PNL continuity from entry.
    if (graduated) {
      const jupiterPrice = await fetchGraduatedPriceLamports(pos.mint);
      if (jupiterPrice === null || jupiterPrice <= 0n) {
        // price fetch failed — treated as rug; keep 0 so SL can fire
      } else {
        const existingRatio = graduationPriceRatio.get(posTradeId);
        if (existingRatio !== undefined) {
          // Already graduated — apply stored ratio for PNL continuity
          currentPriceLamports = jupiterPrice * existingRatio / 1_000_000_000n;
        } else if (prevHighest > 0n || bcCalibrationPrice !== null) {
          // First graduation detection — compute and store ratio.
          // Use prevHighest if available (BC was polled before graduation),
          // otherwise fall back to bcCalibrationPrice (BC account still on-chain
          // but was never polled — e.g., bot started after graduation).
          // Both are in 10^6 scale (lamports per raw token unit).
          const refPrice = prevHighest > 0n ? prevHighest : bcCalibrationPrice!;
          // ratio = refBCPrice * 10^9 / jupiterPrice bridges 10^6 (BC) ↔ 10^9 (DexScreener)
          const ratio = refPrice * 1_000_000_000n / jupiterPrice;
          if (ratio > 0n && ratio < 1_000_000_000_000n) {
            graduationPriceRatio.set(posTradeId, ratio);
            currentPriceLamports = jupiterPrice * ratio / 1_000_000_000n;
            logger.info('BC→Graduated: PNL continuity ratio computed', {
              mint: pos.mint,
              lastBCPrice: refPrice.toString(),
              prevHighest: prevHighest.toString(),
              bcCalibration: bcCalibrationPrice?.toString() ?? 'null',
              firstJupiterPrice: jupiterPrice.toString(),
              scaledPrice: currentPriceLamports.toString(),
              ratio: ratio.toString(),
            });
          } else {
            currentPriceLamports = jupiterPrice;
          }
        } else {
          // No BC price history at all (BC account deleted) — use raw price
          currentPriceLamports = jupiterPrice;
        }
      }
    }

      // Safety: if currentPrice is STILL 0 but we have a previous highest,
      // use it. A real price crash to exactly 0 is extremely rare (rug pull
      // still has some residual value). Better to use stale price than trigger
      // a false -100% STOP_LOSS.
      // EXCEPTIONS:
      //   - graduated tokens: if price is 0, all sources failed = rug.
      //   - rugPullDetected: BC account deleted = real rug, let SL fire.
      if (currentPriceLamports === 0n && prevHighest > 0n && !graduated && !rugPullDetected) {
        currentPriceLamports = prevHighest;
        logger.warn('Price resolved to 0 but prevHighest exists — using fallback', {
          mint: pos.mint,
          fallbackPrice: prevHighest.toString(),
        });
      }

      const highestPriceLamports = currentPriceLamports > prevHighest ? currentPriceLamports : prevHighest;
      if (highestPriceLamports > prevHighest) {
        highestPriceTracker.set(posTradeId, highestPriceLamports);
      }

      return {
        mint: pos.mint as MintAddress,
        tradeId: posTradeId,
        entryPriceLamports: pos.entryPriceSol ?? 0n,
        currentPriceLamports,
        openedAt: pos.entryTimestamp ?? pos.createdAt,
        killSwitchActive: !container.killSwitch.isAlive(),
        graduated,
        highestPriceLamports,
        antiRugTriggered: antiRugTriggeredMints.has(pos.mint),
      };
    },

    getActivePositionCount(): number {
      return positionRegistry.getActiveCount();
    },

    isTokenBlacklisted(mint: string): boolean {
      return container.tokenBlacklist.isBlacklisted(mint);
    },
  };
}
