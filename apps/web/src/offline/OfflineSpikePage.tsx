import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import {
  SERVICE_WORKER_OPT_OUT_KEY,
  unregisterServiceWorkers,
  workerVersion,
} from './service-worker';
import {
  addCheck,
  checkDraft,
  clearFiller,
  createDevice,
  deleteAllSpikeData,
  describeError,
  fillStorage,
  incrementDeviceCounter,
  listChecks,
  randomBlob,
  readDevice,
  readDraft,
  saveDraft,
  type CheckEntry,
  type DeviceReadings,
  type DraftCheck,
  type FillResult,
  type PhotoFormat,
} from './spike-store';
import './offline-spike.css';

// MM-V2-C11 throwaway scenario checklist (not production UI). Opens without sign-in or server
// data so it can show whether the app shell starts offline. Every result here is what this
// browser reported; testers copy the results block into the evidence table on the card.

const MB = 1024 * 1024;
const SCENARIOS = [
  ['cold-start-offline', 'Cold start offline after reboot (no signal)'],
  ['force-close', 'After force-close'],
  ['reboot', 'After reboot'],
  ['app-update', 'After app update (new build deployed, update applied)'],
  ['unused-8-days', 'After 8 days unused'],
  ['clear-site-data', 'After clearing site data'],
  ['low-storage', 'Low storage'],
  ['other', 'Other (describe in the evidence table)'],
] as const;

interface Environment {
  userAgent: string;
  installed: boolean;
  launchedFromHomeScreen: boolean;
  secureContext: boolean;
  online: boolean;
  workerSupported: boolean;
  controlled: boolean;
  shellVersion: string | null;
  shellFiles: number | null;
  waitingUpdate: boolean;
  persisted: boolean | 'unsupported';
  usageMb: number | null;
  quotaMb: number | null;
}

function isInstalled(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

async function readEnvironment(): Promise<Environment> {
  const workerSupported = 'serviceWorker' in navigator;
  const registration = workerSupported
    ? await navigator.serviceWorker.getRegistration().catch(() => undefined)
    : undefined;
  const version = await workerVersion();
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  const persisted =
    typeof navigator.storage?.persisted === 'function'
      ? await navigator.storage.persisted().catch(() => false)
      : 'unsupported';
  return {
    userAgent: navigator.userAgent,
    installed: isInstalled(),
    launchedFromHomeScreen: new URLSearchParams(location.search).get('launch') === 'home-screen',
    secureContext: window.isSecureContext,
    online: navigator.onLine,
    workerSupported,
    controlled: Boolean(navigator.serviceWorker?.controller),
    shellVersion: version?.version ?? null,
    shellFiles: version?.files ?? null,
    waitingUpdate: Boolean(registration?.waiting),
    persisted,
    usageMb: estimate?.usage != null ? estimate.usage / MB : null,
    quotaMb: estimate?.quota != null ? estimate.quota / MB : null,
  };
}

const mb = (value: number | null | undefined) =>
  value == null ? 'unknown' : `${value.toFixed(1)} MB`;
const yesNo = (value: boolean) => (value ? 'yes' : 'no');

function draftSummary(check: DraftCheck): { result: CheckEntry['result']; detail: string } {
  if (check.error) return { result: 'fail', detail: `Read failed: ${check.error}` };
  if (!check.found) return { result: 'fail', detail: 'No saved draft on this device' };
  const ok = check.sizeMatches && check.hashMatches;
  return {
    result: ok ? 'pass' : 'fail',
    detail:
      `Draft saved ${check.savedAt} (${check.ageDays?.toFixed(2)} days ago), ` +
      `photo ${check.photoName} ${mb((check.photoSize ?? 0) / MB)} as ${check.photoFormat}, ` +
      `size ${check.sizeMatches ? 'matches' : 'DIFFERS'}, SHA-256 ${check.hashMatches ? 'matches' : 'DIFFERS'}, ` +
      `saved with shell ${check.savedWithShell ?? 'none'}`,
  };
}

function deviceSummary(readings: DeviceReadings): string {
  return Object.entries(readings)
    .map(([store, reading]) =>
      reading.ok
        ? `${store}: ${reading.value ? `${reading.value.code} #${reading.value.counter}` : 'missing'}`
        : `${store}: error ${reading.error}`,
    )
    .join('; ');
}

export function OfflineSpikePage() {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [persistResult, setPersistResult] = useState<string | null>(null);
  const [reachability, setReachability] = useState<string | null>(null);
  const [note, setNote] = useState('Spike draft: slump 90 mm, air 5.5 %, DEMO-2601 TH26-01');
  const [photoFormat, setPhotoFormat] = useState<PhotoFormat>('blob');
  const [photo, setPhoto] = useState<{ blob: Blob; name: string } | null>(null);
  const [saveState, setSaveState] = useState<
    { kind: 'saved'; at: string } | { kind: 'failed'; error: string } | { kind: 'saving' } | null
  >(null);
  const [scenario, setScenario] = useState<string>(SCENARIOS[0][0]);
  const [draftCheck, setDraftCheck] = useState<DraftCheck | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceReadings | null>(null);
  const [deviceWrite, setDeviceWrite] = useState<string | null>(null);
  const [fill, setFill] = useState<{ running: boolean; writtenMb: number; result?: FillResult }>({
    running: false,
    writtenMb: 0,
  });
  const [fillLimitMb, setFillLimitMb] = useState(2048);
  const [checks, setChecks] = useState<CheckEntry[]>([]);
  const fillAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setEnvironment(await readEnvironment());
    setDevice(await readDevice());
    setChecks(await listChecks().catch(() => []));
  }, []);

  useEffect(() => {
    // Read the probes after mount; every setState happens once they answer.
    void Promise.resolve().then(refresh);
    const onChange = () => void refresh();
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    navigator.serviceWorker?.addEventListener('controllerchange', onChange);
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
      navigator.serviceWorker?.removeEventListener('controllerchange', onChange);
    };
  }, [refresh]);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const log = async (entry: Omit<CheckEntry, 'at'>) => {
    try {
      await addCheck({ ...entry, at: new Date().toISOString() });
    } catch (error) {
      setNotice(`Couldn't record the check: ${describeError(error)}`);
    }
    setChecks(await listChecks().catch(() => []));
  };

  const requestPersist = async () => {
    if (typeof navigator.storage?.persist !== 'function') {
      setPersistResult('navigator.storage.persist() is not supported here');
      return;
    }
    const granted = await navigator.storage.persist();
    setPersistResult(`persist() returned ${granted}`);
    await log({ scenario: 'persist', result: 'info', detail: `persist() returned ${granted}` });
    await refresh();
  };

  const checkServer = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const started = performance.now();
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
      setReachability(`HTTP ${response.status} in ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      setReachability(`Not reachable: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setPhoto({ blob: file, name: file.name || 'camera-photo' });
  };

  const save = async () => {
    const blob = photo?.blob ?? randomBlob(3 * MB);
    const name = photo?.name ?? 'generated-3mb.bin';
    setSaveState({ kind: 'saving' });
    try {
      const record = await saveDraft({
        note,
        photo: blob,
        photoName: name,
        photoFormat,
        shellVersion: environment?.shellVersion ?? null,
      });
      setSaveState({ kind: 'saved', at: record.savedAt });
      await log({
        scenario: 'save',
        result: 'info',
        detail: `Saved draft with ${name} ${mb(blob.size / MB)} as ${photoFormat}`,
      });
    } catch (error) {
      const message = describeError(error);
      setSaveState({ kind: 'failed', error: message });
      await log({ scenario: 'save', result: 'fail', detail: `Save failed: ${message}` });
    }
    await refresh();
  };

  const verify = async () => {
    const check = await checkDraft();
    setDraftCheck(check);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (check.found) {
      const record = await readDraft().catch(() => null);
      if (record && record.photoType.startsWith('image/')) {
        const bytes = record.photo;
        const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: record.photoType });
        setPreview(URL.createObjectURL(blob));
      }
    }
    const env = await readEnvironment();
    setEnvironment(env);
    const summary = draftSummary(check);
    await log({
      scenario,
      result: summary.result,
      detail:
        `${summary.detail}; installed ${yesNo(env.installed)}, online ${yesNo(env.online)}, ` +
        `shell ${env.shellVersion ?? 'none'}, persisted ${env.persisted}`,
    });
  };

  const deviceAction = async (action: 'create' | 'increment' | 'check') => {
    try {
      if (action === 'create') setDeviceWrite(JSON.stringify(await createDevice()));
      if (action === 'increment') setDeviceWrite(JSON.stringify(await incrementDeviceCounter()));
      const readings = await readDevice();
      setDevice(readings);
      if (action === 'check') {
        await log({
          scenario: `device:${scenario}`,
          result: 'info',
          detail: deviceSummary(readings),
        });
      }
    } catch (error) {
      setDeviceWrite(describeError(error));
    }
  };

  const startFill = async () => {
    const controller = new AbortController();
    fillAbort.current = controller;
    setFill({ running: true, writtenMb: 0 });
    const result = await fillStorage({
      chunkMb: 25,
      limitMb: fillLimitMb,
      signal: controller.signal,
      onProgress: (writtenMb) => setFill({ running: true, writtenMb }),
    });
    setFill({ running: false, writtenMb: result.writtenMb, result });
    await log({
      scenario: 'low-storage',
      result: 'info',
      detail: `Filled ${result.writtenMb} MB, stopped by ${result.stoppedBy}${result.error ? `: ${result.error}` : ''}`,
    });
    await refresh();
  };

  const applyUpdate = async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.waiting) {
      await registration?.update().catch(() => undefined);
      setNotice(
        registration?.installing || registration?.waiting
          ? 'An update is installing; tap Apply update again in a moment.'
          : 'No update waiting.',
      );
      await refresh();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
      once: true,
    });
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  const setWorker = async (on: boolean) => {
    try {
      if (on) localStorage.removeItem(SERVICE_WORKER_OPT_OUT_KEY);
      else localStorage.setItem(SERVICE_WORKER_OPT_OUT_KEY, 'off');
    } catch (error) {
      setNotice(describeError(error));
    }
    if (!on)
      setNotice(
        `Unregistered ${await unregisterServiceWorkers()} worker(s). Reload to run without one.`,
      );
    else setNotice('Worker allowed again. Reload to register it.');
  };

  const removeAll = async () => {
    if (!window.confirm('Delete the spike draft, photo, device code, check log and filler data?')) {
      return;
    }
    try {
      await deleteAllSpikeData();
      setNotice('Spike data deleted.');
      setSaveState(null);
      setDraftCheck(null);
    } catch (error) {
      setNotice(describeError(error));
    }
    await refresh();
  };

  const resultsText = [
    `MM-V2-C11 results ${new Date().toISOString()}`,
    environment &&
      [
        `User agent: ${environment.userAgent}`,
        `Installed (standalone): ${yesNo(environment.installed)}; launched from Home Screen: ${yesNo(environment.launchedFromHomeScreen)}`,
        `Secure context: ${yesNo(environment.secureContext)}; online: ${yesNo(environment.online)}`,
        `Service worker: supported ${yesNo(environment.workerSupported)}, controlling ${yesNo(environment.controlled)}, shell ${environment.shellVersion ?? 'none'} (${environment.shellFiles ?? 0} files), update waiting ${yesNo(environment.waitingUpdate)}`,
        `Storage: persisted ${environment.persisted}; usage ${mb(environment.usageMb)} of quota ${mb(environment.quotaMb)}`,
      ].join('\n'),
    device && `Device code: ${deviceSummary(device)}`,
    'Checks:',
    ...checks.map(
      (entry) => `${entry.at} [${entry.scenario}] ${entry.result.toUpperCase()} ${entry.detail}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const copyResults = async () => {
    try {
      await navigator.clipboard.writeText(resultsText);
      setNotice('Results copied.');
    } catch {
      setNotice('Copy failed; select the text in the results box and copy it by hand.');
    }
  };

  return (
    <main className="spike">
      <header className="spike-head">
        <h1>Offline spike (MM-V2-C11)</h1>
        <p>
          Throwaway test page. Results are what this browser reports; copy them into the evidence
          table. <Link to="/">Open the main app</Link>
        </p>
      </header>

      {notice && (
        <p className="spike-notice" role="status">
          {notice}
        </p>
      )}

      <section className="spike-card" aria-labelledby="spike-env">
        <h2 id="spike-env">1. This device</h2>
        {environment ? (
          <dl className="spike-facts">
            <dt>Installed app</dt>
            <dd>
              {environment.installed ? 'Yes (standalone window)' : 'No (browser tab)'}
              {environment.launchedFromHomeScreen ? ', opened from Home Screen icon' : ''}
            </dd>
            <dt>Connection</dt>
            <dd>{environment.online ? 'Browser says online' : 'Browser says offline'}</dd>
            <dt>Secure context</dt>
            <dd>{yesNo(environment.secureContext)}</dd>
            <dt>Service worker</dt>
            <dd>
              {!environment.workerSupported
                ? 'Not supported'
                : environment.controlled
                  ? `Controlling this page, shell ${environment.shellVersion ?? 'unknown'} (${environment.shellFiles ?? '?'} files)`
                  : 'Not controlling this page (first visit, opted out, or failed to register)'}
              {environment.waitingUpdate ? '; an update is waiting' : ''}
            </dd>
            <dt>Persistent storage</dt>
            <dd>{String(environment.persisted)}</dd>
            <dt>Storage estimate</dt>
            <dd>
              {mb(environment.usageMb)} used of {mb(environment.quotaMb)}
            </dd>
          </dl>
        ) : (
          <p>Reading…</p>
        )}
        <div className="spike-actions">
          <button type="button" onClick={() => void requestPersist()}>
            Request persistent storage
          </button>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" onClick={() => void checkServer()}>
            Check server reachable
          </button>
          <button type="button" onClick={() => void applyUpdate()}>
            Apply update
          </button>
        </div>
        {persistResult && <p className="spike-result">{persistResult}</p>}
        {reachability && <p className="spike-result">Server: {reachability}</p>}
      </section>

      <section className="spike-card" aria-labelledby="spike-draft">
        <h2 id="spike-draft">2. Draft and photo</h2>
        <label className="spike-field">
          Draft note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
        </label>
        <label className="spike-field">
          Photo (take one of about 3 MB; leave empty to use a generated 3 MB file)
          <input type="file" accept="image/*" onChange={choosePhoto} />
        </label>
        <label className="spike-field">
          Store the photo as
          <select
            value={photoFormat}
            onChange={(event) => setPhotoFormat(event.target.value as PhotoFormat)}
          >
            <option value="blob">Blob (default)</option>
            <option value="arraybuffer">ArrayBuffer (raw bytes)</option>
          </select>
        </label>
        {photo && (
          <p className="spike-result">
            Selected {photo.name}, {mb(photo.blob.size / MB)}
          </p>
        )}
        <div className="spike-actions">
          <button type="button" className="spike-primary" onClick={() => void save()}>
            Save draft on device
          </button>
        </div>
        {saveState?.kind === 'saving' && <p className="spike-result">Saving…</p>}
        {saveState?.kind === 'saved' && (
          <p className="spike-ok" role="status">
            Saved on device at {saveState.at}
          </p>
        )}
        {saveState?.kind === 'failed' && (
          <p className="spike-error" role="alert">
            Save failed: not saved on device. {saveState.error}
          </p>
        )}

        <label className="spike-field">
          Scenario being checked
          <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
            {SCENARIOS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="spike-actions">
          <button type="button" onClick={() => void verify()}>
            Check saved draft
          </button>
        </div>
        {draftCheck && (
          <p className={draftSummary(draftCheck).result === 'pass' ? 'spike-ok' : 'spike-error'}>
            {draftSummary(draftCheck).result.toUpperCase()}: {draftSummary(draftCheck).detail}
          </p>
        )}
        {preview && <img className="spike-preview" src={preview} alt="Saved draft photo" />}
      </section>

      <section className="spike-card" aria-labelledby="spike-device">
        <h2 id="spike-device">3. Device code and counter</h2>
        <p>The same value is written to each store; check which survive each scenario.</p>
        <div className="spike-actions">
          <button type="button" onClick={() => void deviceAction('create')}>
            Create device code
          </button>
          <button type="button" onClick={() => void deviceAction('increment')}>
            Add 1 to counter
          </button>
          <button type="button" onClick={() => void deviceAction('check')}>
            Check and record
          </button>
        </div>
        {device && (
          <dl className="spike-facts">
            {Object.entries(device).map(([store, reading]) => (
              <div key={store} className="spike-fact-row">
                <dt>{store}</dt>
                <dd>
                  {reading.ok
                    ? reading.value
                      ? `${reading.value.code}, counter ${reading.value.counter} (${reading.value.updatedAt})`
                      : 'missing'
                    : `error: ${reading.error}`}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {deviceWrite && <p className="spike-result">Last write: {deviceWrite}</p>}
      </section>

      <section className="spike-card" aria-labelledby="spike-low">
        <h2 id="spike-low">4. Low storage</h2>
        <p>
          Writes 25 MB blocks until a write fails or the limit is reached, then try{' '}
          <strong>Save draft on device</strong>: it must show “Save failed”. Delete the filler
          afterwards.
        </p>
        <label className="spike-field spike-inline">
          Limit (MB)
          <input
            type="number"
            min={25}
            step={25}
            value={fillLimitMb}
            onChange={(event) => setFillLimitMb(Math.max(25, Number(event.target.value) || 25))}
          />
        </label>
        <div className="spike-actions">
          <button type="button" disabled={fill.running} onClick={() => void startFill()}>
            Fill storage
          </button>
          <button type="button" disabled={!fill.running} onClick={() => fillAbort.current?.abort()}>
            Stop
          </button>
          <button
            type="button"
            disabled={fill.running}
            onClick={() =>
              void clearFiller()
                .then(() => setNotice('Filler deleted.'))
                .catch((error: unknown) => setNotice(describeError(error)))
                .then(refresh)
            }
          >
            Delete filler
          </button>
        </div>
        {(fill.running || fill.result) && (
          <p className={fill.result?.error ? 'spike-error' : 'spike-result'}>
            {fill.running ? 'Writing… ' : ''}
            {fill.writtenMb} MB written
            {fill.result ? `, stopped by ${fill.result.stoppedBy}` : ''}
            {fill.result?.error ? `: ${fill.result.error}` : ''}
          </p>
        )}
      </section>

      <section className="spike-card" aria-labelledby="spike-results">
        <h2 id="spike-results">5. Results</h2>
        <textarea className="spike-results" readOnly value={resultsText} rows={10} />
        <div className="spike-actions">
          <button type="button" className="spike-primary" onClick={() => void copyResults()}>
            Copy results
          </button>
          <button type="button" onClick={() => void setWorker(false)}>
            Turn worker off here
          </button>
          <button type="button" onClick={() => void setWorker(true)}>
            Turn worker on here
          </button>
          <button type="button" className="spike-danger" onClick={() => void removeAll()}>
            Delete all spike data
          </button>
        </div>
      </section>
    </main>
  );
}
