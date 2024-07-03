import { Filter, FilterResult } from './pool-filters';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger, BURN_AMOUNT } from '../helpers';
import BN from 'bn.js';
export class BurnFilter implements Filter {
  private cachedResult: FilterResult | undefined = undefined;
  oldAmount: number;

  constructor(private readonly connection: Connection) {
    this.oldAmount = 0;
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    try {
      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      // const burned = amount.value.uiAmount === 0;
      // logger.debug(`burned: ${amount.value.uiAmount}SOL`);
      // logger.trace({ lpmint: poolKeys.lpMint, uiAmount: amount.value.uiAmount });
      // console.log(poolKeys);
      const solAmount =
        amount.value.uiAmount || amount.value.uiAmount == 0
          ? amount.value.uiAmount / (LAMPORTS_PER_SOL / 10 ** 4)
          : Number(amount.value.amount) / ((LAMPORTS_PER_SOL / 10 ** 4) * amount.value.decimals);
      const burned = this.oldAmount - solAmount > BURN_AMOUNT;
      logger.debug(
        `burned: ${burned}, total: ${solAmount}SOL, burned: ${this.oldAmount - solAmount}SOL, BurnAmount: ${BURN_AMOUNT}, uiAmount: ${amount.value.uiAmount}, decimals: ${amount.value.decimals}`,
      );
      this.oldAmount = solAmount;
      const result = { ok: burned, message: burned ? undefined : "Burned -> Creator didn't burn LP" };

      if (result.ok) {
        this.cachedResult = result;
      }

      return result;
    } catch (e: any) {
      if (e.code == -32602) {
        return { ok: true };
      }

      logger.error({ mint: poolKeys.baseMint }, `Failed to check if LP is burned`);
    }

    return { ok: false, message: 'Failed to check if LP is burned' };
  }
}
