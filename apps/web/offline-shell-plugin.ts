import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

// MM-V2-C11 spike: after `vite build`, writes dist/sw.js = the shell build record (content hash
// and file list) + apps/web/sw/service-worker.js. Runs for builds only; `vite` dev has no worker.

/** Files the worker precaches: everything in dist except the worker and .woff fallbacks. */
export function shellFiles(outDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push('/' + relative(outDir, path).split(sep).join('/'));
    }
  };
  walk(outDir);
  // Every browser that can install a service worker reads .woff2, so the .woff copies only cost
  // phone storage.
  return files
    .filter((file) => file !== '/sw.js' && !file.endsWith('.woff') && !file.endsWith('.map'))
    .sort();
}

export function offlineShell(): Plugin {
  let outDir = 'dist';
  let workerSource = 'sw/service-worker.js';
  return {
    name: 'materialmule-offline-shell',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      workerSource = resolve(config.root, 'sw', 'service-worker.js');
    },
    closeBundle() {
      const files = shellFiles(outDir);
      const worker = readFileSync(workerSource, 'utf8');
      // MM_SHELL_BUILD_LABEL (build machine only, never in the bundle) forces a new shell version
      // from unchanged sources, for the spike's "app update" scenario.
      const label = process.env.MM_SHELL_BUILD_LABEL ?? '';
      const hash = createHash('sha256').update(label).update(worker);
      for (const file of files) {
        hash.update(file).update(readFileSync(join(outDir, file)));
      }
      const build = { version: hash.digest('hex').slice(0, 16), files };
      writeFileSync(
        join(outDir, 'sw.js'),
        `self.__MM_SHELL_BUILD__ = ${JSON.stringify(build)};\n${worker}`,
      );
    },
  };
}
