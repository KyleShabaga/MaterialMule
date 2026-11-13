import type { ReceiverOption } from '@materialmule/shared';
import { ChevronRight, UserPlus, Users } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { SignInLayout } from '../pages/AuthLayout';
import { useSession } from './context';
import { PersonAvatar, useRecordingPerson, type RecordingPerson } from './recording-person';
import { clearRecordingPerson } from './recording-person-store';
import { fromReceiver, searchAllStaff } from './station-people';

const SEARCH_DELAY_MS = 150;

/** Where to go after picking: back where the guard stopped the station, else Today. */
function destinationOf(state: unknown): string {
  if (!state || typeof state !== 'object') return '/';
  const { from, signedOff } = state as { from?: unknown; signedOff?: unknown };
  // After a sign-off the next person starts on Today, never on the previous person's page.
  if (signedOff) return '/';
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

function PersonRow({ person, onPick }: { person: RecordingPerson; onPick(): void }) {
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        className="h-12 w-full justify-start gap-3 px-3 text-left font-normal"
        onClick={onPick}
      >
        <PersonAvatar person={person} />
        <span className="grid flex-1 leading-tight">
          <span className="font-medium">{person.displayName}</span>
          <span className="text-[13px] text-muted-foreground">{person.roleLine}</span>
        </span>
        <ChevronRight aria-hidden="true" className="text-muted-foreground" />
      </Button>
    </li>
  );
}

/** "Someone else…": search every active staff member by initials or name. */
function SomeoneElse({
  onPick,
  onCancel,
}: {
  onPick(option: ReceiverOption): void;
  onCancel(): void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [latest, setLatest] = useState<{
    query: string;
    result: { state: 'error' } | { state: 'ready'; options: ReceiverOption[] };
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = text.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query === '') return;
    let current = true;
    const timer = window.setTimeout(() => {
      searchAllStaff(query).then(
        (options) => {
          if (current) setLatest({ query, result: { state: 'ready', options } });
        },
        () => {
          if (current) setLatest({ query, result: { state: 'error' } });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const result = query !== '' && latest?.query === query ? latest.result : null;
  const status =
    query === ''
      ? 'Type initials or a name.'
      : result === null
        ? 'Searching…'
        : result.state === 'error'
          ? 'Staff search failed. Try again.'
          : result.options.length === 0
            ? 'No active staff match. Ask an administrator to add them.'
            : null;

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        Someone else
      </h2>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-search`}>Find a person</Label>
        <Input
          ref={inputRef}
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Initials or name"
          value={text}
          aria-describedby={`${id}-status`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <p id={`${id}-status`} role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      </div>
      {result?.state === 'ready' && result.options.length > 0 ? (
        <ul aria-label="Matching staff" className="flex flex-col gap-1">
          {result.options.map((option) => (
            <li key={option.id}>
              <Button
                type="button"
                variant="ghost"
                className="h-12 w-full justify-start gap-3 px-3 text-left font-normal"
                onClick={() => onPick(option)}
              >
                <PersonAvatar person={option} />
                <span className="flex-1 font-medium">{option.displayName}</span>
                <ChevronRight aria-hidden="true" className="text-muted-foreground" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="button" variant="outline" className="self-start" onClick={onCancel}>
        Back to the list
      </Button>
    </section>
  );
}

/**
 * Sign-in step 2 on the shared LAB station (DESIGN.md › Sign in › "Step 2 on LAB"): pick who is
 * working here. Everything done at the station is then credited to that person until they sign
 * off. Attribution only: the station keeps LAB's own permissions.
 */
export function WhoIsWorkingPage() {
  const { isStation, people, pick, notice, reloadPeople } = useRecordingPerson();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [searching, setSearching] = useState(params.get('someoneElse') === '1');
  const headingRef = useRef<HTMLHeadingElement>(null);

  if (!isStation) return <Navigate to="/" replace />;

  const destination = destinationOf(location.state);
  function choose(person: RecordingPerson) {
    pick(person);
    void navigate(destination, { replace: true });
  }

  function closeSearch() {
    setSearching(false);
    headingRef.current?.focus();
  }

  const someoneElseRow = (
    <li>
      <Button
        type="button"
        variant="ghost"
        className="h-12 w-full justify-start gap-3 px-3 text-left font-normal text-muted-foreground"
        onClick={() => setSearching(true)}
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border"
        >
          <UserPlus />
        </span>
        <span className="flex-1">Someone else…</span>
      </Button>
    </li>
  );

  return (
    <SignInLayout busy={people.state === 'loading' || undefined}>
      <section aria-labelledby="who-title" className="flex flex-col gap-6">
        <div className="grid gap-1">
          <h1 id="who-title" ref={headingRef} tabIndex={-1} className="text-2xl font-semibold">
            Who is working here?
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed in as LAB. Receipts, moves and labels are recorded under the name you pick, until
            you sign off.
          </p>
          <Link
            to="/help"
            className="justify-self-start text-sm font-medium text-link underline-offset-4 hover:underline"
          >
            How LAB stations work
          </Link>
        </div>

        {notice ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        {searching ? (
          <SomeoneElse
            onPick={(option) =>
              choose(fromReceiver(option, people.state === 'ready' ? people.staff : []))
            }
            onCancel={closeSearch}
          />
        ) : people.state === 'loading' ? (
          <p aria-busy="true" className="text-sm text-muted-foreground">
            Loading the station’s people…
          </p>
        ) : people.state === 'error' ? (
          <div className="flex flex-col gap-3">
            <Alert variant="destructive">
              <AlertDescription>
                The station’s people couldn’t load. Try again, or use Someone else… to find your
                name.
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={reloadPeople}>
                Try again
              </Button>
              <Button type="button" variant="outline" onClick={() => setSearching(true)}>
                <UserPlus aria-hidden="true" />
                Someone else…
              </Button>
            </div>
          </div>
        ) : people.people.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-5">
            <Users aria-hidden="true" className="size-5 text-muted-foreground" />
            <div className="grid gap-1">
              <p className="text-sm font-medium">No one is listed for this station yet.</p>
              <p className="text-sm text-muted-foreground">
                An administrator adds receiving-lab staff in Settings, Staff. Until then, find your
                name yourself.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => setSearching(true)}>
              <UserPlus aria-hidden="true" />
              Someone else…
            </Button>
          </div>
        ) : (
          <ul aria-label="Receiving lab staff" className="flex flex-col gap-1">
            {people.people.map((person) => (
              <PersonRow key={person.id} person={person} onPick={() => choose(person)} />
            ))}
            {someoneElseRow}
          </ul>
        )}

        <Separator />
        <p className="text-sm text-muted-foreground">
          Wrong station?{' '}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 font-medium"
            onClick={() => {
              clearRecordingPerson();
              void signOut();
            }}
          >
            Sign out of LAB
          </Button>
        </p>
      </section>
    </SignInLayout>
  );
}
