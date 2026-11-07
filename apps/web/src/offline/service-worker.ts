// App-shell service worker registration (MM-V2-C11 spike). Production builds only: `vite` dev
// has no dist/sw.js and HMR doesn't mix with a caching worker.

/** Set to "off" (e.g. from the spike page) to unregister the worker and keep it off here. */
export const SERVICE_WORKER_OPT_OUT_KEY = 'materialmule:service-worker';

function optedOut(): boolean {
  try {
    return localStorage.getItem(SERVICE_WORKER_OPT_OUT_KEY) === 'off';
  } catch {
    return false;
  }
}

export async function unregisterServiceWorkers(): Promise<number> {
  if (!('serviceWorker' in navigator)) return 0;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  return registrations.length;
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  if (optedOut()) {
    void unregisterServiceWorkers().catch(() => undefined);
    return;
  }
  // After load, so installing the shell cache never competes with the first page load.
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** Asks the controlling (or given) worker for its build version; null without a worker. */
export function workerVersion(
  worker: ServiceWorker | null | undefined = navigator.serviceWorker?.controller,
): Promise<{ version: string; files: number } | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    channel.port1.onmessage = (event: MessageEvent<{ version: string; files: number }>) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
  });
}
