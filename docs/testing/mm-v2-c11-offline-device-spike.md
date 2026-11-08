# MM-V2-C11 — Offline real-device spike: test kit and evidence template

Spike branch only. This file is the evidence template and the draft device-setup steps for the
runbook. **No device results are recorded here yet.** Every pass/fail cell stays blank until
someone runs that scenario on that phone. The desktop checks in [Local results](#local-results)
are not phone evidence.

## What the spike build contains

| Piece              | Where                                                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker     | `apps/web/sw/service-worker.js` → `dist/sw.js` (scope `/`) | Precaches the app shell (index.html, JS, CSS, `.woff2` fonts, scanner wasm, manifest, icons; about 2.3 MB). Page loads try the network first, as today, and fall back to the cached shell if the server can't be reached or takes longer than 4 s. `/api` is never handled or cached. A new build installs quietly and takes over once every window of the old one is closed (or **Apply update** on the spike page).                                                        |
| Build step         | `apps/web/offline-shell-plugin.ts`                         | After `vite build`, writes `dist/sw.js` with the build's content hash (the "shell version") and file list. `MM_SHELL_BUILD_LABEL=<anything>` forces a new version from unchanged sources (for the update scenario).                                                                                                                                                                                                                                                          |
| Manifest           | `apps/web/public/manifest.webmanifest`, `public/icons/`    | `display: standalone`. For this spike `start_url` is `/offline-spike?launch=home-screen`, so the Home Screen icon opens the checklist. Apple tags in `index.html` set the iOS icon and title.                                                                                                                                                                                                                                                                                |
| Registration       | `apps/web/src/offline/service-worker.ts`                   | Production builds only (not `npm run dev`). Turn it off per browser with **Turn worker off here** (sets `localStorage['materialmule:service-worker'] = 'off'` and unregisters).                                                                                                                                                                                                                                                                                              |
| Server             | `apps/api/src/web-static.ts`                               | `sw.js` and `manifest.webmanifest` are sent with `Cache-Control: no-cache`, and the manifest as `application/manifest+json`. `/sw.js` returns 404, never index.html, when a build has no worker.                                                                                                                                                                                                                                                                             |
| Scenario checklist | `/offline-spike` (`apps/web/src/offline/`)                 | Needs no sign-in or server data. Shows installed or tab, worker state and shell version, `persisted()`, `estimate()` and server reachability. Saves a draft plus a photo (~3 MB camera photo, or a generated 3 MB file) to IndexedDB as a Blob or ArrayBuffer and re-hashes it on **Check saved draft**. Also writes a device code and counter to IndexedDB, localStorage, Cache Storage and OPFS, has a low-storage fill test, and keeps a check log with **Copy results**. |

Nothing here is production UI. The checklist uses its own IndexedDB database
(`materialmule-offline-spike`) and never touches receiving drafts.

## Before the device runs (Kyle)

1. **Test host.** Deploy this branch to a host reachable over HTTPS with the internal-CA
   certificate (gate in card section 5). Use the [runbook](../operations/runbook.md#build-a-release)
   steps from this branch's checkout:
   `npm ci`, `npm run verify`, `npm run release:pack`, then `Deploy-MaterialMule.ps1`. That is
   **build A**. Move or rename its `release\materialmule-<version>-<commit>` folder before step 2,
   because build B packs to the same folder name.
2. **Build B for the update scenario.** From the same checkout, run
   `$env:MM_SHELL_BUILD_LABEL = 'c11-update-b'; npm run build; npm run release:pack`, then
   `Remove-Item Env:MM_SHELL_BUILD_LABEL`. Keep that folder for S8. It differs from build A only
   in its shell version (`release.json` has the same version, so deploy it as an upgrade of the
   same version or bump it by hand).
3. **Phones.** At least one current iPhone and one Android phone of the kind field staff use, in
   both setups (decided 2026-10-30): one company-managed (MDM) phone and one personal phone.
4. **Reaching the host from a phone.** There is no off-site access (D25), so the phone must be on
   the **office Wi-Fi** whose DNS resolves the host name. Open `https://<host>/api/health` in the
   phone browser first: it must return `{"status":"ok",…}` with no certificate warning, which
   means the CA is trusted (setup below). Use the host name in the certificate, never the IP
   address, or the certificate won't match. If the phone can't resolve the name, check it's on the
   office SSID and not mobile data, and ask IT whether the guest network can reach the host.
   The checklist is at **`https://<host>/offline-spike`**.
5. Have the phones on office Wi-Fi for setup. "Offline" below means **Airplane mode on, Wi-Fi
   and mobile data off**.

## Device setup — draft steps for the runbook (AC3)

These are proposed steps, not yet proven on a phone. The device runs confirm or correct them.

### A. Company-managed phone (MDM)

1. IT pushes the internal root CA to the phone as a trusted certificate profile (Intune or the
   firm's MDM):
   - **iOS:** a "Trusted certificate" profile. Full trust is enabled by the MDM payload. Check
     _Settings → General → About → Certificate Trust Settings_ shows the CA switched on.
   - **Android (work profile or fully managed):** a "Trusted certificate" profile. Chrome uses the
     Android user CA store for a managed CA. Check _Settings → Security → Encryption & credentials
     → User credentials_.
2. Open `https://<host>/offline-spike` in **Safari** (iOS) or **Chrome** (Android). There must be
   no certificate warning and the address bar should show the padlock.
3. Install the app:
   - **iOS:** Share → **Add to Home Screen** → Add. (Safari is the reliable path. iOS 16.4+ can
     also add from other browsers, but they still use WebKit.)
   - **Android:** Chrome menu → **Install app** (or **Add to Home screen** → Install).
   - The MDM may instead push a Web Clip (iOS) or a managed web app (Android) pointing at
     `https://<host>/offline-spike?launch=home-screen`. Record which method was used.
4. Open the Home Screen icon once **while online**. The checklist must say _Installed app: Yes_
   and _Service worker: Controlling this page_.
5. Tap **Request persistent storage** and record the result.

### B. Personal phone (self-installed CA)

1. Get the internal root CA certificate file (`.cer`/`.crt`, **root CA only, never the server
   certificate or key**) from IT. Use an approved channel: an email from IT, or a download page on
   the office network.
2. Install it:
   - **iOS:** open the file → _Settings → Profile Downloaded_ → Install (passcode). **Then**
     _Settings → General → About → Certificate Trust Settings_ → switch on full trust for the CA.
     Without this second step Safari still warns.
   - **Android:** _Settings → Security → Encryption & credentials → Install a certificate → CA
     certificate_ → accept the warning → pick the file. The phone may show a "network may be
     monitored" notice. Chrome trusts user-installed CAs for websites.
3. Then follow A2–A5 (open in Safari/Chrome, Add to Home Screen, open once online, request
   persistent storage).

### Removing it again

Delete the Home Screen icon, clear website data for the host (iOS: _Settings → Safari → Advanced
→ Website Data_; Android: Chrome → _Site settings → All sites → host → Clear & reset_), and on
personal phones remove the CA profile or certificate.

## Running the scenarios

Run each scenario in the **installed app**. Also run S4, S5 and S6 in a **browser tab** (Safari
or Chrome). On iOS the Home Screen app and Safari keep **separate storage**, so save and check
within the same mode.

For every check: pick the scenario in **Scenario being checked**, tap **Check saved draft** (and
**Check and record** in section 3 for the device code), then tap **Copy results** and paste the
text into the evidence row's Notes, or attach a screenshot.

| ID  | Scenario                                | Steps                                                                                                                                                                                                                                                                             | Pass when                                                                                                                                      |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | CA trust                                | Device setup A1–A2 or B1–B2                                                                                                                                                                                                                                                       | No certificate warning in the browser                                                                                                          |
| S2  | Worker registers over the internal CA   | Open `/offline-spike` online, reload once                                                                                                                                                                                                                                         | "Controlling this page, shell …"; no console or security warning                                                                               |
| S3  | Install                                 | A3–A4                                                                                                                                                                                                                                                                             | Icon on the Home Screen; opens without browser bars; "Installed app: Yes"                                                                      |
| S4  | `persist()` and `estimate()`            | Tap **Request persistent storage**, then **Refresh**                                                                                                                                                                                                                              | Record the `persist()` value, "Persistent storage" value and quota (no pass/fail; record per installed/tab)                                    |
| S5  | Cold start offline after reboot         | Online: open the app once. Turn on Airplane mode. Power the phone off and on. Without any connection, tap the Home Screen icon                                                                                                                                                    | Checklist opens (no "can't connect" page); "Browser says offline"; **Check server reachable** says not reachable                               |
| S6  | Draft + 3 MB photo survives force-close | Online or offline: take a photo of about 3 MB (or leave empty for the generated file), **Save draft on device** ("Saved on device at …"). Force-close (iOS: swipe up in the app switcher; Android: Recents → swipe away, or _App info → Force stop_ for an installed app). Reopen | **Check saved draft** = PASS (size and SHA-256 match), photo preview shows                                                                     |
| S7  | … survives reboot                       | After S6, restart the phone, open the app (offline is fine)                                                                                                                                                                                                                       | PASS                                                                                                                                           |
| S8  | … survives app update                   | After S6, deploy **build B** to the test host. Open the app online, wait 10 s, tap **Apply update** (tap again if it says an update is installing). The page reloads. Note the new shell version                                                                                  | Shell version changed; **Check saved draft** = PASS ("saved with shell" shows the old version)                                                 |
| S9  | … survives 8 days unused                | After S6/S7, don't open the app (or the site in the browser) for 8 full days. Then open it **offline first** (S5 style), check, then online                                                                                                                                       | App opens offline; PASS. Record exact days from "(x.xx days ago)"                                                                              |
| S10 | Low storage surfaces an error           | Section 4: **Fill storage** (start with the default limit; raise it towards the quota shown in S4) until it stops with an error. Then tap **Save draft on device**. Afterwards tap **Delete filler**. Optional: repeat on a phone whose own storage is nearly full                | A visible red "Save failed: not saved on device" with the error (e.g. `QuotaExceededError`); no false "Saved on device". Record the MB written |
| S11 | Device code and counter                 | Section 3: **Create device code**, **Add 1 to counter** twice. After S6, S7, S8 and S9 tap **Check and record**                                                                                                                                                                   | Record which stores keep the code and counter after each scenario (IndexedDB, localStorage, Cache Storage, OPFS; "error" means unsupported)    |
| S12 | Clearing site data                      | With a saved draft and device code: clear website data for the host (see _Removing it again_, without deleting the icon). Reopen the app online, then check                                                                                                                       | Record what remains: draft, device code per store, worker (no pass/fail; this is a measurement)                                                |
| S13 | Main app offline (for C12–C14)          | Offline, in the installed app, tap **Open the main app**                                                                                                                                                                                                                          | Record what shows. Expected today: "Material Mule is unavailable", because the main app needs `/api/me` before it shows anything               |

Optional extra on iOS: repeat S6 with **Store the photo as: ArrayBuffer** if the Blob run fails.

## Evidence table (AC1) — fill in on the card

One row per scenario × device/browser/mode. Leave Result blank until it is run. Result is
**Pass**, **Fail** or **Recorded** (measurements S4, S11, S12, S13).

| Scenario | Device (model) | Managed / personal | OS + version | Browser + version | Mode (installed / tab) | Shell version | Result | Notes / pasted results | Date | Tester |
| -------- | -------------- | ------------------ | ------------ | ----------------- | ---------------------- | ------------- | ------ | ---------------------- | ---- | ------ |
| S1       | iPhone …       |                    | iOS …        | Safari …          | tab                    |               |        |                        |      |        |
| S2       | iPhone …       |                    | iOS …        | Safari …          | tab                    |               |        |                        |      |        |
| S3       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S4       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S4       | iPhone …       |                    | iOS …        | Safari …          | tab                    |               |        |                        |      |        |
| S5       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S5       | iPhone …       |                    | iOS …        | Safari …          | tab                    |               |        |                        |      |        |
| S6       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S6       | iPhone …       |                    | iOS …        | Safari …          | tab                    |               |        |                        |      |        |
| S7       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S8       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S9       | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S10      | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S11      | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S12      | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S13      | iPhone …       |                    | iOS …        | Safari …          | installed              |               |        |                        |      |        |
| S1       | Android …      |                    | Android …    | Chrome …          | tab                    |               |        |                        |      |        |
| S2       | Android …      |                    | Android …    | Chrome …          | tab                    |               |        |                        |      |        |
| S3       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S4       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S4       | Android …      |                    | Android …    | Chrome …          | tab                    |               |        |                        |      |        |
| S5       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S5       | Android …      |                    | Android …    | Chrome …          | tab                    |               |        |                        |      |        |
| S6       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S6       | Android …      |                    | Android …    | Chrome …          | tab                    |               |        |                        |      |        |
| S7       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S8       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S9       | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S10      | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S11      | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S12      | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |
| S13      | Android …      |                    | Android …    | Chrome …          | installed              |               |        |                        |      |        |

Repeat the block for each further phone, including the second managed/personal setup. At minimum,
S1–S3 must be run on both a managed and a personal phone per platform.

## Recommendation (AC2) — to write after the runs

_Installed web app is enough_ / _managed native shell needed_: not decided. Base it on the failing
rows above (especially S5, S8, S9, S10) and name them.

## Local results

These were run in desktop Chromium on the dev PC on 2026-11-07. They are **not** phone evidence.

- The worker registers at scope `/` on `http://127.0.0.1` (a secure context) and precaches 18
  files. The `sw.js` and manifest headers are as above.
- **Cold start with the server stopped:** a persistent Chromium profile loaded the app online once
  and saved a draft with the generated 3 MB file (Blob) and a device code. The browser was closed
  and the API stopped, then the browser relaunched on `/offline-spike`. The page was served by the
  worker (HTTP 200, `fromServiceWorker`, about 130 ms). **Check saved draft** passed (size and
  SHA-256 match). `/api/health` failed as expected. `/` showed "Material Mule is unavailable"
  (S13 expectation), with fonts loaded from the cache.
- E2E `e2e/offline-shell.spec.ts` (desktop-chromium and phone-chromium) saves a draft, goes
  offline, reloads, checks the draft, opens a new tab offline (served by the worker) and checks
  the manifest and icons.
- The in-app preview browser of the Claude desktop app refuses to register service workers
  ("unknown error fetching the script"). That is a limit of that preview pane, not of the build;
  real Chromium registers it.

## Known limits and questions for C12–C17

- The main app can't start offline beyond "unavailable": `SessionProvider` needs `/api/me`.
  Offline field reports need a route that renders without a live session (C12/C14 and sign-in
  timing; D38 is still deferred).
- Network-first page loads wait up to 4 s on a connection that is connected but not working
  before the cached shell starts. Tune this from S5 on site.
- When a new worker activates, it deletes the old build's cache. An old tab that is still open
  and later lazy-loads a chunk while offline would fail. C17 needs an update policy that
  postpones activation while unsynced work exists (spec CD-21).
- `start_url` points at the spike page. Production needs it to point at the field-report entry
  point.
- Kill switch: deploying a build whose `sw.js` unregisters itself removes the worker everywhere
  on next online start. A missing `sw.js` (404) leaves an installed worker in place.
- The precache holds the scanner wasm (≈ 0.9 MB). The main JS bundle is ≈ 1 MB and not split.
