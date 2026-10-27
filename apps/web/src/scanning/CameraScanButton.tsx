import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CameraScanner } from './CameraScanner';
import { readDecoderPreference } from './decoder';

/**
 * "Scan with camera" (MM-T17). The scanner, and so the camera permission prompt, exists only
 * after this button is tapped. A found unit opens its record.
 */
export function CameraScanButton() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button
        ref={button}
        type="button"
        className="camera-scan-button"
        onClick={() => setOpen(true)}
      >
        Scan with camera
      </button>
      {open ? (
        <CameraScanner
          decoderPreference={readDecoderPreference(location.search)}
          onClose={() => {
            setOpen(false);
            // Back where the person was, not the page body (MM-T61).
            button.current?.focus();
          }}
          onFound={(unit) => {
            setOpen(false);
            navigate(`/sample-storage/${encodeURIComponent(unit.readableId)}`, {
              state: { from: '' },
            });
          }}
        />
      ) : null}
    </>
  );
}
