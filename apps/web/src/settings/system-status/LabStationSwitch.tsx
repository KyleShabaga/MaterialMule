import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TriangleAlert } from 'lucide-react';
import { isLabStationComputer, setLabStationComputer } from '../../session/station';

/**
 * STRATA-18 remainder: an administrator marks this computer as the shared LAB station, so its
 * sign-in page opens straight on the LAB form. The mark is saved in this browser only, holds no
 * identity or secret and authorizes nothing (DESIGN.md › Choices made, "How a computer becomes
 * the LAB station"). When the browser refuses to save it, the switch says so and stays as it was.
 */
export function LabStationSwitch() {
  const id = useId();
  const [on, setOn] = useState(isLabStationComputer);
  const [refused, setRefused] = useState(false);

  const change = (next: boolean) => {
    if (setLabStationComputer(next)) {
      setOn(next);
      setRefused(false);
    } else {
      setRefused(true);
    }
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-10" data-slot="lab-station-switch">
      <h3 id={`${id}-heading`} className="border-b pb-3 text-base font-semibold">
        This computer
      </h3>
      <div className="flex items-center justify-between gap-8 py-4">
        <div className="grid min-w-0 gap-1">
          <Label htmlFor={`${id}-switch`} className="text-sm font-medium">
            This computer is the LAB station
          </Label>
          <span id={`${id}-hint`} className="text-sm text-muted-foreground">
            Its sign-in page opens on the shared LAB form. Saved in this browser only; it grants
            nothing.
          </span>
        </div>
        <Switch
          id={`${id}-switch`}
          aria-describedby={`${id}-hint`}
          checked={on}
          onCheckedChange={change}
        />
      </div>
      {refused ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This browser didn't save the setting.</AlertTitle>
          <AlertDescription>
            Its storage is blocked or full. The sign-in page keeps opening on the Microsoft form,
            with the “Sign in as LAB” link.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
