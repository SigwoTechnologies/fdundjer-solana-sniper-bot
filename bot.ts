import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep, BUY_RATE, QUOTE_MINT, CUSTOM_FEE } from './helpers';
import { Semaphore } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { Context } from 'telegraf';
import { Decimal } from 'decimal.js';

export interface BotConfig {
  walletList: Keypair[];
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  maxTokensAtTheTime: number;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  trailingStopLoss: boolean;
  skipSellingIfLostMoreThan: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
}

export class Bot {
  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  private readonly semaphore: Semaphore;
  private sellExecutionCount = 0;
  private readonly stopLoss = new Map<string, TokenAmount>();
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private quoteAmount = {} as Record<string, TokenAmount>;
  private wallet = {} as Record<string, Keypair>;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
    public TGcontext: Context,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;
    this.semaphore = new Semaphore(config.maxTokensAtTheTime);

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate(index: number) {
    const wallet = this.config.walletList[index];
    try {
      const quoteAta = getAssociatedTokenAddressSync(this.config.quoteToken.mint, wallet.publicKey);
      await getAccount(this.connection, quoteAta, this.connection.commitment);
      // await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
      return quoteAta;
    } catch (error) {
      // logger.error(
      //   `${this.config.quoteToken.symbol} token account not found in wallet${index + 1}: ${wallet.publicKey.toString()}`,
      // );
      return false;
    }
  }

  async selectWallet(neededSolAmount: Decimal): Promise<any> {
    let availableWalletList: Keypair[] = [];
    for (let i = 0; i < this.config.walletList.length; i++) {
      const quoteAta = await this.validate(i);
      if (!quoteAta) {
        continue;
      }
      let balance = new Decimal(await this.getSolBalance(quoteAta));
      console.log(`${QUOTE_MINT} Balance in wallet(${i + 1}): ${balance}`);
      if (neededSolAmount.lt(balance)) availableWalletList.push(this.config.walletList[i]);
      await sleep(20);
    }
    if (availableWalletList.length == 0) return false;

    // console.log({ availableWalletList });

    return availableWalletList[Math.floor(Math.random() * availableWalletList.length)];
  }

  async getSolBalance(walletAddress: PublicKey): Promise<Decimal> {
    try {
      return new Decimal(await this.connection.getBalance(walletAddress));
    } catch (error) {
      return new Decimal(0);
    }
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    const numberOfActionsBeingProcessed =
      this.config.maxTokensAtTheTime - this.semaphore.getValue() + this.sellExecutionCount;
    if (this.semaphore.isLocked() || numberOfActionsBeingProcessed >= this.config.maxTokensAtTheTime) {
      logger.debug(
        { mint: poolState.baseMint.toString() },
        `Skipping buy because max tokens to process at the same time is ${this.config.maxTokensAtTheTime} and currently ${numberOfActionsBeingProcessed} tokens is being processed`,
      );
      return;
    }

    await this.semaphore.acquire();

    try {
      const [market] = await Promise.all([this.marketStorage.get(poolState.marketId.toString())]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          const response = await this.connection.getTokenAccountBalance(
            poolKeys.quoteVault,
            this.connection.commitment,
          );
          const poolSize = response.value.uiAmount
            ? new Decimal(response.value.uiAmount).mul(10 ** response.value.decimals)
            : new Decimal(response.value.amount);

          this.quoteAmount[poolKeys.baseMint.toString()] = new TokenAmount(
            this.config.quoteToken,
            // `${poolSize.div(100).mul(BUY_RATE).floor()}`,
            // true,
            0.0001,
            false,
          );
          const neededSolAmount = new Decimal(this.quoteAmount[poolKeys.baseMint.toString()].raw.toString()).mul(1.1);
          // console.log({ neededSolAmount });
          const wallet = await this.selectWallet(neededSolAmount);
          if (!wallet) continue;

          this.wallet[poolKeys.baseMint.toString()] = wallet;

          const quoteAta = await getAssociatedTokenAddress(this.config.quoteToken.mint, wallet.publicKey);
          const mintAta = await getAssociatedTokenAddress(poolState.baseMint, wallet.publicKey);
          // console.log(this.quoteAmount[poolKeys.baseMint.toString()].raw.toString());
          // console.log(wallet.publicKey.toString());
          // console.log(quoteAta.toString(), mintAta.toString());

          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.quoteAmount[poolKeys.baseMint.toString()],
            this.config.buySlippage,
            wallet,
            'buy',
          );

          // console.log(result);

          if (result.confirmed) {
            this.TGcontext?.reply(`https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`);

            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      this.semaphore.release();
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    this.sellExecutionCount++;

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          const shouldSell = await this.waitForSellSignal(tokenAmountIn, poolKeys);

          if (!shouldSell) {
            return;
          }

          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const wallet = this.wallet[poolKeys.baseMint.toString()];
          const quoteAta = getAssociatedTokenAddressSync(this.config.quoteToken.mint, wallet.publicKey);

          const result = await this.swap(
            poolKeys,
            accountId,
            quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            wallet,
            'sell',
          );

          if (result.confirmed) {
            this.TGcontext?.reply(
              `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${wallet.publicKey}`,
            );
            this.TGcontext?.reply(`https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`);
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      this.sellExecutionCount--;
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    // console.log({ slippagePercent });
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    // console.log({ poolInfo });
    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });
    // console.log({ computedAmountOut });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    // console.log(...innerTransaction.instructions);
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();
    // console.log({ messageV0 });

    const transaction = new VersionedTransaction(messageV0);
    // console.log({ transaction });
    transaction.sign([wallet, ...innerTransaction.signers]);
    // console.log({ transaction });

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const filters = new PoolFilters(this.connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await filters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async waitForSellSignal(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return true;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.quoteAmount[poolKeys.baseMint.toString()]
      .mul(this.config.takeProfit)
      .numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.quoteAmount[poolKeys.baseMint.toString()].add(profitAmount);
    let stopLoss: TokenAmount;

    if (!this.stopLoss.get(poolKeys.baseMint.toString())) {
      const lossFraction = this.quoteAmount[poolKeys.baseMint.toString()]
        .mul(this.config.stopLoss)
        .numerator.div(new BN(100));
      const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
      stopLoss = this.quoteAmount[poolKeys.baseMint.toString()].subtract(lossAmount);

      this.stopLoss.set(poolKeys.baseMint.toString(), stopLoss);
    } else {
      stopLoss = this.stopLoss.get(poolKeys.baseMint.toString())!;
    }

    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut as TokenAmount;

        if (this.config.trailingStopLoss) {
          const trailingLossFraction = amountOut.mul(this.config.stopLoss).numerator.div(new BN(100));
          const trailingLossAmount = new TokenAmount(this.config.quoteToken, trailingLossFraction, true);
          const trailingStopLoss = amountOut.subtract(trailingLossAmount);

          if (trailingStopLoss.gt(stopLoss)) {
            logger.trace(
              { mint: poolKeys.baseMint.toString() },
              `Updating trailing stop loss from ${stopLoss.toFixed()} to ${trailingStopLoss.toFixed()}`,
            );
            this.stopLoss.set(poolKeys.baseMint.toString(), trailingStopLoss);
            stopLoss = trailingStopLoss;
          }
        }

        if (this.config.skipSellingIfLostMoreThan > 0) {
          const stopSellingFraction = this.quoteAmount[poolKeys.baseMint.toString()]
            .mul(this.config.skipSellingIfLostMoreThan)
            .numerator.div(new BN(100));

          const stopSellingAmount = new TokenAmount(this.config.quoteToken, stopSellingFraction, true);

          if (amountOut.lt(stopSellingAmount)) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Token dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped. Initial: ${this.quoteAmount[poolKeys.baseMint.toString()].toFixed()} | Current: ${amountOut.toFixed()}`,
            );
            this.stopLoss.delete(poolKeys.baseMint.toString());
            return false;
          }
        }

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          this.stopLoss.delete(poolKeys.baseMint.toString());
          break;
        }

        if (amountOut.gt(takeProfit)) {
          this.stopLoss.delete(poolKeys.baseMint.toString());
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return true;
  }
}
