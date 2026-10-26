import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CameraScanner } from './CameraScanner';
import { readDecoderPreference } from './decoder';

/**
 * "Scan with camera" (MM-T17). The scanner, and so the camera permission prompt, exists only
 * after this button is tapped. A found unit opens its record.
 */
export function CameraScanButton() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button type="button" className="camera-scan-button" onClick={() => setOpen(true)}>
        Scan with camera
      </button>
      {open ? (
        <CameraScanner
          decoderPreference={readDecoderPreference(location.search)}
          onClose={() => setOpen(false)}
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
