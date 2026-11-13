import { useCallback, useContext, useEffect, useState } from 'react';
import { SessionContext } from '../../session/context';
import {
  PERSON_SCOPED_PREFIX,
  useOptionalRecordingPerson,
} from '../../session/recording-person-store';

// STRATA-88: the Workboard's view (Board or List) is remembered per person in this browser, under
// the person-scoped prefix that signing off on a LAB station clears; the URL (`view=`) wins.

export const WORKBOARD_VIEWS = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
] as const;
export type WorkboardView = (typeof WORKBOARD_VIEWS)[number]['id'];

const KEY = `${PERSON_SCOPED_PREFIX}workboard-view.`;

function read(person: string | null): WorkboardView | null {
  if (!person) return null;
  try {
    const value = window.localStorage.getItem(KEY + person);
    return value === 'board' || value === 'list' ? value : null;
  } catch {
    return null;
  }
}

/** The person whose choice this is: the station's picked person, else the signed-in account. */
function usePersonId(): string | null {
  const session = useContext(SessionContext)?.session;
  const station = useOptionalRecordingPerson();
  if (station?.isStation) return station.person?.id ?? null;
  return session?.status === 'active' ? session.me.id : null;
}

/**
 * The view to show: the URL's `view=`, else this person's remembered choice, else Board. With no
 * `view=` and a remembered List, the URL is brought in line (replacing the entry) so a copied link
 * shows what the person sees. `remember` stores a choice for this person.
 */
export function useWorkboardView(
  urlView: string | null,
  replaceUrlView: (view: WorkboardView) => void,
): [WorkboardView, (view: WorkboardView) => void] {
  const person = usePersonId();
  const [stored, setStored] = useState(() => ({ person, view: read(person) }));
  const remembered = stored.person === person ? stored.view : read(person);
  if (stored.person !== person) setStored({ person, view: remembered });

  const fromUrl = urlView === 'list' || urlView === 'board' ? urlView : null;
  const view: WorkboardView = fromUrl ?? remembered ?? 'board';

  useEffect(() => {
    if (!fromUrl && remembered === 'list') replaceUrlView('list');
  }, [fromUrl, remembered, replaceUrlView]);

  const remember = useCallback(
    (next: WorkboardView) => {
      setStored({ person, view: next });
      if (!person) return;
      try {
        window.localStorage.setItem(KEY + person, next);
      } catch {
        // Storage blocked (private window, policy): the choice lasts for this page only.
      }
    },
    [person],
  );
  return [view, remember];
}
