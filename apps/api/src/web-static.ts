import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * Serves the built React app from the API's own origin (production layout, TRP-T20; also used by
 * E2E). Static files first; any other GET outside /api returns index.html so client-side routes
 * such as /sample-storage load. API routes are never shadowed.
 */
export function serveWebApp(app: INestApplication, directory: string): void {
  const root = resolve(directory);
  const indexHtml = join(root, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);
  }
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.use(express.static(root, { index: false, fallthrough: true }));
  server.use((request: Request, response: Response, next: NextFunction) => {
    const isApi = request.path === '/api' || request.path.startsWith('/api/');
    if (request.method !== 'GET' || isApi) {
      next();
      return;
    }
    // Relative to `root`, so a dot directory above it (e.g. a .claude/worktrees checkout) isn't
    // treated as a hidden file and refused with 404.
    response.sendFile('index.html', { root });
  });
}
