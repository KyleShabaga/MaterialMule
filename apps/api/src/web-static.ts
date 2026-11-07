import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * App-shell service worker and web app manifest (MM-V2-C11 spike). Always revalidated, so a new
 * deploy reaches phones on their next online start; the manifest gets its registered media type.
 */
function shellHeaders(response: Response, path: string): void {
  const name = basename(path);
  if (name === 'sw.js' || name === 'manifest.webmanifest') {
    response.setHeader('Cache-Control', 'no-cache');
  }
  if (name === 'manifest.webmanifest') {
    response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  }
}

/**
 * Serves the built React app from the API's own origin (production layout, MM-T20; also used by
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
  server.use(express.static(root, { index: false, fallthrough: true, setHeaders: shellHeaders }));
  server.use((request: Request, response: Response, next: NextFunction) => {
    const isApi = request.path === '/api' || request.path.startsWith('/api/');
    // A build without a worker answers /sw.js with 404, never index.html as JavaScript.
    if (request.method !== 'GET' || isApi || request.path === '/sw.js') {
      next();
      return;
    }
    // Relative to root, so a dot folder above it (e.g. a .claude worktree) isn't treated as a
    // hidden file and refused.
    response.sendFile('index.html', { root });
  });
}
