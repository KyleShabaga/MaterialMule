import { readFileSync } from 'node:fs';

// src/ and dist/ both sit directly under apps/api, next to package.json.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const APP_VERSION = packageJson.version;
