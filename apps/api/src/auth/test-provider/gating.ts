import type { AppConfig } from '../../config/env.js';

/** True when the fixture sign-in routes should exist (TRP-T33). */
export function testAuthEnabled(config: AppConfig): boolean {
  return config.ENABLE_TEST_AUTH && config.APP_ENV !== 'production';
}
