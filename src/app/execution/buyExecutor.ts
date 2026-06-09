import { PublicKey } from '@solana/web3.js';
import type { BuyParams, BuyResult } from '../../strategies/filteredSniper/filteredSniperStrategy.js';
import type { MintAddress, BondingCurveState } from '../../core/types/token.js';
import type { TradeRecord } from '../../core/types/trade.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { MIN_BONKFUN_POOL_STATE_SIZE } from '../../core/constants/programs.js';
import { nowMs } from '../../core/utils/time.js';
import { computeEntryPriceScaled } from '../../core/utils/price.js';
import { deriveBondingCurvePDA } from '../../adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from '../../adapters/protocols/pumpfun/tokenParser.js';

import { composeSwapInstructions } from '../../execution/tx/txComposer.js';
import { DEFAULT_PUMPFUN_COMPUTE_BUDGET } from '../../execution/tx/computeBudgetBuilder.js';
import { DEFAULT_MIN_TRADE_BALANCE_LAMPORTS } from '../../core/constants/defaults/infrastructure.js';
import { buildUserAtaCreateInstruction } from '../../execution/tx/ataBuilder.js';
import { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, toBN } from '../../adapters/protocols/pumpfun/officialPumpSdk.js';
import { buildOfficialPumpfunBondingCurve, quoteOfficialPumpfunBuy } from '../../adapters/protocols/pumpfun/officialPumpfunQuote.js';
import type { ExecutionRuntime } from './runtime.js';
import { runRiskGuards } from './riskGuardRunner.js';
import { saveTrade } from './tradeRecorder.js';
import { getConfirmedBuyAmountSol } from './onChainAccounting.js';

const logger = createLogger('app:execution:buy');

export async function executeBuy(params: BuyParams, runtime: ExecutionRuntime): Promise<BuyResult> {
  const {
    container,
    positionRegistry,
    pumpSdk,
    maxTxRetries: MAX_TX_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
    delay,
    computePositionSizeLamports,
    getMintTokenProgram,
    isPermanentError,
  } = runtime;
  const tradeId = runtime.nextTradeId();
  const mint = new PublicKey(params.mint);
  const user = container.signer.getPublicKey();

  // ── Balance Check (EARLY — before risk guards + position reserve) ───
  const walletBalance = await container.connection.getBalance(user);
  const balanceLamports = BigInt(walletBalance);

  // Minimum balance to execute ANY trade (position size + fees + rent)
  // ~$0.10 position + 0.001 SOL fees + 0.002 SOL rent ≈ 0.005 SOL
  const MIN_TRADE_BALANCE = DEFAULT_MIN_TRADE_BALANCE_LAMPORTS; // 0.005 SOL

  if (balanceLamports < MIN_TRADE_BALANCE) {
    const balanceSol = (walletBalance / 1e9).toFixed(6);
    const activePositions = positionRegistry.getActiveCount();

    if (activePositions > 0) {
      // Active positions exist — block buy but DON'T kill switch
      // Bot must keep running to monitor and sell existing positions
      logger.warn('BUY BLOCKED — balance too low, but active positions still monitored', {
        tradeId,
        balanceSol,
        activePositions,
        minTradeSol: '0.015',
      });
      return {
        success: false,
        tradeId,
        signature: null,
        error: `Balance too low to buy: ${balanceSol} SOL — ${activePositions} positions still active`,
      };
    }

    // No active positions — safe to kill switch
    logger.error('BUY BLOCKED — wallet balance too low, no active positions, activating kill switch', {
      tradeId,
      balanceLamports: walletBalance.toString(),
      balanceSol,
      minTradeSol: '0.015',
    });
    container.killSwitch.kill(
      `Wallet balance too low to trade: ${balanceSol} SOL (min 0.015 SOL)`,
      'balance-guard',
    );
    return {
      success: false,
      tradeId,
      signature: null,
      error: `Wallet balance too low to trade: ${balanceSol} SOL — kill switch activated`,
    };
  }

  // ── Risk Guard Checks ──────────────────────────────────────────
  const riskCheck = await runRiskGuards(container);
  if (!riskCheck.allowed) {
    logger.warn('BUY BLOCKED — risk guard failed', { tradeId, reason: riskCheck.reason });
    return { success: false, tradeId, signature: null, error: riskCheck.reason ?? 'Risk guard failed' };
  }

  // ── Atomic re-check + register (race condition guard) ───────────
  // Two concurrent buys can both pass runRiskGuards() before either registers.
  // Re-check position count SYNCHRONOUSLY right before register — JS single-
  // thread guarantees this check+register is atomic (no await in between).
  const activeCount = positionRegistry.getActiveCount();
  if (activeCount >= container.maxExposureGuard.maxConcurrentPositions) {
    logger.warn('BUY BLOCKED — position slot taken by concurrent buy', {
      tradeId, activeCount, maxPositions: container.maxExposureGuard.maxConcurrentPositions,
    });
    return { success: false, tradeId, signature: null, error: 'Max positions reached (concurrent buy)' };
  }
  logger.info('All risk guards passed', { tradeId });

  // ── Reserve Position Slot (race condition guard) ─────────────────
  // Register a PENDING (ENTERING) position IMMEDIATELY after guards pass.
  // This blocks concurrent buys from passing the max exposure check,
  // because getActiveCount() includes ENTERING positions.
  // On success: overwritten by full ENTERED position below.
  // On failure: transitioned to EXITED to free the slot.
  positionRegistry.register({
    id: tradeId,
    mint: params.mint as MintAddress,
    status: 'ENTERING',
    tradeId,
    entryAmountSol: null,
    entryAmountTokens: null,
    entryPriceSol: null,
    entryTimestamp: null,
    currentPnlPercent: null,
    exitReason: null,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  });
  logger.info('Position slot reserved (ENTERING)', { tradeId });

  // ── Position Sizing ─────────────────────────────────────────────
  // Fetch live SOL price from oracle
  const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
  const positionSizeLamports = computePositionSizeLamports(solPriceUsd, params.positionSizeUsd);

  logger.info('EXECUTE BUY — building TX', {
    mint: params.mint,
    venue: params.venue,
    positionSizeUsd: params.positionSizeUsd,
    slippageBps: params.slippageBps,
    solPriceUsd,
    solAmountLamports: positionSizeLamports.toString(),
    tradeId,
  });

  // ── Balance Check (position size) ────────────────────────────────
  // Balance already checked above for MIN_TRADE_BALANCE (0.015 SOL).
  // Now check if enough for actual position size + ATA rent + TX fees.
  // ATA rent ≈ 0.00203928 SOL (2,039,280 lamports) for SPL token account
  // TX fees ≈ 0.001 SOL (1,000,000 lamports)
  const ATA_RENT_LAMPORTS = 2_039_280n;
  const TX_FEE_LAMPORTS = 1_000_000n;
  const minRequired = positionSizeLamports + ATA_RENT_LAMPORTS + TX_FEE_LAMPORTS;

  if (balanceLamports < minRequired) {
    const balanceSol = (walletBalance / 1e9).toFixed(6);
    const requiredSol = (Number(minRequired) / 1e9).toFixed(6);
    const activePositions = positionRegistry.getActiveCount();

    if (activePositions > 0) {
      // Active positions exist — block buy but DON'T kill switch
      logger.warn('BUY BLOCKED — insufficient balance for position, active positions still monitored', {
        tradeId,
        balanceSol,
        requiredSol,
        activePositions,
      });
      positionRegistry.transition(tradeId, 'EXITED', 'insufficient balance');
      return {
        success: false,
        tradeId,
        signature: null,
        error: `Insufficient balance: ${balanceSol} SOL < ${requiredSol} SOL — ${activePositions} positions still active`,
      };
    }

    // No active positions — safe to kill switch
    logger.warn('BUY BLOCKED — insufficient balance, no active positions, activating kill switch', {
      tradeId,
      balanceSol,
      requiredSol,
    });
    container.killSwitch.kill(
      `Insufficient balance: ${balanceSol} SOL < ${requiredSol} SOL required`,
      'balance-guard',
    );
    positionRegistry.transition(tradeId, 'EXITED', 'insufficient balance');
    return {
      success: false,
      tradeId,
      signature: null,
      error: `Insufficient balance: ${balanceSol} SOL < ${requiredSol} SOL — kill switch activated`,
    };
  }
  logger.info('Balance check passed', {
    tradeId,
    balanceLamports: walletBalance.toString(),
    balanceSol: (walletBalance / 1e9).toFixed(6),
  });

  // ── Venue Detection: BonkFun vs PumpFun ──────────────────────────
  let lastError: string | null = null;
  let lastSignature: string | null = null;

  // Check if this token is a BonkFun (Raydium LaunchLab) token.
  // If pool state PDA exists with BonkFun platform config → route to BonkFun buy.
  const { derivePoolStatePDA: deriveBonkfunPoolPDA } = await import('../../adapters/protocols/bonkfun/shared.js');
  const { parsePoolStateData, isBonkfunToken } = await import('../../adapters/protocols/bonkfun/tokenParser.js');

  const bonkfunPoolPDA = deriveBonkfunPoolPDA(mint);
  const bonkfunPoolAccount = await container.connection.getAccountInfo(bonkfunPoolPDA);

  if (bonkfunPoolAccount?.data && bonkfunPoolAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
    const parsedPool = parsePoolStateData(Buffer.from(bonkfunPoolAccount.data), mint.toBase58());
    if (parsedPool && isBonkfunToken(parsedPool)) {
      logger.info('BonkFun token detected — routing to BonkFun buy', { tradeId, mint: params.mint });

      const { buildBonkfunBuyInstructions } = await import('./bonkfunBuyExecutor.js');
      const runtimeForBonkfun: ExecutionRuntime = {
        container,
        positionRegistry,
        pumpSdk,
        maxTxRetries: MAX_TX_RETRIES,
        retryDelayMs: RETRY_DELAY_MS,
        delay,
        getMintTokenProgram,
        getUserTokenBalance: (async () => 0n) as any, // Stub: BonkFun path has own balance check
        confirmSubmittedTransaction: (async () => null) as any, // Stub: BonkFun path has own confirmation (lines 288-336)
        isPermanentError,
        nextTradeId: () => tradeId,
        computePositionSizeLamports: () => positionSizeLamports,
      };
      const bonkfunResult = await buildBonkfunBuyInstructions({
        runtime: runtimeForBonkfun,
        mint,
        user,
        solAmount: positionSizeLamports,
      });

      if (!bonkfunResult) {
        positionRegistry.transition(tradeId, 'EXITED', 'BonkFun pool invalid or graduated');
        return { success: false, tradeId, signature: null, error: 'Failed to build BonkFun buy instructions' };
      }

      // Execute BonkFun buy with retry
      for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
        if (attempt > 0) {
          logger.info('Retrying BonkFun buy', { tradeId, attempt });
          await delay(RETRY_DELAY_MS);
        }

        try {
          // Balance re-check before submit
          const currentBalance = await container.connection.getBalance(user);
          const minRequiredAtSubmit = positionSizeLamports + 2_039_280n + 500_000n;
          if (BigInt(currentBalance) < minRequiredAtSubmit) {
            logger.warn('BonkFun BUY BLOCKED — balance insufficient at submit', { tradeId });
            positionRegistry.transition(tradeId, 'EXITED', 'insufficient balance at submit');
            return { success: false, tradeId, signature: null, error: 'Balance insufficient at submit time' };
          }

          const txResult = await container.txBuilder.build({
            feePayer: user,
            instructions: bonkfunResult.instructions,
          });

          const sendResult = await container.sendCoordinator.signAndSend({
            tradeId: `bonkfun-buy-${tradeId}-attempt-${attempt}`,
            transaction: txResult.transaction,
          });

          if (sendResult.error) {
            lastError = sendResult.error;
            logger.error('BonkFun BUY FAILED', { tradeId, attempt, error: sendResult.error });
            if (isPermanentError(sendResult.error)) break;
            continue;
          }

          const signature = sendResult.sendResult?.signature ?? null;
          if (!signature) {
            lastError = 'Send succeeded but no signature returned';
            logger.error('BonkFun BUY FAILED — no signature', { tradeId, attempt });
            continue;
          }

          lastSignature = signature;

          // ── TX Confirmation (same pattern as PumpFun) ──────────────
          logger.info('BonkFun TX submitted, waiting for confirmation...', { tradeId, signature });
          try {
            const confirmation = await container.connection.confirmTransaction(
              { signature, blockhash: txResult.blockhash, lastValidBlockHeight: txResult.lastValidBlockHeight },
              'confirmed',
            );
            if (confirmation.value.err) {
              const onChainErr = JSON.stringify(confirmation.value.err);
              lastError = onChainErr;
              logger.error('BonkFun TX FAILED ON-CHAIN', { tradeId, signature, attempt, onChainError: onChainErr });
              if (isPermanentError(onChainErr)) break;
              continue;
            }
            logger.info('BonkFun TX CONFIRMED ON-CHAIN!', { tradeId, signature });
          } catch (confirmErr: unknown) {
            const cmsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
            lastError = cmsg;
            logger.error('BonkFun TX CONFIRMATION FAILED', { tradeId, signature, attempt, error: cmsg });

            // CRITICAL: Check if TX actually landed before retrying (prevent double-buy)
            try {
              const status = await container.connection.getSignatureStatus(signature);
              if (status?.value?.confirmationStatus === 'confirmed' ||
                  status?.value?.confirmationStatus === 'finalized') {
                logger.warn('BonkFun TX actually confirmed despite error — proceeding', { tradeId, signature });
              } else if (status?.value?.err) {
                logger.info('BonkFun TX confirmed as failed — safe to retry', { tradeId, signature });
                if (isPermanentError(cmsg)) break;
                continue;
              } else {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const recheck = await container.connection.getSignatureStatus(signature);
                if (recheck?.value?.confirmationStatus === 'confirmed' ||
                    recheck?.value?.confirmationStatus === 'finalized') {
                  logger.warn('BonkFun TX confirmed on recheck — proceeding', { tradeId, signature });
                } else {
                  logger.warn('BonkFun TX still unconfirmed — retrying', { tradeId, signature });
                  if (isPermanentError(cmsg)) break;
                  continue;
                }
              }
            } catch (statusErr: unknown) {
              logger.error('Failed to check BonkFun TX status — retrying', {
                tradeId, signature,
                error: statusErr instanceof Error ? statusErr.message : String(statusErr),
              });
              if (isPermanentError(cmsg)) break;
              continue;
            }
          }

          // ── On-chain Accounting ────────────────────────────────────
          // Get actual SOL spent from the confirmed transaction
          let actualAmountSol = positionSizeLamports;
          try {
            const accounting = await getConfirmedBuyAmountSol({
              connection: container.connection,
              signature,
              wallet: user,
              fallbackLamports: positionSizeLamports,
              tradeId,
            });
            actualAmountSol = accounting.amountSolLamports;
          } catch {
            logger.warn('BonkFun on-chain accounting failed — using fallback', { tradeId });
          }

          logger.info('BonkFun BUY confirmed', {
            tradeId,
            signature,
            expectedTokens: bonkfunResult.expectedTokenOut.toString(),
            actualSolSpent: actualAmountSol.toString(),
          });

          // Register position (entryPriceSol = per-token price in lamports)
          const entryTokens = bonkfunResult.expectedTokenOut;
          positionRegistry.register({
            id: tradeId,
            mint: params.mint as any,
            status: 'ENTERED' as any,
            tradeId,
            entryAmountSol: actualAmountSol,
            entryAmountTokens: entryTokens,
            entryPriceSol: computeEntryPriceScaled(actualAmountSol, entryTokens),
            entryTimestamp: Date.now(),
            currentPnlPercent: null,
            exitReason: null,
            createdAt: nowMs(),
            updatedAt: nowMs(),
          } as any);

          // Save trade to DB
          try {
            await saveTrade(container, {
              id: tradeId as any,
              mint: params.mint,
              side: 'BUY' as any,
              status: 'CONFIRMED' as any,
              amountSol: actualAmountSol,
              amountTokens: bonkfunResult.expectedTokenOut,
              signature,
              slot: null,
              submittedAt: Date.now(),
              confirmedAt: Date.now(),
              failureReason: null,
              exitReason: null,
            });
          } catch (saveErr: unknown) {
            logger.error('Failed to save BonkFun buy trade', {
              tradeId,
              error: saveErr instanceof Error ? saveErr.message : String(saveErr),
            });
          }

          // Record trade in throttle (prevents exceeding trade rate limit)
          container.tradeThrottle.recordTrade();

          return { success: true, tradeId, signature, error: null };
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
          logger.error('BonkFun buy attempt error', { tradeId, attempt, error: lastError });
        }
      }

      // All retries exhausted — save FAILED record to DB
      logger.error('BonkFun BUY failed after all retries', { tradeId, lastError });
      try {
        await saveTrade(container, {
          id: tradeId as any,
          mint: params.mint,
          side: 'BUY' as any,
          status: 'FAILED' as any,
          amountSol: 0n,
          amountTokens: 0n,
          signature: lastSignature,
          slot: null,
          submittedAt: Date.now(),
          confirmedAt: null,
          failureReason: lastError,
          exitReason: null,
        });
        logger.error('Buy TX failed — saved failed trade to DB', {
          tradeId, mint: params.mint.slice(0, 12), error: lastError,
        });
      } catch (saveErr: unknown) {
        logger.error('Failed to save failed buy trade to DB', {
          error: saveErr instanceof Error ? saveErr.message : String(saveErr),
        });
      }
      positionRegistry.transition(tradeId, 'EXITED', `bonkfun buy failed: ${lastError}`);
      return { success: false, tradeId, signature: lastSignature, error: lastError };
    }
  }

  // ── Retry Loop (PumpFun path) ───────────────────────────────────
  for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
    if (attempt > 0) {
      logger.info('Retrying TX with fresh blockhash', { tradeId, attempt });
      await delay(RETRY_DELAY_MS);
    }

    try {
      // ── Bonding Curve Quote ───────────────────────────────────────
      // 1. Fetch bonding curve state for quote
      const bondingCurvePDA = deriveBondingCurvePDA(mint);
      const bcAccount = await container.connection.getAccountInfo(bondingCurvePDA);

      let tokenAmount = 1n;
      let maxSolCost = positionSizeLamports;
      let creator: PublicKey | null = null;
      let feeRecipient: PublicKey | undefined;
      let buybackFeeRecipient: PublicKey | undefined;

      if (bcAccount?.data && bcAccount.data.length >= 49) {
        const parsed = parseBondingCurveData(bcAccount.data);
        if (parsed) {
          const state: BondingCurveState = {
            mint: params.mint,
            bondingCurveAddress: bondingCurvePDA,
            virtualTokenReserves: parsed.virtualTokenReserves,
            virtualSolReserves: parsed.virtualSolReserves,
            realTokenReserves: parsed.realTokenReserves,
            realSolReserves: parsed.realSolReserves,
            complete: parsed.complete,
          };
          creator = parsed.creator;

          const [globalAccount, feeConfigAccount, mintSupplyResult] = await Promise.all([
            container.connection.getAccountInfo(GLOBAL_PDA),
            container.connection.getAccountInfo(PUMP_FEE_CONFIG_PDA),
            container.connection.getTokenSupply(mint),
          ]);
          if (!globalAccount) {
            throw new Error('Pump.fun global account missing');
          }

          const global = pumpSdk.decodeGlobal(globalAccount);
          const feeConfig = feeConfigAccount ? pumpSdk.decodeFeeConfig(feeConfigAccount) : null;
          const mintSupply = toBN(mintSupplyResult.value.amount);
          const bondingCurve = buildOfficialPumpfunBondingCurve(parsed, mintSupplyResult.value.amount);
          const buyQuote = quoteOfficialPumpfunBuy({
            global,
            feeConfig,
            mintSupply,
            bondingCurve,
            solBudget: positionSizeLamports,
            slippageBps: params.slippageBps,
          });

          tokenAmount = buyQuote.tokenAmount;
          maxSolCost = buyQuote.maxSolCost;
          feeRecipient = buyQuote.feeAccounts.feeRecipient;
          buybackFeeRecipient = buyQuote.feeAccounts.buybackFeeRecipient;

          logger.info('Official Pump.fun SDK quote', {
            tradeId,
            solBudget: positionSizeLamports.toString(),
            tokensOut: tokenAmount.toString(),
            maxSolCost: maxSolCost.toString(),
            realTokenReserves: state.realTokenReserves.toString(),
            feeConfigLoaded: feeConfig !== null,
          });
        }
      }

      // ── TX Build & Send ───────────────────────────────────────────
      const tokenProgram = await getMintTokenProgram(mint);
      if (!creator) {
        throw new Error('Bonding curve creator missing from account data');
      }
      logger.info('Mint token program resolved', {
        tradeId,
        tokenProgram: tokenProgram.toBase58(),
      });

      // 2. Build swap instruction via PumpfunVenue
      const swapResult = container.pumpfunVenue.buildSwap({
        mint,
        user,
        direction: 'BUY',
        tokenAmount,
        slippageAmount: maxSolCost,
        tokenProgram,
        creator,
        feeRecipient,
        buybackFeeRecipient,
      });

      logger.info('Swap instruction built', { tradeId });

      // 3. Build transaction (fresh blockhash on each attempt)
      // Pump.fun's buy instruction expects the user's token ATA to already
      // exist. Without this pre-instruction, fresh-wallet/fresh-mint buys
      // fail on-chain with Anchor 3012: AccountNotInitialized(associated_user).
      const createUserAtaIx = buildUserAtaCreateInstruction(user, user, mint, tokenProgram);
      const instructions = composeSwapInstructions({
        computeBudget: DEFAULT_PUMPFUN_COMPUTE_BUDGET,
        createAtaInstruction: createUserAtaIx,
        swapInstruction: swapResult.instruction,
      });
      const txResult = await container.txBuilder.build({
        feePayer: user,
        instructions,
      });

      logger.info('Transaction built', { tradeId, attempt });

      // 4. Balance re-check before submit (race condition guard)
      // Two concurrent buys can both pass the earlier balance check.
      // Re-check SYNCHRONOUSLY right before send — JS single-thread
      // guarantees this check+send is atomic.
      const currentBalance = await container.connection.getBalance(user);
      const minRequiredAtSubmit = positionSizeLamports + 2_039_280n + 500_000n; // ATA rent + min fee
      if (BigInt(currentBalance) < minRequiredAtSubmit) {
        logger.warn('BUY BLOCKED — balance insufficient at submit time', {
          tradeId,
          currentBalance: (currentBalance / 1e9).toFixed(6),
          required: (Number(positionSizeLamports + 500_000n) / 1e9).toFixed(6),
        });
        positionRegistry.transition(tradeId, 'EXITED', 'insufficient balance at submit');
        return {
          success: false,
          tradeId,
          signature: null,
          error: `Balance insufficient at submit time: ${(currentBalance / 1e9).toFixed(6)} SOL`,
        };
      }

      // 5. Sign and send
      const sendResult = await container.sendCoordinator.signAndSend({
        tradeId: `${tradeId}-attempt-${attempt}`,
        transaction: txResult.transaction,
      });

      if (sendResult.error) {
        lastError = sendResult.error;
        logger.error('BUY FAILED', { tradeId, attempt, error: sendResult.error });

        // Don't retry permanent errors
        if (isPermanentError(sendResult.error)) {
          logger.warn('Permanent error — not retrying', { tradeId, error: sendResult.error });
          break;
        }
        continue; // retry
      }

      // ── TX Confirmation ───────────────────────────────────────────
      // Wait for confirmation to see on-chain result
      const sig = sendResult.sendResult?.signature;
      if (!sig) {
        // Send succeeded but no signature — this is a bug in sendCoordinator.
        // Treat as failed attempt and retry.
        lastError = 'Send succeeded but no signature returned';
        logger.error('BUY FAILED — no signature from sendCoordinator', { tradeId, attempt });
        continue;
      }

      lastSignature = sig;
      logger.info('TX submitted, waiting for confirmation...', { tradeId, signature: sig });
      try {
        const confirmation = await container.connection.confirmTransaction(
          { signature: sig, blockhash: txResult.blockhash, lastValidBlockHeight: txResult.lastValidBlockHeight },
          'confirmed',
        );
        if (confirmation.value.err) {
          const onChainErr = JSON.stringify(confirmation.value.err);
          lastError = onChainErr;
          logger.error('TX FAILED ON-CHAIN', {
            tradeId, signature: sig, attempt, onChainError: onChainErr,
          });
          if (isPermanentError(onChainErr)) {
            logger.warn('Permanent on-chain error — not retrying', { tradeId });
            break;
          }
          continue; // retry
        }
        logger.info('TX CONFIRMED ON-CHAIN!', { tradeId, signature: sig });
      } catch (confirmErr: unknown) {
        const cmsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
        lastError = cmsg;
        logger.error('TX CONFIRMATION FAILED', { tradeId, signature: sig, attempt, error: cmsg });

        // CRITICAL: Before retrying, check if the TX actually landed.
        // confirmTransaction can throw on RPC timeout even though the TX
        // is confirmed on-chain. Retrying would double-buy.
        try {
          const status = await container.connection.getSignatureStatus(sig);
          if (status?.value?.confirmationStatus === 'confirmed' ||
              status?.value?.confirmationStatus === 'finalized') {
            logger.warn('TX actually confirmed despite confirmation error — proceeding', {
              tradeId, signature: sig,
            });
            // Fall through to accounting — TX landed, don't retry
          } else if (status?.value?.err) {
            logger.info('TX confirmed as failed — safe to retry', { tradeId, signature: sig });
            if (isPermanentError(cmsg)) break;
            continue;
          } else {
            // TX status unknown — could still be in-flight.
            // Wait briefly then check once more before giving up.
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const recheck = await container.connection.getSignatureStatus(sig);
            if (recheck?.value?.confirmationStatus === 'confirmed' ||
                recheck?.value?.confirmationStatus === 'finalized') {
              logger.warn('TX confirmed on recheck — proceeding', { tradeId, signature: sig });
            } else {
              logger.warn('TX still unconfirmed after recheck — retrying', { tradeId, signature: sig });
              if (isPermanentError(cmsg)) break;
              continue;
            }
          }
        } catch (statusErr: unknown) {
          logger.error('Failed to check TX status — retrying', {
            tradeId, signature: sig,
            error: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
          if (isPermanentError(cmsg)) break;
          continue;
        }
      }

      // ── On-chain Accounting (NEVER retry after confirmation) ────
      // If accounting fails, use fallback amount. NEVER trigger a retry
      // because the TX already landed on-chain — retrying would double-buy.
      let buyAccounting: { amountSolLamports: bigint; walletDeltaLamports: bigint; feeLamports: bigint; rentPaidLamports: bigint; rentRefundedLamports: bigint };
      try {
        buyAccounting = sig
          ? await getConfirmedBuyAmountSol({
            connection: container.connection,
            signature: sig,
            wallet: user,
            fallbackLamports: positionSizeLamports,
            tradeId,
          })
          : {
            amountSolLamports: positionSizeLamports,
            walletDeltaLamports: -positionSizeLamports,
            feeLamports: 0n,
            rentPaidLamports: 0n,
            rentRefundedLamports: 0n,
          };
      } catch (accountingErr: unknown) {
        const amsg = accountingErr instanceof Error ? accountingErr.message : String(accountingErr);
        logger.error('On-chain accounting failed — using fallback amount (TX already confirmed, NOT retrying)', {
          tradeId, signature: sig, error: amsg, fallbackLamports: positionSizeLamports.toString(),
        });
        buyAccounting = {
          amountSolLamports: positionSizeLamports,
          walletDeltaLamports: -positionSizeLamports,
          feeLamports: 0n,
          rentPaidLamports: 0n,
          rentRefundedLamports: 0n,
        };
      }

      logger.info('BUY SUCCESS', { tradeId, signature: sig });

      const confirmedBuyAmountSol = buyAccounting.amountSolLamports;
      logger.info('BUY on-chain accounting resolved', {
        tradeId,
        amountSolLamports: confirmedBuyAmountSol.toString(),
        walletDeltaLamports: buyAccounting.walletDeltaLamports.toString(),
        feeLamports: buyAccounting.feeLamports.toString(),
        rentPaidLamports: buyAccounting.rentPaidLamports.toString(),
        rentRefundedLamports: buyAccounting.rentRefundedLamports.toString(),
      });

      // ── Trade Recording ───────────────────────────────────────────
      // Record trade in throttle
      container.tradeThrottle.recordTrade();

      // Save trade to PostgreSQL. amountSol is derived from confirmed tx meta
      // (wallet delta minus tx fee and user-token-account rent), not the
      // configured position budget/max cost.
      const tradeRecord: TradeRecord = {
        id: tradeId,
        mint: params.mint,
        side: 'BUY',
        status: 'CONFIRMED',
        amountSol: confirmedBuyAmountSol,
        amountTokens: tokenAmount,
        signature: sig ?? null,
        slot: null,
        submittedAt: nowMs(),
        confirmedAt: nowMs(),
        failureReason: null,
        exitReason: null,
      };
      await saveTrade(container, tradeRecord);

      // ── Position Tracking ─────────────────────────────────────────
      // Track position for exit monitoring using the confirmed swap cost.
      const entryPrice = computeEntryPriceScaled(confirmedBuyAmountSol, tokenAmount);
      positionRegistry.register({
        id: tradeId,
        mint: params.mint as MintAddress,
        status: 'ENTERED',
        tradeId,
        entryAmountSol: confirmedBuyAmountSol,
        entryAmountTokens: tokenAmount,
        entryPriceSol: entryPrice,
        entryTimestamp: nowMs(),
        currentPnlPercent: null,
        exitReason: null,
        createdAt: nowMs(),
        updatedAt: nowMs(),
      });
      logger.info('Position tracked', { tradeId, mint: params.mint.slice(0, 12), entryPrice: entryPrice.toString() });

      return {
        success: true,
        tradeId,
        signature: sendResult.sendResult?.signature ?? null,
        error: null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      logger.error('BUY attempt failed', { tradeId, attempt, error: msg });
      if (isPermanentError(msg)) {
        logger.warn('Permanent error — not retrying', { tradeId });
        break;
      }
    }
  }

  // All retries exhausted or permanent error
  // Release the reserved position slot so it no longer blocks exposure
  positionRegistry.transition(tradeId, 'EXITED', 'buy failed');
  logger.info('Position slot released (EXITED) after buy failure', { tradeId });

  // Save failed trade to DB
  const failedRecord: TradeRecord = {
    id: tradeId,
    mint: params.mint,
    side: 'BUY',
    status: 'FAILED',
    amountSol: positionSizeLamports,
    amountTokens: 0n,
    signature: lastSignature,
    slot: null,
    submittedAt: nowMs(),
    confirmedAt: null,
    failureReason: lastError ?? 'Unknown',
    exitReason: null,
  };
  try {
    await saveTrade(container, failedRecord);
  } catch (saveErr: unknown) {
    logger.error('Failed to save failed buy trade to DB', {
      error: saveErr instanceof Error ? saveErr.message : String(saveErr),
    });
  }
  return {
    success: false,
    tradeId,
    signature: null,
    error: lastError ?? 'All retries exhausted',
  };
}
