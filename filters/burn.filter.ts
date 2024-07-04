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
      let burned = false;
      let burnAmount = new BN(0);
      if (amount.value.uiAmount === 0) {
        const transactionList = await this.connection.getConfirmedSignaturesForAddress2(poolKeys.lpMint, { limit: 1 });
        logger.info(`transactionList: ${transactionList}`);

        let signatureList = transactionList.map((transaction) => transaction.signature);
        let transactionDetails = await this.connection.getParsedTransactions(signatureList, {
          maxSupportedTransactionVersion: 0,
        });

        transactionDetails.forEach((transaction: any, i) => {
          const transactionInstructions = transaction.message.instructions;
          transactionInstructions.forEach((instruction: any) => {
            if (instruction.parsed) {
              console.log('instruction', instruction.parsed);
              if (instruction.parsed.type === 'burn' || instruction.parsed.type === 'burnChecked') {
                burned = true;
                burnAmount = burnAmount.addn(instruction.parsed.info.amount).divn(LAMPORTS_PER_SOL);
              }
            }
          });
        });
      }

      logger.debug(`burned: ${burned}, ${burnAmount} > ${BURN_AMOUNT}SOL, lpmint: ${poolKeys.lpMint}`);
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
