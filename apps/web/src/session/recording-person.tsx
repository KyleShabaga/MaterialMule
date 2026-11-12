// The shared LAB station's recording person (STRATA-16, 61 and 125 as one controller): who the
// work done at this computer is credited to. It is attribution only. It never grants that
// person's roles or permissions, and the server re-validates every performer it is sent.
import { ChevronDown, LogOut, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { clearIdentityToasts } from '@/components/strata/toast';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useSession } from './context';
import {
  PERSONAL_CONTROLLER,
  RecordingPersonContext,
  SIGN_OFF_UNDO_MS,
  WHO_IS_WORKING_PATH,
  clearRecordingPerson,
  readStoredPerson,
  stationSessionKey,
  storeRecordingPerson,
  useRecordingPerson as useRecordingPersonHook,
  type RecordingPersonController,
  type StationPeople,
} from './recording-person-store';
import { loadActiveStaff, stationPeopleOf, type RecordingPerson } from './station-people';

// Storage helpers, constants and useOptionalRecordingPerson are in ./recording-person-store.
export type { RecordingPerson } from './station-people';
export type { RecordingPersonController, StationPeople } from './recording-person-store';

/** The contract hook (lane 1A): `{ isStation, person, pick(person), signOff() }` and more. */
// eslint-disable-next-line react-refresh/only-export-components -- fixed contract export
export const useRecordingPerson = useRecordingPersonHook;

/**
 * Mounted once around every signed-in route (the picker and the app shell), inside the router.
 * Personal accounts get an inert controller; a LAB station gets the picked person.
 */
export function RecordingPersonProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const me = session.status === 'active' ? session.me : null;
  const isStation = me?.accountType === 'shared_lab';
  const sessionKey = me && isStation ? stationSessionKey(me) : null;
  if (!sessionKey) {
    return (
      <RecordingPersonContext.Provider value={PERSONAL_CONTROLLER}>
        {children}
      </RecordingPersonContext.Provider>
    );
  }
  return <StationProvider sessionKey={sessionKey}>{children}</StationProvider>;
}

/** Layout-route form of the provider: `{ element: <RecordingPersonLayout />, children }`. */
export function RecordingPersonLayout() {
  return (
    <RecordingPersonProvider>
      <Outlet />
    </RecordingPersonProvider>
  );
}

function StationProvider({ sessionKey, children }: { sessionKey: string; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [person, setPerson] = useState<RecordingPerson | null>(() => readStoredPerson(sessionKey));
  const [people, setPeople] = useState<StationPeople>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    loadActiveStaff().then(
      (staff) => {
        if (current) setPeople({ state: 'ready', staff, people: stationPeopleOf(staff) });
      },
      () => {
        if (current) setPeople({ state: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const reloadPeople = useCallback(() => {
    setPeople({ state: 'loading' });
    setAttempt((count) => count + 1);
  }, []);

  // Re-validate the remembered person against today's staff: someone disabled (or without
  // initials) since they were picked is no longer the recording person, and the station asks.
  const stale =
    people.state === 'ready' &&
    person !== null &&
    !people.staff.some((member) => member.id === person.id && member.initials);
  const current = stale ? null : person;
  const notice = stale
    ? `${person?.displayName ?? 'This person'} can’t be recorded as any more. Choose who is working here.`
    : null;
  useEffect(() => {
    if (stale) storeRecordingPerson(sessionKey, null);
  }, [stale, sessionKey]);

  const pick = useCallback(
    (next: RecordingPerson) => {
      setPerson(next);
      storeRecordingPerson(sessionKey, next);
    },
    [sessionKey],
  );

  const here = `${location.pathname}${location.search}${location.hash}`;
  const signOff = useCallback(() => {
    const previous = current;
    // Leave the page first, so no screen renders for a moment with nobody picked.
    void Promise.resolve(navigate(WHO_IS_WORKING_PATH, { state: { signedOff: true } })).then(() => {
      setPerson(null);
      clearRecordingPerson();
    });
    if (!previous) return;
    // The previous person's toasts (Undo of their move, say) never carry over to the next person.
    clearIdentityToasts();
    toast(`Signed off ${previous.displayName}`, {
      description: 'Back to Who is working here? Nothing was recorded by signing off.',
      duration: SIGN_OFF_UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          pick(previous);
          void navigate(here);
        },
      },
    });
  }, [current, here, navigate, pick]);

  const value = useMemo<RecordingPersonController>(
    () => ({
      isStation: true,
      person: current,
      pick,
      signOff,
      people,
      reloadPeople,
      notice,
    }),
    [current, pick, signOff, people, reloadPeople, notice],
  );
  return (
    <RecordingPersonContext.Provider value={value}>{children}</RecordingPersonContext.Provider>
  );
}

/**
 * On a station with no one picked, sends the browser to "Who is working here?" and remembers
 * where it was going. Personal accounts pass straight through. Renders `children`, or the
 * matched child route when used as a layout route.
 */
export function RequireRecordingPerson({ children }: { children?: ReactNode }) {
  const { isStation, person } = useRecordingPerson();
  const location = useLocation();
  if (isStation && !person) {
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={WHO_IS_WORKING_PATH} replace state={{ from }} />;
  }
  return children ?? <Outlet />;
}

/** Initials on a round avatar (shadcn Avatar), decorative: the name is always beside it. */
export function PersonAvatar({
  person,
  className,
}: {
  person: Pick<RecordingPerson, 'initials'>;
  className?: string;
}) {
  return (
    <Avatar aria-hidden="true" className={cn('size-8', className)}>
      <AvatarFallback className="bg-muted font-mono text-[13px] font-bold text-foreground">
        {person.initials}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Top-bar "Recording as <person>" chip and person menu (STRATA-16, 61, 125). Renders nothing for
 * personal accounts. The shell renders it left of Quick actions.
 */
export function RecordingAsChip() {
  const { isStation, person, people, pick, signOff } = useRecordingPerson();
  const navigate = useNavigate();
  const location = useLocation();
  if (!isStation || !person) return null;

  const listed = people.state === 'ready' ? people.people : [];
  const choices = listed.some((candidate) => candidate.id === person.id)
    ? listed
    : [person, ...listed];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={`Recording as ${person.displayName}. Sign off or switch person`}
          className="h-11 gap-2 rounded-full border-primary/30 bg-accent pr-3 pl-1.5 text-accent-foreground hover:bg-accent/80 has-[>svg]:pr-3"
        >
          <PersonAvatar person={person} />
          <span className="font-normal">
            Recording as <span className="font-semibold">{person.displayName}</span>
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" sideOffset={4} className="w-72">
        <DropdownMenuLabel className="text-[13px] font-normal text-muted-foreground">
          Recording as {person.displayName}
        </DropdownMenuLabel>
        {/* Sign off comes first and stands apart from the person list, so it isn't hit by mistake. */}
        <DropdownMenuItem className="min-h-11 items-start" onSelect={() => signOff()}>
          <LogOut aria-hidden="true" className="mt-0.5" />
          <span className="grid leading-tight">
            <span className="font-medium">Sign off {person.displayName}</span>
            <span className="text-[13px] text-muted-foreground">Back to Who is working here?</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[13px] font-normal text-muted-foreground">
          Switch person
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={person.id}
          onValueChange={(id) => {
            const next = choices.find((candidate) => candidate.id === id);
            if (next) pick(next);
          }}
        >
          {choices.map((candidate) => (
            <DropdownMenuRadioItem
              key={candidate.id}
              value={candidate.id}
              className="min-h-11 gap-3"
            >
              <PersonAvatar person={candidate} className="size-7" />
              <span className="grid leading-tight">
                <span>{candidate.displayName}</span>
                <span className="text-[13px] text-muted-foreground">{candidate.roleLine}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuItem
          className="min-h-11 gap-3"
          onSelect={() =>
            void navigate(`${WHO_IS_WORKING_PATH}?someoneElse=1`, {
              state: { from: `${location.pathname}${location.search}${location.hash}` },
            })
          }
        >
          <UserPlus aria-hidden="true" />
          Someone else…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
