import { Camera } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CameraScanner } from './CameraScanner';
import { readDecoderPreference } from './decoder';

/**
 * "Scan with camera" (MM-T17). The scanner, and so the camera permission prompt, exists only
 * after this button is tapped. A found unit opens its record.
 */
export function CameraScanButton({
  prominent = false,
  className,
}: {
  /** The Scan page's viewfinder: the screen's one primary action, phone sized. */
  prominent?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <Button
        ref={button}
        type="button"
        variant={prominent ? 'default' : 'outline'}
        size={prominent ? 'lg' : 'sm'}
        className={cn(prominent ? 'h-12 px-6' : 'pointer-coarse:h-11', className)}
        onClick={() => setOpen(true)}
      >
        <Camera aria-hidden="true" />
        Scan with camera
      </Button>
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
