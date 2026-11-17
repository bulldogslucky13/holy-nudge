// Data-source factory: the one place that picks the ChMS implementation from config.
import type { DataSource, HolyNudgeConfig } from '../core/types';
import type { Env } from '../env';
import { createFixtureSource } from './fixture';

export class DataSourceNotConnectedError extends Error {
  constructor(kind: string) {
    super(`Data source "${kind}" is not connected yet. Set "dataSource": "fixture" in config/holy-nudge.config.json until the live ChMS connection is built.`);
    this.name = 'DataSourceNotConnectedError';
  }
}

export function createDataSource(config: HolyNudgeConfig, _env: Env, now: Date): DataSource {
  switch (config.dataSource) {
    case 'fixture':
      return createFixtureSource(now, config.timeZone);
    case 'pushpay':
      throw new DataSourceNotConnectedError('pushpay');
    default: {
      const kind: never = config.dataSource;
      throw new DataSourceNotConnectedError(String(kind));
    }
  }
}
