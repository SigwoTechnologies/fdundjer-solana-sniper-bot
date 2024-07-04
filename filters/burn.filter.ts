import { Filter, FilterResult } from './pool-filters';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger, BURN_AMOUNT, sleep } from '../helpers';
import BN from 'bn.js';
export class BurnFilter implements Filter {
  private cachedResult: FilterResult | undefined = undefined;

  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    try {
      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      let burned = false;
      let burnAmount = 0;
      if (amount.value.uiAmount === 0) {
        await sleep(1000);
        const transactionList = await this.connection.getConfirmedSignaturesForAddress2(poolKeys.lpMint, { limit: 1 });
        let signatureList = transactionList.map((transaction) => transaction.signature);
        let transactionDetails = await this.connection.getParsedTransactions(signatureList, {
          maxSupportedTransactionVersion: 0,
        });
        // console.log(transactionDetails[0]?.transaction.message.instructions);

        transactionDetails[0]?.transaction.message.instructions?.forEach((instruction: any) => {
          if (instruction.parsed) {
            // console.log('instruction', instruction.parsed);
            if (instruction.parsed.type === 'burn' || instruction.parsed.type === 'burnChecked') {
              burned = true;
              burnAmount = instruction.parsed.info.amount / (LAMPORTS_PER_SOL / 10 ** instruction.parsed.info.decimals);
            }
          }
        });
      }

      const result = {
        ok: burned,
        message: burned
          ? `Burned -> ${burnAmount} > ${BURN_AMOUNT} SOL, lpmint: ${poolKeys.lpMint}`
          : `Burned -> Creator didn't burn LP, lpmint: ${poolKeys.lpMint}`,
      };

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
