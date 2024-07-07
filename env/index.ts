import fs from 'fs';
import path from 'path';

export interface EnvConfig {
  FilterCheckDuration: number;
  BurnAmount: number;
  BuyRate: number;
  CustomFee: number;
  PercentsOfPrice: number[];
  SellAmounts: number[];
}

let env: EnvConfig = require('./env.json');

export class Env {
  private fileLocation = path.join(__dirname, './env.json');

  public saveEnv(key: keyof typeof env, val: any) {
    env[key] = val;
    fs.writeFileSync(this.fileLocation, JSON.stringify(env));
  }

  public getEnv(key: keyof typeof env): any {
    return env[key];
  }
}
