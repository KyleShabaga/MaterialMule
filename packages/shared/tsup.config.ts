import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  // Not in watch mode: `npm run dev` builds dist first, then starts the API and web alongside the
  // watcher. Cleaning there deleted the declarations while they rebuilt, and the API's first
  // typecheck failed against the missing .d.ts files without ever retrying.
  clean: !options.watch,
  sourcemap: true,
}));
