// Material Mule app-shell service worker (MM-V2-C11 spike; not production-ready).
//
// The build (apps/web/offline-shell-plugin.ts) writes dist/sw.js as this file preceded by
// `self.__MM_SHELL_BUILD__ = { version, files }`: the build's content hash and every file of the
// app shell. Rules:
// - /api is never handled here: API calls, sign-in and sessions behave exactly as without a worker.
// - Navigations go to the network first, as today; only when the server can't be reached (or
//   doesn't answer within NAVIGATION_TIMEOUT_MS) does the cached index.html start the app.
// - Shell files (hashed /assets, manifest, icons) come from this build's cache, else the network.
// - A new build installs in the background and waits; it takes over when every tab/app window of
//   the old one is closed, or when a page posts {type: 'SKIP_WAITING'} (the spike page's button).
//   IndexedDB, localStorage and other storage are never touched by an update.

const SHELL = self.__MM_SHELL_BUILD__ ?? { version: 'unbuilt', files: [] };
const CACHE_PREFIX = 'mm-shell-';
const CACHE = CACHE_PREFIX + SHELL.version;
const NAVIGATION_TIMEOUT_MS = 4000;
const SHELL_PATHS = new Set(SHELL.files);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' skips the HTTP cache so a half-updated host can't mix builds.
      .then((cache) =>
        cache.addAll(SHELL.files.map((path) => new Request(path, { cache: 'reload' }))),
      ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    void self.skipWaiting();
  } else if (type === 'GET_VERSION' && event.ports[0]) {
    event.ports[0].postMessage({ version: SHELL.version, files: SHELL.files.length });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
  } else if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(fromShell(request, url.pathname));
  }
});

async function navigate(request) {
  try {
    return await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
  } catch {
    const cached = await caches.match('/index.html', { cacheName: CACHE });
    return cached ?? Response.error();
  }
}

async function fromShell(request, path) {
  const cached = await caches.match(path, { cacheName: CACHE });
  return cached ?? fetch(request);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
