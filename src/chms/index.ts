// Data-source factory: the one place that picks the ChMS implementation from config.
import type { DataSource, HolyNudgeConfig } from '../core/types';
import type { Env } from '../env';
import { createFixtureSource } from './fixture';
import { ChmsNotConfiguredError, missingSettings } from './oauth';
import { createPushpayDataSource } from './pushpay';

export { ChmsNotConfiguredError };

export class DataSourceNotConnectedError extends Error {
  constructor(kind: string) {
    super(`Data source "${kind}" is not known. Use "fixture" or "pushpay" in config/holy-nudge.config.json.`);
    this.name = 'DataSourceNotConnectedError';
  }
}

export function createDataSource(config: HolyNudgeConfig, env: Env, now: Date): DataSource {
  switch (config.dataSource) {
    case 'fixture':
      return createFixtureSource(now, config.timeZone);
    case 'pushpay': {
      // A missing or malformed TOKEN_ENC_KEY is "not configured", exactly like missing credentials.
      const missing = missingSettings(env, ['CHMS_CLIENT_ID', 'CHMS_CLIENT_SECRET', 'TOKEN_ENC_KEY']);
      if (missing.length > 0 || !env.CHMS_CLIENT_ID || !env.CHMS_CLIENT_SECRET || !env.TOKEN_ENC_KEY) {
        throw new ChmsNotConfiguredError(missing);
      }
      return createPushpayDataSource({
        DB: env.DB,
        CHMS_CLIENT_ID: env.CHMS_CLIENT_ID,
        CHMS_CLIENT_SECRET: env.CHMS_CLIENT_SECRET,
        CHMS_API_HOST: env.CHMS_API_HOST,
        TOKEN_ENC_KEY: env.TOKEN_ENC_KEY,
      });
    }
    default: {
      const kind: never = config.dataSource;
      throw new DataSourceNotConnectedError(String(kind));
    }
  }
}
