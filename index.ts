import { MarketCache, PoolCache } from './cache';
import { Listeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Context, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { Keyboard } from 'telegram-keyboard';
import { Bot, BotConfig } from './bot';
import { Env, EnvConfig } from './env';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  PRE_LOAD_EXISTING_MARKETS,
  LOG_LEVEL,
  QUOTE_MINT,
  MAX_POOL_SIZE,
  MIN_POOL_SIZE,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  USE_SNIPE_LIST,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  CACHE_NEW_MARKETS,
  TAKE_PROFIT,
  STOP_LOSS,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  SNIPE_LIST_REFRESH_INTERVAL,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  FILTER_CHECK_INTERVAL,
  FILTER_CHECK_DURATION,
  CONSECUTIVE_FILTER_MATCHES,
  MAX_TOKENS_AT_THE_TIME,
  CHECK_IF_MINT_IS_RENOUNCED,
  CHECK_IF_FREEZABLE,
  CHECK_IF_BURNED,
  CHECK_IF_MUTABLE,
  CHECK_IF_SOCIALS,
  TRAILING_STOP_LOSS,
  SKIP_SELLING_IF_LOST_MORE_THAN,
  TELEGRAM_TOKEN,
  BURN_AMOUNT,
  BUY_RATE,
} from './helpers';
import { version } from './package.json';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

function printDetails(wallet: Keypair, quoteToken: Token, bot: Bot) {
  logger.info(`  
                                        ..   :-===++++-     
                                .-==+++++++- =+++++++++-    
            ..:::--===+=.=:     .+++++++++++:=+++++++++:    
    .==+++++++++++++++=:+++:    .+++++++++++.=++++++++-.    
    .-+++++++++++++++=:=++++-   .+++++++++=:.=+++++-::-.    
     -:+++++++++++++=:+++++++-  .++++++++-:- =+++++=-:      
      -:++++++=++++=:++++=++++= .++++++++++- =+++++:        
       -:++++-:=++=:++++=:-+++++:+++++====--:::::::.        
        ::=+-:::==:=+++=::-:--::::::::::---------::.        
         ::-:  .::::::::.  --------:::..                    
          :-    .:.-:::.                                    

          WARP DRIVE ACTIVATED 🚀🐟
          Made with ❤️ by humans.
          Version: ${version}                                          
  `);

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);

  logger.info('- Bot -');
  logger.info(`Using transaction executor: ${TRANSACTION_EXECUTOR}`);

  if (bot.isWarp || bot.isJito) {
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
  }

  logger.info(`Max tokens at the time: ${botConfig.maxTokensAtTheTime}`);
  logger.info(`Pre load existing markets: ${PRE_LOAD_EXISTING_MARKETS}`);
  logger.info(`Cache new markets: ${CACHE_NEW_MARKETS}`);
  logger.info(`Log level: ${LOG_LEVEL}`);

  logger.info('- Buy -');
  logger.info(`Buy amount: ${botConfig.quoteAmount.toFixed()} ${botConfig.quoteToken.name}`);
  logger.info(`Auto buy delay: ${botConfig.autoBuyDelay} ms`);
  logger.info(`Max buy retries: ${botConfig.maxBuyRetries}`);
  logger.info(`Buy amount (${quoteToken.symbol}): ${botConfig.quoteAmount.toFixed()}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);

  logger.info('- Sell -');
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Auto sell delay: ${botConfig.autoSellDelay} ms`);
  logger.info(`Max sell retries: ${botConfig.maxSellRetries}`);
  logger.info(`Sell slippage: ${botConfig.sellSlippage}%`);
  logger.info(`Price check interval: ${botConfig.priceCheckInterval} ms`);
  logger.info(`Price check duration: ${botConfig.priceCheckDuration} ms`);
  logger.info(`Take profit: ${botConfig.takeProfit}%`);
  logger.info(`Stop loss: ${botConfig.stopLoss}%`);
  logger.info(`Trailing stop loss: ${botConfig.trailingStopLoss}`);
  logger.info(`Skip selling if lost more than: ${botConfig.skipSellingIfLostMoreThan}%`);

  logger.info('- Snipe list -');
  logger.info(`Snipe list: ${botConfig.useSnipeList}`);
  logger.info(`Snipe list refresh interval: ${SNIPE_LIST_REFRESH_INTERVAL} ms`);

  if (botConfig.useSnipeList) {
    logger.info('- Filters -');
    logger.info(`Filters are disabled when snipe list is on`);
  } else {
    logger.info('- Filters -');
    logger.info(`Filter check interval: ${botConfig.filterCheckInterval} ms`);
    logger.info(`Filter check duration: ${botConfig.filterCheckDuration} ms`);
    logger.info(`Consecutive filter matches: ${botConfig.consecutiveMatchCount}`);
    logger.info(`Check renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
    logger.info(`Check freezable: ${CHECK_IF_FREEZABLE}`);
    logger.info(`Check burned: ${CHECK_IF_BURNED}`);
    logger.info(`Check mutable: ${CHECK_IF_MUTABLE}`);
    logger.info(`Check socials: ${CHECK_IF_SOCIALS}`);
    logger.info(`Min pool size: ${botConfig.minPoolSize.toFixed()}`);
    logger.info(`Max pool size: ${botConfig.maxPoolSize.toFixed()}`);
  }

  logger.info('------- CONFIGURATION END -------');

  logger.info('Bot is running! Press CTRL + C to stop it.');
}

let context: Context;
let running = true;

const runListener = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Bot is starting...');

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE);
      break;
    }
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    minPoolSize: new TokenAmount(quoteToken, MIN_POOL_SIZE, false),
    maxPoolSize: new TokenAmount(quoteToken, MAX_POOL_SIZE, false),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    maxTokensAtTheTime: MAX_TOKENS_AT_THE_TIME,
    useSnipeList: USE_SNIPE_LIST,
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    takeProfit: TAKE_PROFIT,
    stopLoss: STOP_LOSS,
    trailingStopLoss: TRAILING_STOP_LOSS,
    skipSellingIfLostMoreThan: SKIP_SELLING_IF_LOST_MORE_THAN,
    buySlippage: BUY_SLIPPAGE,
    sellSlippage: SELL_SLIPPAGE,
    priceCheckInterval: PRICE_CHECK_INTERVAL,
    priceCheckDuration: PRICE_CHECK_DURATION,
    filterCheckInterval: FILTER_CHECK_INTERVAL,
    filterCheckDuration: FILTER_CHECK_DURATION,
    consecutiveMatchCount: CONSECUTIVE_FILTER_MATCHES,
  };

  const bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig, context);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const listeners = new Listeners(connection);
  await listeners.start({
    walletPublicKey: wallet.publicKey,
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS,
  });

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
    const exists = await poolCache.get(poolState.baseMint.toString());

    if (!exists && poolOpenTime > runTimestamp) {
      poolCache.save(updatedAccountInfo.accountId.toString(), poolState);
      if (running) {
        await bot.buy(updatedAccountInfo.accountId, poolState);
      }
    }
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    await bot.sell(updatedAccountInfo.accountId, accountData);
  });

  printDetails(wallet, quoteToken, bot);
};

let onSetting = '';

export const FilterCheckDuration = 'FilterCheckDuration';
export const BurnAmount = 'BurnAmount';
export const BuyRate = 'BuyRate';
export const CustomFee = 'CustomFee';

export const START = 'Start';
export const STOP = 'Stop';
export const SETTING = 'Setting';
export const ALL_SETTINGS = 'All Settings';
export const CHECK_DURATION = 'Check Duration';
export const BURNAMOUNT = 'Burn Amount';
export const BUY_AMOUNT_RATE = 'Buy Rate';
export const GAS_FEE = 'Gas Fee';
export const HOME = 'Home';
export const SETTINGS = {
  [CHECK_DURATION]: {
    desc: '🖋️ Input the Check Duration for Sniper/second.',
    warn: '🚩 The Value is not valid.\n    Please Input  again.',
    ok: '✔️ This value is saved.',
  },
  [BURNAMOUNT]: {
    desc: '🖋️ Input the Burn Amount for Sniper/second.',
    warn: '🚩 The Value is not valid.\n    Please Input again.',
    ok: '✔️ This value is saved.',
  },
  [BUY_AMOUNT_RATE]: {
    desc: '🖋️ Input Percentage of Buying.',
    warn: '🚩 The Value is not valid.\n    Please Input again.',
    ok: '✔️ This value is saved.',
  },
  [GAS_FEE]: {
    desc: '🖋️ Input The Gas_FEE Fee.',
    warn: '🚩 The Value is not valid.\n    Please Input again.',
    ok: '✔️ This value is saved.',
  },
};

const myEnv = new Env();

const sendHome = async (ctx: Context) => {
  await ctx.reply(
    '✋ Welcome! I am always ready for you.',
    Keyboard.make([[running ? STOP : START, SETTING]])
      .oneTime(false)
      .resize()
      .inline(),
  );
};

const sendSetting = async (ctx: Context) => {
  await ctx.reply(
    '🛠️ Please Set the Environment.',
    Keyboard.make([
      [CHECK_DURATION, BURNAMOUNT],
      [BUY_AMOUNT_RATE, GAS_FEE],
      [HOME, ALL_SETTINGS],
    ])
      .oneTime(false)
      .resize()
      .inline(),
  );
};
const tBot = new Telegraf(TELEGRAM_TOKEN);

tBot.start(async (ctx) => {
  context = ctx;
  await sendHome(ctx);
});

tBot.on(message('text'), async (ctx) => {
  context = ctx;
  if (onSetting == '') {
    await sendHome(ctx);
    return;
  }
  const val = Number.parseFloat(ctx.update.message.text);
  if (val) {
    await ctx.reply('✔️ This value is saved.');
    await sendSetting(ctx);
    myEnv.saveEnv(onSetting as keyof EnvConfig, val);
    onSetting = '';
  } else {
    ctx.reply('🚩 The Value is not valid.\n    Please Input  again.');
  }
});

tBot.on('callback_query', async (ctx: any) => {
  context = ctx;
  let button: any = (ctx.update.callback_query as any).data;

  if (button) {
    switch (button) {
      case START:
        if (running) return;
        running = true;
        await ctx.reply('Sinper is running!');
        logger.info('Sinper is running!');
        await sendHome(ctx);
        break;
      case STOP:
        running = false;
        await ctx.reply('Sinper is Stopped!');
        logger.info('Sinper is Stopped!');
        await sendHome(ctx);
        break;
      case SETTING:
        sendSetting(ctx);
        break;
      case ALL_SETTINGS:
        ctx.reply(
          `📌\n 1. Check Duration:\t\t ${myEnv.getEnv(FilterCheckDuration) || FILTER_CHECK_DURATION}s\n 2. Burnt Amount:\t\t ${myEnv.getEnv(BurnAmount) || BURN_AMOUNT}\n 3. Buy Rate:\t\t ${myEnv.getEnv(BuyRate) || BUY_RATE}%\n 4. Gas_FEE:\t\t ${myEnv.getEnv(CustomFee) || CUSTOM_FEE}\n`,
        );
        break;
      case CHECK_DURATION:
        ctx.reply(
          `📌 \n 1. Default: ${FILTER_CHECK_DURATION}s\n 2. Current: ${myEnv.getEnv(FilterCheckDuration) || FILTER_CHECK_DURATION}s`,
        );
        onSetting = CHECK_DURATION;
        break;
      case BURNAMOUNT:
        ctx.reply(`📌 \n 1. Default: ${BURN_AMOUNT}\n 2. Current: ${myEnv.getEnv(BurnAmount) || BURN_AMOUNT}`);
        onSetting = BURNAMOUNT;
        break;
      case BUY_AMOUNT_RATE:
        ctx.reply(`📌 \n 1. Default: ${BUY_RATE}%\n 2. Current: ${myEnv.getEnv(BuyRate) || BUY_RATE}%`);
        onSetting = BUY_AMOUNT_RATE;
        break;
      case GAS_FEE:
        ctx.reply(`📌 \n 1. Default: ${CUSTOM_FEE}\n 2. Current: ${myEnv.getEnv(CustomFee) || CUSTOM_FEE}`);
        onSetting = GAS_FEE;
        break;
      case HOME:
        await sendHome(ctx);
        break;
    }
  }
});

tBot.launch();
runListener();
