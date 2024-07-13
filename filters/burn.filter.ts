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
        // logger.trace('Burned -> The Token Supply is 0');
        // await sleep(300);
        const transactionList = await this.connection.getConfirmedSignaturesForAddress2(poolKeys.lpMint, { limit: 10 });
        // await sleep(300);
        // logger.trace('Burned -> Getting Transaction Details');
        let signatureList = transactionList.map((transaction) => transaction.signature);
        let transactionDetails = await this.connection.getParsedTransactions(signatureList, {
          maxSupportedTransactionVersion: 0,
        });
        // console.log(transactionDetails[1]?.transaction.message.instructions);

        transactionDetails.forEach((txDetail) =>
          txDetail?.transaction.message.instructions.forEach((instruction: any) => {
            if (instruction.parsed) {
              // console.log('instruction', instruction.parsed);
              if (instruction.parsed.type === 'createAccountWithSeed') {
                burnAmount += instruction.parsed.info.lamports / LAMPORTS_PER_SOL;
              }
            }
          }),
        );
        // console.log('mintAmount', burnAmount);
        burned = burnAmount > BURN_AMOUNT;
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
