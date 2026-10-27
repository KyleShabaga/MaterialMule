import type { StorageUnitLookupResponse } from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { scanLookup } from './api';
import {
  CAMERA_FOUND_DELAY_MS,
  CAMERA_FRAME_INTERVAL_MS,
  CameraScanGate,
  cameraConstraints,
  cameraPrecheck,
  classifyCameraError,
  type CameraProblem,
} from './camera-core';
import { createFrameReader, type FrameReader } from './camera-frame';
import {
  createBarcodeDecoder,
  DECODER_LABEL,
  type BarcodeDecoder,
  type DecoderFactory,
  type DecoderPreference,
} from './decoder';
import { cleanScannedValue, displayScannedValue } from './scan-core';
import './scanning.css';

type CameraState =
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'paused' }
  | { kind: 'problem'; problem: CameraProblem };

interface ResultView {
  tone: 'busy' | 'success' | 'error';
  message: string;
  /** Code to look up again with Retry (server unreachable). */
  retry?: string;
}

/** The camera parts of `navigator.mediaDevices` the scanner uses (replaceable in tests). */
export type CameraDevices = Pick<MediaDevices, 'getUserMedia'> &
  Partial<Pick<MediaDevices, 'enumerateDevices'>>;

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Full-screen phone-camera scanner (MM-T17). It only exists after the user taps "Scan with
 * camera", so the camera permission prompt never appears before that. Decodes Code 128 or QR
 * locally through the decoder adapter (~10 fps, capped resolution), looks the code up once with
 * T12's lookup and hands the unit to `onFound`. The stream stops on close, unmount (route
 * change) and when the page is hidden. Manual entry stays available in every state.
 */
export function CameraScanner({
  onClose,
  onFound,
  decoderPreference = 'auto',
  decoderFactory = createBarcodeDecoder,
  devices: injectedDevices,
  secureContext,
  readFrame: injectedReadFrame,
}: {
  onClose: () => void;
  onFound: (unit: StorageUnitLookupResponse) => void;
  decoderPreference?: DecoderPreference;
  decoderFactory?: DecoderFactory;
  devices?: CameraDevices;
  secureContext?: boolean;
  readFrame?: FrameReader;
}) {
  const headingId = useId();
  const [devices] = useState<CameraDevices | undefined>(
    () => injectedDevices ?? navigator.mediaDevices,
  );
  const [precheck] = useState(() =>
    cameraPrecheck({
      isSecureContext: secureContext ?? window.isSecureContext,
      hasGetUserMedia: typeof devices?.getUserMedia === 'function',
    }),
  );
  const [camera, setCamera] = useState<CameraState>(
    precheck ? { kind: 'problem', problem: precheck } : { kind: 'starting' },
  );
  const [attempt, setAttempt] = useState(0);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [cameraIds, setCameraIds] = useState<string[]>([]);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({
    supported: false,
    on: false,
  });
  const [decoderName, setDecoderName] = useState<BarcodeDecoder['name'] | null>(null);
  const [result, setResult] = useState<ResultView | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const gateRef = useRef(new CameraScanGate());
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const foundTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onFoundRef = useRef(onFound);
  useEffect(() => {
    onFoundRef.current = onFound;
  });

  const running = camera.kind === 'starting' || camera.kind === 'live';

  /** Looks a decoded or typed code up; on a match shows "Found …" then opens the unit. */
  async function resolve(code: string, typed = false) {
    if (doneRef.current) return;
    busyRef.current = true;
    const shown = displayScannedValue(code);
    setResult({ tone: 'busy', message: `Looking up ${shown}…` });
    const answer = await scanLookup(code);
    busyRef.current = false;
    if (doneRef.current) return;
    switch (answer.kind) {
      case 'found': {
        doneRef.current = true;
        const unit = answer.unit;
        setResult({ tone: 'success', message: `Found ${unit.readableId}` });
        if (typed) {
          onFoundRef.current(unit);
          return;
        }
        navigator.vibrate?.(150);
        foundTimer.current = setTimeout(() => onFoundRef.current(unit), CAMERA_FOUND_DELAY_MS);
        return;
      }
      case 'not_found':
        setResult({ tone: 'error', message: `No storage unit found for ${shown}` });
        return;
      case 'unavailable':
        setResult({ tone: 'error', message: `${shown}: ${answer.message}`, retry: code });
        return;
      case 'error':
        setResult({ tone: 'error', message: `${shown}: ${answer.message}` });
    }
  }
  const resolveRef = useRef(resolve);
  useEffect(() => {
    resolveRef.current = resolve;
  });

  useEffect(() => () => clearTimeout(foundTimer.current), []);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Stop the camera while the page is hidden (another app, locked phone).
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        setCamera((current) =>
          current.kind === 'starting' || current.kind === 'live' ? { kind: 'paused' } : current,
        );
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Start the stream and the decode loop; everything stops in the cleanup.
  useEffect(() => {
    if (!running || !devices) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readFrame = injectedReadFrame ?? createFrameReader();
    const video = videoRef.current;

    async function start(media: CameraDevices) {
      try {
        stream = await media.getUserMedia(cameraConstraints(deviceId));
      } catch (error) {
        if (!cancelled) setCamera({ kind: 'problem', problem: classifyCameraError(error) });
        return;
      }
      if (cancelled) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      if (video) {
        video.srcObject = stream;
        video.play?.()?.catch(() => undefined);
      }
      setCamera({ kind: 'live' });

      const track = stream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorch({ supported: Boolean(capabilities?.torch), on: false });
      media.enumerateDevices?.().then(
        (list) => {
          if (!cancelled) {
            setCameraIds(list.filter((d) => d.kind === 'videoinput').map((d) => d.deviceId));
          }
        },
        () => undefined,
      );

      let decoder: BarcodeDecoder;
      try {
        decoder = await decoderFactory(decoderPreference);
      } catch {
        if (!cancelled) setCamera({ kind: 'problem', problem: 'failed' });
        return;
      }
      if (cancelled) return;
      setDecoderName(decoder.name);

      const tick = async () => {
        if (cancelled || doneRef.current) return;
        const frame = !busyRef.current && video ? readFrame(video) : null;
        if (frame) {
          const symbols = await decoder.decode(frame).catch(() => []);
          if (cancelled) return;
          const codes = symbols.map((symbol) => cleanScannedValue(symbol.text)).filter(Boolean);
          const code = gateRef.current.next(codes, Date.now());
          if (code) await resolveRef.current(code);
        }
        if (!cancelled && !doneRef.current) timer = setTimeout(tick, CAMERA_FRAME_INTERVAL_MS);
      };
      void tick();
    }

    void start(devices);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stopStream(stream);
      streamRef.current = null;
      if (video) video.srcObject = null;
    };
  }, [running, attempt, deviceId, devices, decoderFactory, decoderPreference, injectedReadFrame]);

  function restart() {
    setResult(null);
    setCamera({ kind: 'starting' });
    setAttempt((count) => count + 1);
  }

  function switchCamera() {
    const current = streamRef.current?.getVideoTracks()[0]?.getSettings?.().deviceId;
    const index = current ? cameraIds.indexOf(current) : -1;
    const next = cameraIds[(index + 1) % cameraIds.length];
    if (next && next !== current) {
      setCamera({ kind: 'starting' });
      setDeviceId(next);
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on });
    } catch {
      setTorch({ supported: false, on: false });
    }
  }

  function retry(code: string) {
    gateRef.current.reset();
    void resolve(code);
  }

  const status =
    result?.message ??
    (camera.kind === 'live'
      ? 'Point at the label'
      : camera.kind === 'starting'
        ? 'Starting the camera…'
        : camera.kind === 'paused'
          ? 'Camera paused'
          : '');

  return (
    <div
      className="camera-scanner"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="camera-top">
        <h2 id={headingId}>Scan with camera</h2>
        <button type="button" ref={closeRef} onClick={onClose}>
          Close camera
        </button>
      </div>

      {camera.kind === 'problem' ? (
        <CameraProblemMessage problem={camera.problem} onTryAgain={restart} />
      ) : (
        <div className="camera-view">
          <video ref={videoRef} playsInline muted autoPlay aria-hidden="true" />
          <div className="camera-guide" aria-hidden="true" />
        </div>
      )}

      <div className="camera-bottom">
        {camera.kind !== 'problem' ? (
          <p
            className={`camera-status camera-status-${result?.tone ?? 'info'}`}
            role="status"
            aria-live="polite"
          >
            {status}
          </p>
        ) : null}
        <div className="camera-controls">
          {result?.retry ? (
            <button type="button" onClick={() => retry(result.retry!)}>
              Retry
            </button>
          ) : null}
          {camera.kind === 'paused' ? (
            <button type="button" className="primary" onClick={restart}>
              Resume camera
            </button>
          ) : null}
          {camera.kind === 'live' && cameraIds.length > 1 ? (
            <button type="button" onClick={switchCamera}>
              Switch camera
            </button>
          ) : null}
          {camera.kind === 'live' && torch.supported ? (
            <button type="button" aria-pressed={torch.on} onClick={() => void toggleTorch()}>
              Torch
            </button>
          ) : null}
        </div>
        <ManualEntry onSubmit={(code) => void resolve(code, true)} />
        {decoderName ? (
          <p className="camera-decoder">Decoder: {DECODER_LABEL[decoderName]}</p>
        ) : null}
      </div>
    </div>
  );
}

const PROBLEM_TEXT: Record<CameraProblem, { title: string; body: string[] }> = {
  insecure: {
    title: 'The camera needs a secure (HTTPS) connection',
    body: [
      'Browsers only allow the camera on pages opened with https://. Open Material Mule at its https:// office address (ask whoever looks after the Material Mule PC), then try again.',
      'Until then, type the storage unit ID below.',
    ],
  },
  denied: {
    title: 'Camera access is blocked',
    body: [
      'iPhone (Safari): tap aA in the address bar → Website Settings → Camera → Allow. If Camera is missing there, open Settings → Safari → Camera → Allow.',
      'Android (Chrome): tap the icon left of the address → Permissions → Camera → Allow.',
      'Then tap Try again, or type the storage unit ID below.',
    ],
  },
  no_camera: {
    title: 'No camera found',
    body: [
      'This device or browser has no camera Material Mule can use. Type the ID below instead.',
    ],
  },
  in_use: {
    title: 'The camera is busy',
    body: ['Another app may be using the camera. Close it, then tap Try again.'],
  },
  failed: {
    title: "The camera scanner couldn't start",
    body: ['Tap Try again, or type the storage unit ID below.'],
  },
};

function CameraProblemMessage({
  problem,
  onTryAgain,
}: {
  problem: CameraProblem;
  onTryAgain: () => void;
}) {
  const text = PROBLEM_TEXT[problem];
  return (
    <div className="camera-problem" role="alert">
      <h3>{text.title}</h3>
      {text.body.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {problem === 'denied' || problem === 'in_use' || problem === 'failed' ? (
        <button type="button" onClick={onTryAgain}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Typing the ID always works, whatever the camera does. */
function ManualEntry({ onSubmit }: { onSubmit: (code: string) => void }) {
  const id = useId();
  const [code, setCode] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const cleaned = cleanScannedValue(code);
    if (cleaned) onSubmit(cleaned);
  }
  return (
    <form className="camera-manual" onSubmit={submit} aria-label="Type the ID instead">
      <label htmlFor={id}>Or type the storage unit ID</label>
      <div className="inline-input">
        <input
          id={id}
          type="text"
          value={code}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="e.g. BKT-2026-000014"
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit">Open</button>
      </div>
    </form>
  );
}
