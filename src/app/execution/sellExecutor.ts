import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import type { SellParams, SellResult } from '../../strategies/filteredSniper/filteredSniperStrategy.js';
import type { MintAddress, BondingCurveState } from '../../core/types/token.js';
import { JupiterProvider } from '../../adapters/dex/jupiterProvider.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import { deriveBondingCurvePDA } from '../../adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from '../../adapters/protocols/pumpfun/tokenParser.js';
import { SLIPPAGE_BPS } from '../../strategies/filteredSniper/filteredSniperRules.js';
import { composeSwapInstructions } from '../../execution/tx/txComposer.js';
import { DEFAULT_PUMPFUN_COMPUTE_BUDGET, buildComputeBudgetInstructions } from '../../execution/tx/computeBudgetBuilder.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, MIN_BONKFUN_POOL_STATE_SIZE } from '../../core/constants/programs.js';
import { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, toBN } from '../../adapters/protocols/pumpfun/officialPumpSdk.js';
import { buildOfficialPumpfunBondingCurve, quoteOfficialPumpfunSell } from '../../adapters/protocols/pumpfun/officialPumpfunQuote.js';
import type { ExecutionRuntime } from './runtime.js';
import { recordPnlAndRisk } from './pnlRecorder.js';
import { saveTrade } from './tradeRecorder.js';
import { getConfirmedSellAmountSol } from './onChainAccounting.js';
import { reclaimSingleAccount } from './rentReclaimer.js';

const logger = createLogger('app:execution:sell');

/** Apply sell percentage to token amount (for partial sells / scale-out). */
function applySellPct(tokenAmount: bigint, sellPct: number): bigint {
  if (sellPct >= 100) return tokenAmount;
  return tokenAmount * BigInt(sellPct) / 100n;
}

export async function buildPumpfunSellInstructions(params: {
  readonly runtime: ExecutionRuntime;
  readonly mint: PublicKey;
  readonly user: PublicKey;
  readonly tokenProgram: PublicKey;
  readonly tokenAmount: bigint;
  readonly minSolOutput: bigint;
  readonly creator: PublicKey;
  readonly feeRecipient?: PublicKey;
  readonly buybackFeeRecipient?: PublicKey;
}): Promise<TransactionInstruction[]> {
  if (params.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const userQuoteAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      params.user,
      false,
      TOKEN_PROGRAM_ID,
    );
    const createUserQuoteAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      params.user,
      userQuoteAta,
      params.user,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    );
    const sellIx = await params.runtime.pumpSdk.getSellV2InstructionRaw({
      user: params.user,
      mint: params.mint,
      creator: params.creator,
      amount: toBN(params.tokenAmount),
      quoteAmount: toBN(params.minSolOutput),
      feeRecipient: params.feeRecipient,
      buybackFeeRecipient: params.buybackFeeRecipient,
      tokenProgram: params.tokenProgram,
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    const closeUserQuoteAtaIx = createCloseAccountInstruction(
      userQuoteAta,
      params.user,
      params.user,
      [],
      TOKEN_PROGRAM_ID,
    );
    return [
      ...buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET),
      createUserQuoteAtaIx,
      sellIx,
      closeUserQuoteAtaIx,
    ];
  }

  const swapResult = params.runtime.container.pumpfunVenue.buildSwap({
    mint: params.mint,
    user: params.user,
    direction: 'SELL',
    tokenAmount: params.tokenAmount,
    slippageAmount: params.minSolOutput,
    tokenProgram: params.tokenProgram,
    creator: params.creator,
    feeRecipient: params.feeRecipient,
    buybackFeeRecipient: params.buybackFeeRecipient,
  });

  return composeSwapInstructions({
    computeBudget: DEFAULT_PUMPFUN_COMPUTE_BUDGET,
    swapInstruction: swapResult.instruction,
  });
}

export async function executeSell(params: SellParams, runtime: ExecutionRuntime): Promise<SellResult> {
  const {
    container,
    positionRegistry,
    pumpSdk,
    maxTxRetries: MAX_TX_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
    delay,
    getMintTokenProgram,
    getUserTokenBalance,
    confirmSubmittedTransaction,
    isPermanentError,
  } = runtime;
  const tradeId = params.tradeId;
  const sellPct = params.sellPct ?? 100;
  const sellSendRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pos = positionRegistry.get(tradeId);
  logger.info('EXECUTE SELL', { tradeId, sellSendRunId, reason: params.reason, mint: pos?.mint });

  try {
    if (!pos) {
      return { success: false, signature: null, error: 'Position not found' };
    }

    const mint = new PublicKey(pos.mint);
    const user = container.signer.getPublicKey();
    const tokenProgram = await getMintTokenProgram(mint);

    // ── Jupiter Sell Helper (shared by PumpFun + BonkFun graduation) ──
    async function executeJupiterSell(): Promise<SellResult> {
      logger.info("Routing to Jupiter sell", { tradeId, mint: pos!.mint });
      const jupiterProvider = new JupiterProvider();

      let signature: string | null = null;
      let lastError: string | null = null;
      let sellConfirmed = false;
      let amountSol = 0n;
      let partialTokenAmount = 0n;

      for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
        if (attempt > 0) {
          logger.info('Retrying Jupiter SELL with fresh quote', { tradeId, attempt });
          await delay(RETRY_DELAY_MS);
        }

        // Re-fetch fresh token balance on each attempt
        const currentBalance = await getUserTokenBalance(user, mint, tokenProgram);
        if (currentBalance === 0n) {
          logger.info('Jupiter sell: token balance zero — sell likely landed', { tradeId, attempt });
          sellConfirmed = true;
          amountSol = 0n; // Can't determine exact amount, but sell landed
          break;
        }
        partialTokenAmount = applySellPct(currentBalance, sellPct);
        if (partialTokenAmount === 0n) {
          return { success: false, signature: null, error: 'No token balance in user ATA' };
        }

        // Fresh quote on each attempt
        const quote = await jupiterProvider.quote({
          mint: pos!.mint as MintAddress,
          direction: 'SELL',
          amountLamports: partialTokenAmount,
          slippageBps: SLIPPAGE_BPS,
        });
        if (quote === null) {
          lastError = 'Jupiter quote failed';
          logger.warn('Jupiter quote failed on attempt', { tradeId, attempt });
          continue; // Retry — might be temporary liquidity issue
        }

        const jupiterSwap = await container.jupiterVenue.buildSwap({
          route: quote,
          userPublicKey: user.toBase58(),
        });
        if (jupiterSwap === null) {
          lastError = 'Jupiter swap build failed';
          logger.warn('Jupiter swap build failed on attempt', { tradeId, attempt });
          continue;
        }

        const sendResult = await container.sellSendCoordinator.signAndSend({
          tradeId: `sell-${tradeId}-${sellSendRunId}-jupiter-${attempt}`,
          transaction: jupiterSwap.transaction,
        });

        signature = sendResult.sendResult?.signature ?? signature;
        lastError = sendResult.error ?? null;

        if (!lastError && signature) {
          logger.info('Jupiter SELL TX submitted, waiting for confirmation...', { tradeId, signature, attempt });
          const confirmError = await confirmSubmittedTransaction(signature);
          if (!confirmError) {
            logger.info('Jupiter SELL TX CONFIRMED ON-CHAIN!', { tradeId, signature, attempt });
            sellConfirmed = true;

            // Get confirmed on-chain amount
            try {
              const accounting = await getConfirmedSellAmountSol({
                connection: container.connection,
                signature,
                wallet: user,
                fallbackLamports: quote.expectedOutputAmount,
                tradeId,
              });
              amountSol = accounting.amountSolLamports;
            } catch {
              amountSol = quote.expectedOutputAmount;
            }
            break;
          }
          lastError = confirmError;
          logger.error('Jupiter SELL TX FAILED ON-CHAIN', { tradeId, signature, attempt, onChainError: confirmError });
        }

        if (lastError && isPermanentError(lastError)) {
          logger.warn('Permanent Jupiter SELL error — not retrying', { tradeId, error: lastError });
          break;
        }
      }

      // Save trade to DB
      try {
        await saveTrade(container, {
          id: `sell-${tradeId}-${sellSendRunId}`,
          mint: pos!.mint,
          side: 'SELL',
          status: sellConfirmed ? 'CONFIRMED' : 'FAILED',
          amountSol,
          amountTokens: partialTokenAmount,
          signature,
          slot: null,
          submittedAt: nowMs(),
          confirmedAt: sellConfirmed ? nowMs() : null,
          failureReason: sellConfirmed ? null : lastError,
          exitReason: params.reason ?? null,
        });
      } catch (saveErr: unknown) {
        logger.error('Failed to save Jupiter sell trade', {
          tradeId, error: saveErr instanceof Error ? saveErr.message : String(saveErr),
        });
      }

      if (!sellConfirmed) {
        container.cooldownManager.activateCooldown();
        return { success: false, signature, error: lastError ?? 'Jupiter sell failed after retries' };
      }

      // For SCALE_OUT: don't transition to EXITED — strategy handles
      // the transition to SCALE_OUT_PARTIAL after sell success.
      if (params.reason !== 'SCALE_OUT') {
        positionRegistry.transition(tradeId, 'EXITED', params.reason);
      }
      reclaimSingleAccount({ connection: container.connection, mint, owner: user, tokenProgram, txBuilder: container.txBuilder, sendCoordinator: container.sendCoordinator })
        .catch((err: unknown) => { logger.warn('Post-sell rent reclaim failed', { tradeId, error: err instanceof Error ? err.message : String(err) }); });

      try {
        const entrySolLamports = pos!.entryAmountSol ?? 0n;
        // For SCALE_OUT: use proportional entry cost based on actual tokens sold vs original
        // This is accurate for tier 1+ where sellPct is % of REMAINING, not original
        const proportionalEntry = params.reason === 'SCALE_OUT' && pos!.entryAmountTokens && pos!.entryAmountTokens > 0n
          ? entrySolLamports * partialTokenAmount / pos!.entryAmountTokens
          : entrySolLamports;
        const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
        const pnlUsd = Number(amountSol - proportionalEntry) / 1e9 * solPriceUsd;
        recordPnlAndRisk(container, pnlUsd, params.reason, tradeId, pos!.mint);
      } catch (pnlErr: unknown) {
        logger.error('P&L recording failed (Jupiter) — activating cooldown anyway', { tradeId, error: pnlErr instanceof Error ? pnlErr.message : String(pnlErr) });
        container.cooldownManager.activateCooldown();
      }

      return { success: true, signature, error: null };
    }
    let tokenAmount = await getUserTokenBalance(user, mint, tokenProgram);
    if (tokenAmount === 0n) {
      logger.warn('No live token balance — closing stale open position without sending SELL', {
        tradeId,
        mint: pos.mint,
      });
      positionRegistry.transition(tradeId, 'EXITED', 'NO_TOKEN_BALANCE');

      // Manual sell detected: record PnL (loss) and activate cooldown.
      // Without this, bot immediately re-buys after manual sell.
      try {
        const entrySolLamports = pos.entryAmountSol ?? 0n;
        const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
        const pnlUsd = -Number(entrySolLamports) / 1e9 * solPriceUsd; // 0 exit = full loss
        recordPnlAndRisk(container, pnlUsd, 'MANUAL_SELL', tradeId, pos.mint);
        logger.info('Manual sell detected — PnL recorded, cooldown activated', {
          tradeId,
          pnlUsd: pnlUsd.toFixed(4),
        });
      } catch (pnlErr: unknown) {
        logger.error('Manual sell PnL recording failed — activating cooldown anyway', {
          tradeId,
          error: pnlErr instanceof Error ? pnlErr.message : String(pnlErr),
        });
        container.cooldownManager.activateCooldown();
      }

      return { success: true, signature: null, error: null };
    }

    // ── Venue Detection: BonkFun vs PumpFun ──────────────────────
    // Check if this token is a BonkFun (Raydium LaunchLab) token first.
    // If pool state PDA exists with BonkFun platform config → route to BonkFun sell.
    // Otherwise → fall through to PumpFun bonding curve flow.
    const { derivePoolStatePDA: deriveBonkfunPoolPDA } = await import('../../adapters/protocols/bonkfun/shared.js');
    const { parsePoolStateData, isBonkfunToken } = await import('../../adapters/protocols/bonkfun/tokenParser.js');

    const bonkfunPoolPDA = deriveBonkfunPoolPDA(mint);
    const bonkfunPoolAccount = await container.connection.getAccountInfo(bonkfunPoolPDA);
    let bonkfunGraduated = false;

    if (bonkfunPoolAccount?.data && bonkfunPoolAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
      const parsedPool = parsePoolStateData(Buffer.from(bonkfunPoolAccount.data), mint.toBase58());
      if (parsedPool && isBonkfunToken(parsedPool)) {
        logger.info('BonkFun token detected — routing to BonkFun sell', { tradeId, mint: pos.mint });

        // Apply sellPct for partial sells (scale-out)
        const bonkfunTokenAmount = applySellPct(tokenAmount, sellPct);

        const { buildBonkfunSellInstructions } = await import('./bonkfunSellExecutor.js');
        const bonkfunResult = await buildBonkfunSellInstructions({
          runtime,
          mint,
          user,
          tokenAmount: bonkfunTokenAmount,
          slippageBps: params.slippageBps,
        });

        if (!bonkfunResult) {
          return { success: false, signature: null, error: 'Failed to build BonkFun sell instructions (pool graduated or invalid)' };
        }

        // Execute BonkFun sell with retry logic
        let bonkfunSellConfirmed = false;
        let bonkfunSignature: string | null = null;
        let bonkfunLastError: string | null = null;

        for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
          // Check if pool graduated mid-retry — re-route to Jupiter
          if (attempt > 0) {
            try {
              const recheckPool = await container.connection.getAccountInfo(bonkfunPoolPDA);
              if (recheckPool?.data) {
                const recheckParsed = parsePoolStateData(Buffer.from(recheckPool.data), mint.toBase58());
                if (recheckParsed?.complete) {
                  logger.info('BonkFun pool graduated during sell retry — falling through to Jupiter', { tradeId, attempt });
                  bonkfunGraduated = true;
                  break; // Fall through to PumpFun/Jupiter path below
                }
              }
            } catch {}
          }

          logger.info('BonkFun sell attempt', { tradeId, attempt, minSolOut: bonkfunResult.minSolOutput.toString() });

          const txResult = await container.txBuilder.build({
            feePayer: user,
            instructions: bonkfunResult.instructions,
          });

          const sendResult = await container.sellSendCoordinator.signAndSend({
            tradeId: `bonkfun-sell-${tradeId}-${sellSendRunId}-attempt-${attempt}`,
            transaction: txResult.transaction,
          });

          bonkfunSignature = sendResult.sendResult?.signature ?? bonkfunSignature;
          bonkfunLastError = sendResult.error ?? null;

          if (!bonkfunLastError && bonkfunSignature) {
            const confirmError = await confirmSubmittedTransaction(
              bonkfunSignature,
              txResult.blockhash,
              txResult.lastValidBlockHeight,
            );
            if (!confirmError) {
              bonkfunSellConfirmed = true;
              break;
            }
            bonkfunLastError = confirmError;
          }

          if (attempt < MAX_TX_RETRIES) {
            await delay(RETRY_DELAY_MS);
          }
        }

        if (bonkfunSellConfirmed && bonkfunSignature) {
          logger.info('BonkFun SELL confirmed', { tradeId, signature: bonkfunSignature });

          // Get confirmed on-chain amount BEFORE saving to DB
          let confirmedSol = bonkfunResult.expectedSolOutput;
          try {
            const accounting = await getConfirmedSellAmountSol({
              connection: container.connection,
              signature: bonkfunSignature,
              wallet: user,
              fallbackLamports: bonkfunResult.expectedSolOutput,
              tradeId,
            });
            confirmedSol = accounting.amountSolLamports;
          } catch {
            logger.warn('BonkFun on-chain sell accounting failed — using estimate', { tradeId });
          }

          // Record trade in DB with confirmed amounts
          try {
            await saveTrade(container, {
              id: `sell-${tradeId}-${sellSendRunId}` as any,
              mint: pos.mint,
              side: 'SELL' as any,
              status: 'CONFIRMED' as any,
              amountSol: confirmedSol,
              amountTokens: bonkfunTokenAmount,
              signature: bonkfunSignature,
              slot: null,
              submittedAt: Date.now(),
              confirmedAt: Date.now(),
              failureReason: null,
              exitReason: params.reason ?? null,
            });
          } catch (saveErr: unknown) {
            logger.error('Failed to save BonkFun sell trade', {
              tradeId,
              error: saveErr instanceof Error ? saveErr.message : String(saveErr),
            });
          }

          // Record PnL and activate cooldown
          try {
            const entrySolLamports = pos.entryAmountSol ?? 0n;
            const proportionalEntry = params.reason === 'SCALE_OUT' && pos.entryAmountTokens && pos.entryAmountTokens > 0n
              ? entrySolLamports * bonkfunTokenAmount / pos.entryAmountTokens
              : entrySolLamports;
            const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
            const pnlUsd = Number(confirmedSol - proportionalEntry) / 1e9 * solPriceUsd;
            recordPnlAndRisk(container, pnlUsd, params.reason, tradeId, pos.mint);
          } catch (pnlErr: unknown) {
            logger.error('BonkFun PnL recording failed — activating cooldown anyway', {
              tradeId,
              error: pnlErr instanceof Error ? pnlErr.message : String(pnlErr),
            });
            container.cooldownManager.activateCooldown();
          }

          // For SCALE_OUT: don't transition to EXITED — strategy handles it
          if (params.reason !== 'SCALE_OUT') {
            positionRegistry.transition(tradeId, 'EXITED', params.reason);
          }

          // Fire-and-forget: reclaim rent from empty token account
          reclaimSingleAccount({
            connection: container.connection,
            mint,
            owner: user,
            tokenProgram,
            txBuilder: container.txBuilder,
            sendCoordinator: container.sendCoordinator,
          }).catch((err: unknown) => {
            logger.warn('BonkFun post-sell rent reclaim failed (non-blocking)', {
              tradeId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          return { success: true, signature: bonkfunSignature, error: null };
        } else if (!bonkfunGraduated) {
          // BonkFun sell failed (NOT due to graduation) — return failure
          logger.error('BonkFun SELL failed after all retries', {
            tradeId,
            lastError: bonkfunLastError,
            signature: bonkfunSignature,
          });
          container.cooldownManager.activateCooldown();
          return { success: false, signature: bonkfunSignature, error: bonkfunLastError ?? 'BonkFun sell failed' };
        }
        // bonkfunGraduated === true → fall through to Jupiter path below
        logger.info('BonkFun graduated — falling through to Jupiter sell path', { tradeId });
      }
    }

    // ── Fetch Bonding Curve State (PumpFun path) ─────────────────
    const bcPDA = deriveBondingCurvePDA(mint);
    const bcAccount = await container.connection.getAccountInfo(bcPDA);

    // For BonkFun-graduated tokens: bonding curve doesn't exist.
    // Route directly to Jupiter sell (same path as PumpFun graduation).
    if (bonkfunGraduated && (!bcAccount?.data || bcAccount.data.length < 49)) {
      logger.info('BonkFun graduated — no bonding curve, routing to Jupiter', { tradeId });
      return executeJupiterSell();
    }

    let minSolOutput = 0n;
    let expectedSolOutput = 0n;
    let creator: PublicKey | null = null;
    let feeRecipient: PublicKey | undefined;
    let buybackFeeRecipient: PublicKey | undefined;

    if (bcAccount?.data && bcAccount.data.length >= 49) {
      const parsed = parseBondingCurveData(bcAccount.data);
      if (!parsed) {
        return { success: false, signature: null, error: 'Failed to parse bonding curve data' };
      }
      const state: BondingCurveState = {
        mint: pos.mint,
        bondingCurveAddress: bcPDA,
        virtualTokenReserves: parsed.virtualTokenReserves,
        virtualSolReserves: parsed.virtualSolReserves,
        realTokenReserves: parsed.realTokenReserves,
        realSolReserves: parsed.realSolReserves,
        complete: parsed.complete,
      };
      creator = parsed.creator;

      if (!creator) {
        return { success: false, signature: null, error: 'Bonding curve creator missing from account data' };
      }

      // ── Venue Routing: Pumpfun vs Jupiter ───────────────────────
      if (state.complete) {
        // Token has graduated → use Jupiter for sell
        logger.info('Token graduated — routing to Jupiter', { tradeId, mint: pos.mint });
        return executeJupiterSell();
      }

      // ── Bonding Curve Sell (not graduated) ──────────────────────
      // Token balance and quote are fetched INSIDE the retry loop so each
      // attempt uses fresh data. Previously these were fetched once before
      // the loop, causing stale minSolOutput on retries.
      tokenAmount = await getUserTokenBalance(user, mint, tokenProgram);
      if (sellPct < 100) {
        tokenAmount = tokenAmount * BigInt(sellPct) / 100n;
      }
      if (tokenAmount === 0n) {
        logger.error('No token balance in user ATA — cannot sell', { tradeId });
        return { success: false, signature: null, error: 'No token balance in user ATA' };
      }

      const [globalAccount, feeConfigAccount, mintSupplyResult] = await Promise.all([
        container.connection.getAccountInfo(GLOBAL_PDA),
        container.connection.getAccountInfo(PUMP_FEE_CONFIG_PDA),
        container.connection.getTokenSupply(mint),
      ]);
      if (!globalAccount) {
        return { success: false, signature: null, error: 'Pump.fun global account missing' };
      }
      const global = pumpSdk.decodeGlobal(globalAccount);
      const feeConfig = feeConfigAccount ? pumpSdk.decodeFeeConfig(feeConfigAccount) : null;
      const mintSupply = toBN(mintSupplyResult.value.amount);
      const bondingCurve = buildOfficialPumpfunBondingCurve(parsed, mintSupplyResult.value.amount);
      const sellQuote = quoteOfficialPumpfunSell({
        global,
        feeConfig,
        mintSupply,
        bondingCurve,
        tokenAmount,
        slippageBps: SLIPPAGE_BPS,
      });

      expectedSolOutput = sellQuote.expectedSolOutput;
      minSolOutput = sellQuote.minSolOutput;
      feeRecipient = sellQuote.feeAccounts.feeRecipient;
      buybackFeeRecipient = sellQuote.feeAccounts.buybackFeeRecipient;
    }

    if (!creator && !bonkfunGraduated) {
      return { success: false, signature: null, error: 'Bonding curve account missing or creator unavailable' };
    }
    const sellCreator = creator!;

    // ── Build & Send Pumpfun Sell TX ──────────────────────────────
    // Sell needs the same confirmation/retry discipline as buy. A signature
    // from sendRawTransaction only means RPC accepted it; if the tx expires
    // before landing, token balance remains and we must retry with a fresh
    // blockhash/send id instead of marking the exit complete.
    let signature: string | null = null;
    let confirmationError: string | null = null;
    let sellConfirmed = false;

    for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
      if (attempt > 0) {
        logger.info('Retrying SELL TX with fresh blockhash', { tradeId, attempt });
        await delay(RETRY_DELAY_MS);

        // Re-fetch fresh token balance and quote on retry — bonding curve
        // state may have changed, and token balance may differ if a
        // previous TX landed but confirmation timed out.
        tokenAmount = await getUserTokenBalance(user, mint, tokenProgram);
        if (tokenAmount === 0n) {
          logger.info('Token balance zero after retry — sell likely landed', { tradeId });
          sellConfirmed = true;
          break;
        }
        if (sellPct < 100) {
          tokenAmount = tokenAmount * BigInt(sellPct) / 100n;
        }

        try {
          const [bcAccountRetry, globalAccount, feeConfigAccount, mintSupplyResult] = await Promise.all([
            container.connection.getAccountInfo(bcPDA),
            container.connection.getAccountInfo(GLOBAL_PDA),
            container.connection.getAccountInfo(PUMP_FEE_CONFIG_PDA),
            container.connection.getTokenSupply(mint),
          ]);
          if (globalAccount && bcAccountRetry?.data && bcAccountRetry.data.length >= 49) {
            const parsedRetry = parseBondingCurveData(bcAccountRetry.data);
            if (parsedRetry) {
              // CRITICAL: Check if bonding curve graduated during retry.
              // If so, break out of BC retry loop — sell needs to go through Jupiter.
              if (parsedRetry.complete) {
                logger.warn('Bonding curve graduated during sell retry — need Jupiter route', {
                  tradeId, attempt,
                });
                // Mark as not confirmed so outer code can re-route
                sellConfirmed = false;
                break;
              }
              const global = pumpSdk.decodeGlobal(globalAccount);
              const feeConfig = feeConfigAccount ? pumpSdk.decodeFeeConfig(feeConfigAccount) : null;
              const mintSupply = toBN(mintSupplyResult.value.amount);
              const bondingCurve = buildOfficialPumpfunBondingCurve(parsedRetry, mintSupplyResult.value.amount);
              const sellQuote = quoteOfficialPumpfunSell({
                global, feeConfig, mintSupply, bondingCurve, tokenAmount, slippageBps: SLIPPAGE_BPS,
              });
              expectedSolOutput = sellQuote.expectedSolOutput;
              minSolOutput = sellQuote.minSolOutput;
              feeRecipient = sellQuote.feeAccounts.feeRecipient;
              buybackFeeRecipient = sellQuote.feeAccounts.buybackFeeRecipient;
              logger.info('Sell quote refreshed on retry', {
                tradeId, attempt, minSolOutput: minSolOutput.toString(),
              });
            }
          }
        } catch (quoteErr: unknown) {
          logger.warn('Failed to refresh sell quote on retry — using previous values', {
            tradeId, attempt, error: quoteErr instanceof Error ? quoteErr.message : String(quoteErr),
          });
        }
      }

      const instructions = await buildPumpfunSellInstructions({
        runtime,
        mint,
        user,
        tokenProgram,
        tokenAmount,
        minSolOutput,
        creator: sellCreator,
        feeRecipient,
        buybackFeeRecipient,
      });
      const txResult = await container.txBuilder.build({
        feePayer: user,
        instructions,
      });

      const sendResult = await container.sellSendCoordinator.signAndSend({
        tradeId: `sell-${tradeId}-${sellSendRunId}-attempt-${attempt}`,
        transaction: txResult.transaction,
      });

      signature = sendResult.sendResult?.signature ?? signature;
      confirmationError = sendResult.error;
      if (!confirmationError && signature) {
        logger.info('SELL TX submitted, waiting for confirmation...', { tradeId, signature, attempt });
        confirmationError = await confirmSubmittedTransaction(
          signature,
          txResult.blockhash,
          txResult.lastValidBlockHeight,
        );
        if (confirmationError) {
          logger.error('SELL TX FAILED ON-CHAIN', { tradeId, signature, attempt, onChainError: confirmationError });
        } else {
          logger.info('SELL TX CONFIRMED ON-CHAIN!', { tradeId, signature, attempt });
          sellConfirmed = true;
          break;
        }
      }

      if (confirmationError && isPermanentError(confirmationError)) {
        logger.warn('Permanent SELL error — not retrying', { tradeId, error: confirmationError });
        break;
      }
    }

    // Save sell trade to DB. Use confirmed transaction meta for accounting;
    // expectedSolOutput is only a fallback if RPC cannot return meta after a
    // confirmed sell. Failed sells record zero proceeds.

    // If BC sell failed because bonding curve graduated during retry,
    // do NOT record as failed — let exit monitor re-route to Jupiter next poll.
    if (!sellConfirmed && signature === null && confirmationError === null) {
      // Graduation detected during retry — position stays ENTERED,
      // exit monitor will pick it up and route to Jupiter.
      logger.info('BC sell incomplete due to graduation — will retry via Jupiter', { tradeId });
      return { success: false, signature: null, error: 'Bonding curve graduated — retry via Jupiter' };
    }

    let confirmedSellAmountSol = 0n;
    try {
      const sellAccounting = sellConfirmed && signature
        ? await getConfirmedSellAmountSol({
          connection: container.connection,
          signature,
          wallet: user,
          fallbackLamports: expectedSolOutput,
          tradeId,
        })
        : {
          amountSolLamports: sellConfirmed ? expectedSolOutput : 0n,
          walletDeltaLamports: sellConfirmed ? expectedSolOutput : 0n,
          feeLamports: 0n,
          rentPaidLamports: 0n,
          rentRefundedLamports: 0n,
        };
      confirmedSellAmountSol = sellAccounting.amountSolLamports;
      logger.info('SELL on-chain accounting resolved', {
        tradeId,
        amountSolLamports: confirmedSellAmountSol.toString(),
        walletDeltaLamports: sellAccounting.walletDeltaLamports.toString(),
        feeLamports: sellAccounting.feeLamports.toString(),
        rentPaidLamports: sellAccounting.rentPaidLamports.toString(),
        rentRefundedLamports: sellAccounting.rentRefundedLamports.toString(),
      });
    } catch (accountingErr: unknown) {
      logger.error('SELL on-chain accounting failed — using fallback', {
        tradeId,
        error: accountingErr instanceof Error ? accountingErr.message : String(accountingErr),
      });
      confirmedSellAmountSol = sellConfirmed ? expectedSolOutput : 0n;
    }

    // CRITICAL: Save trade and transition position MUST both run even if
    // one fails. Previously saveTrade failure would skip position cleanup,
    // leaving the position ENTERED forever.
    try {
      await saveTrade(container, {
        id: `sell-${tradeId}-${sellSendRunId}`,
        mint: pos.mint,
        side: 'SELL',
        status: sellConfirmed ? 'CONFIRMED' : 'FAILED',
        amountSol: confirmedSellAmountSol,
        amountTokens: tokenAmount,
        signature,
        slot: null,
        submittedAt: nowMs(),
        confirmedAt: sellConfirmed ? nowMs() : null,
        failureReason: sellConfirmed ? null : confirmationError,
        exitReason: params.reason ?? null,
      });
    } catch (saveErr: unknown) {
      logger.error('Failed to save sell trade to DB', {
        tradeId,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    }

    if (!sellConfirmed) {
      // Activate cooldown even on failed sell to prevent buy-fail loop
      container.cooldownManager.activateCooldown();
      return { success: false, signature, error: confirmationError ?? 'Sell confirmation failed' };
    }

    // Untrack position (only on confirmed success)
    // For SCALE_OUT: don't transition to EXITED — strategy handles it
    if (params.reason !== 'SCALE_OUT') {
      positionRegistry.transition(tradeId, 'EXITED', params.reason);
    }
    logger.info('Position untracked', { tradeId });

    // Fire-and-forget: reclaim rent from empty token account
    reclaimSingleAccount({
      connection: container.connection,
      mint,
      owner: user,
      tokenProgram,
      txBuilder: container.txBuilder,
      sendCoordinator: container.sendCoordinator,
    }).catch((err: unknown) => {
      logger.warn('Post-sell rent reclaim failed (non-blocking)', {
        tradeId,
        mint: pos.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Issue 4 fix: Calculate actual P&L from confirmed on-chain trade amounts
    // CRITICAL: recordPnlAndRisk MUST run even if P&L calculation throws.
    // Without this, cooldown is never activated and the bot immediately
    // re-buys the same token after a loss.
    try {
      const entrySolLamports = pos.entryAmountSol ?? 0n;
      // For SCALE_OUT: use proportional entry cost based on actual tokens sold vs original
      const proportionalEntry = params.reason === 'SCALE_OUT' && pos.entryAmountTokens && pos.entryAmountTokens > 0n
        ? entrySolLamports * tokenAmount / pos.entryAmountTokens
        : entrySolLamports;
      const exitSolLamports = confirmedSellAmountSol;
      const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
      const pnlUsd = Number(exitSolLamports - proportionalEntry) / 1e9 * solPriceUsd;
      recordPnlAndRisk(container, pnlUsd, params.reason, tradeId, pos.mint);
    } catch (pnlErr: unknown) {
      logger.error('P&L recording failed — activating cooldown anyway', {
        tradeId,
        reason: params.reason,
        error: pnlErr instanceof Error ? pnlErr.message : String(pnlErr),
      });
      // Cooldown MUST activate even if P&L calc fails, otherwise bot
      // immediately re-buys after a loss
      container.cooldownManager.activateCooldown();
    }

    return {
      success: true,
      signature,
      error: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('SELL FAILED', { tradeId, error: msg });
    // Activate cooldown even on unhandled exception to prevent buy-fail loop
    try {
      container.cooldownManager.activateCooldown();
    } catch (_) {
      // Best effort — don't mask original error
    }
    return { success: false, signature: null, error: msg };
  }
}
