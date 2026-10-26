import 'reflect-metadata';
import { loadConfigOrExit } from './config/env.js';
import { createApp } from './create-app.js';

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit();
  const app = await createApp(config);
  await app.listen(config.PORT, config.HOST);
}

void bootstrap();
