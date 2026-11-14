import type { StationConfig } from '@materialmule/shared';
import { Eye, EyeOff, FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useSession } from '../../session/context';
import { isLabStationComputer } from '../../session/station';
import { defaultStationConfig, fetchStationConfig } from './api';
import { CustomizeStation } from './CustomizeStation';
import { stationId } from './station-id';
import { STATION_ROW_INFO } from './rows';

// STRATA-36 (d), Kyle 2026-11-13: a Lab Manager sets up a LAB station by signing in with their
// own account on that computer. Their personal Today then shows this card, which opens the
// editable "Customize this station". The LAB session itself can never save.

/** The permission the API checks on PUT /api/station/config/:stationId. */
export const STATION_CONFIGURE_PERMISSION = 'station.configure';

/** Renders only on a computer marked as the LAB station, for a Lab Manager's own account. */
export function StationSetupCard() {
  const { session } = useSession();
  const me = session.status === 'active' ? session.me : null;
  const [onStation] = useState(isLabStationComputer);
  const allowed =
    onStation &&
    me !== null &&
    me.accountType !== 'shared_lab' &&
    me.permissions.includes(STATION_CONFIGURE_PERMISSION);
  return allowed ? <SetupCard /> : null;
}

type Load = { state: 'loading' } | { state: 'ready'; config: StationConfig; failed: boolean };

function SetupCard() {
  const [id] = useState(stationId);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    void fetchStationConfig(id).then((config) => {
      if (!active) return;
      setLoad(
        config
          ? { state: 'ready', config, failed: false }
          : { state: 'ready', config: defaultStationConfig(id), failed: true },
      );
    });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical aria-hidden="true" className="size-4 text-muted-foreground" />
          This computer is a LAB station
        </CardTitle>
        <CardDescription>
          You can choose what its Today shows under At this station. Everyone at this computer sees
          the same rows.
        </CardDescription>
        {load.state === 'ready' && !load.failed ? (
          <CardAction>
            <CustomizeStation
              config={load.config}
              editable
              onChange={(config) => setLoad({ state: 'ready', config, failed: false })}
              reload={() => fetchStationConfig(id)}
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {load.state === 'loading' ? (
          <p aria-busy="true" className="text-sm text-muted-foreground">
            Loading this station’s setup…
          </p>
        ) : load.failed ? (
          <p role="alert" className="text-sm text-destructive-text">
            This station’s setup couldn’t load. Reload the page to try again.
          </p>
        ) : (
          <>
            <ol className="flex flex-col gap-1.5 text-sm" aria-label="This station’s rows">
              {load.config.rows.map(({ row, visible }) => (
                <li key={row} className="flex items-center gap-2">
                  {visible ? (
                    <Eye aria-hidden="true" className="size-4 text-muted-foreground" />
                  ) : (
                    <EyeOff aria-hidden="true" className="size-4 text-muted-foreground" />
                  )}
                  <span className={visible ? undefined : 'text-muted-foreground'}>
                    {STATION_ROW_INFO[row].title}
                  </span>
                  <span className="text-muted-foreground">· {visible ? 'Shown' : 'Hidden'}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[13px] text-muted-foreground">
              {load.config.updatedBy
                ? `Last set up by ${load.config.updatedBy.name}.`
                : 'Showing the defaults: nobody has set up this station yet.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
