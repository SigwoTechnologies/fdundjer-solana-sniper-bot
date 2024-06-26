import { Filter, FilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger, BURN_AMOUNT } from '../helpers';

export class BurnFilter implements Filter {
  private cachedResult: FilterResult | undefined = undefined;
  prevAmount: number;

  constructor(private readonly connection: Connection) {
    this.prevAmount = 0;
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    try {
      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      // logger.trace({ amount, lpmint: poolKeys.lpMint });
      amount.value.uiAmount = amount.value.uiAmount
        ? amount.value.uiAmount
        : Number(amount.value.amount) / 10 ** amount.value.decimals;
      // const burned = amount.value.uiAmount === 0 && this.prevAmount > BURN_AMOUNT;
      const burned = amount.value.uiAmount === 0 && this.prevAmount - amount.value.uiAmount > BURN_AMOUNT;
      this.prevAmount = amount.value.uiAmount;
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
