import { useId, type ReactNode } from 'react';
import type { ScanSound } from './feedback';
import type { Scanner } from './useScanner';
import './scanning.css';

export type ScanTone = 'ready' | 'busy' | 'success' | 'error' | 'warning';

export interface ScanStatusView {
  tone: ScanTone;
  /** The result in words; announced to screen readers. */
  message: string;
  /** Extra line under the message, e.g. "Already scanned". */
  detail?: string;
}

const TONE_LABEL: Record<ScanTone, string> = {
  ready: '',
  busy: '',
  success: 'Success: ',
  error: 'Problem: ',
  warning: 'Check: ',
};

/**
 * The focused scan field and its large status area (MM-T16). The scanner types into the field and
 * ends with Enter; `useScanner` does the rest. When focus leaves the panel an overlay covers it
 * ("Click here to resume scanning") so a scan is never silently lost or typed somewhere else.
 */
export function ScanInput({
  scanner,
  label,
  status,
  lastScanned,
  actions,
  sound,
}: {
  scanner: Scanner;
  label: string;
  status: ScanStatusView;
  lastScanned: string | null;
  /** Buttons that belong to the result, such as Retry. */
  actions?: ReactNode;
  sound: ScanSound;
}) {
  const id = useId();
  return (
    <div
      className={`scan-panel${scanner.paused ? ' scan-paused' : ''}`}
      {...scanner.containerProps}
    >
      <div className="scan-field-row">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="scan-field"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          aria-describedby={`${id}-ready`}
          {...scanner.inputProps}
        />
        <p id={`${id}-ready`} className="scan-ready">
          {scanner.paused ? 'Scanning paused' : 'Ready to scan'}
        </p>
      </div>

      <div className={`scan-status scan-status-${status.tone}`}>
        <p className="scan-message" role="status" aria-live="polite" aria-atomic="true">
          <span className="visually-hidden">{TONE_LABEL[status.tone]}</span>
          {status.message}
          {status.detail ? <span className="scan-detail">{status.detail}</span> : null}
        </p>
        <p className="scan-last">
          Last scanned: <strong>{lastScanned ?? '—'}</strong>
        </p>
        {actions ? <div className="scan-actions">{actions}</div> : null}
      </div>

      <label className="scan-sound">
        <input
          type="checkbox"
          checked={sound.on}
          onChange={(event) => {
            sound.setOn(event.target.checked);
            scanner.resume();
          }}
        />{' '}
        Play a sound for each result
      </label>

      {scanner.paused ? (
        <button type="button" className="scan-overlay" onClick={scanner.resume}>
          <strong>Scanning paused</strong>
          <span>Click here to resume scanning</span>
        </button>
      ) : null}
    </div>
  );
}
