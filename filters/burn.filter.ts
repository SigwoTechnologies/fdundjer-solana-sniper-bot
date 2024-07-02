import { Filter, FilterResult } from './pool-filters';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger, BURN_AMOUNT } from '../helpers';

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
      // logger.trace({ amount, lpmint: poolKeys.lpMint });
      const lamportAmount = amount.value.uiAmount
        ? amount.value.uiAmount * 10 ** amount.value.decimals
        : Number(amount.value.amount);
      // const burned = amount.value.uiAmount === 0 && this.oldAmount > BURN_AMOUNT;
      const burned = this.oldAmount - lamportAmount > BURN_AMOUNT * LAMPORTS_PER_SOL;
      logger.debug(
        `total: ${lamportAmount / LAMPORTS_PER_SOL}SOL, burned: ${(this.oldAmount - lamportAmount) / LAMPORTS_PER_SOL}SOL`,
      );
      this.oldAmount = lamportAmount;
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
