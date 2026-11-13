import { healthResponseSchema } from '@materialmule/shared';
import { Building2, Keyboard } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SHORTCUTS_ANCHOR, groupAnchor, guideById, visibleGroups, type HelpGuide } from './guides';
import {
  CommonQuestions,
  GroupIcon,
  GuideAccordion,
  HelpSearchField,
  HelpSearchResults,
  ShortcutsList,
} from './help-content';

/** The app version from /api/health (public: no account needed). */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch('/api/health', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(async (response) => healthResponseSchema.safeParse(await response.json()))
      .then((body) => {
        if (active && body.success) setVersion(body.data.version);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return version;
}

/** The guide an anchor names: `#<guide>` directly; a group's or the shortcuts' anchor opens none. */
function guideForHash(hash: string): HelpGuide | undefined {
  const id = decodeURIComponent(hash.replace(/^#/, ''));
  return id ? guideById(id) : undefined;
}

/**
 * Help and how-tos (`/help`, STRATA-103): every guide group as a section with stable anchors
 * (`#<guide>`, `#group-<group>`, `#keyboard-shortcuts`), a search, Common questions and the app
 * version at the foot. The same view signed in (inside the shell) and signed out (the public
 * layout): it reads nothing private. `onAsk`/`feedback` are only given signed in.
 */
export function HelpGuidesView({
  notice,
  onAsk,
  footExtra,
  children,
}: {
  /** Above the heading (signed out: "You're not signed in…"). */
  notice?: ReactNode;
  /** Ask a question (opens Feedback & bugs); signed in only. */
  onAsk?: () => void;
  /** Extra items in the foot (signed in: Feedback & bugs). */
  footExtra?: ReactNode;
  /** After the guides (signed in administrators: Feedback received). */
  children?: ReactNode;
}) {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const version = useAppVersion();
  const groups = visibleGroups();
  const [query, setQuery] = useState('');
  const [openIds, setOpenIds] = useState<string[]>(() => {
    const target = guideForHash(hash);
    if (target) return [target.id];
    const first = groups[0]?.guides[0];
    return first ? [first.id] : [];
  });
  const ids = { faq: useId(), results: useId(), keys: useId() };
  const searching = query.trim().length > 0;

  // An anchor (from a link, the drawer's Open as full page or a search result) opens its guide
  // and scrolls to it.
  const [seenHash, setSeenHash] = useState(hash);
  if (hash !== seenHash) {
    setSeenHash(hash);
    const target = guideForHash(hash);
    if (target && !openIds.includes(target.id)) setOpenIds([...openIds, target.id]);
  }
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash]);

  const current = decodeURIComponent(hash.replace(/^#/, ''));
  const currentGroup = guideForHash(hash)?.group;

  return (
    <div className="@container flex flex-col gap-6">
      {notice}
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid min-w-0 flex-1 gap-1">
          <h1 className="text-2xl font-semibold">Help and how-tos</h1>
          <p className="text-sm text-muted-foreground">
            Short steps for each job in Material Mule, in the app’s own words.
          </p>
        </div>
        <HelpSearchField value={query} onChange={setQuery} className="w-full @min-[44rem]:w-80" />
      </div>

      {searching ? (
        <HelpSearchResults
          query={query}
          headingId={ids.results}
          onAsk={onAsk}
          onOpenGuide={(guide) => {
            setQuery('');
            void navigate({ hash: guide.id });
          }}
        />
      ) : (
        <div className="grid items-start gap-8 @min-[56rem]:grid-cols-[13rem_1fr]">
          <nav aria-label="Help topics" className="@min-[56rem]:sticky @min-[56rem]:top-20">
            <ul className="flex flex-wrap gap-1 text-sm @min-[56rem]:flex-col">
              {groups.map(({ group }) => {
                const here = current === groupAnchor(group.id) || currentGroup === group.id;
                return (
                  <li key={group.id}>
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'justify-start pointer-coarse:h-11 @min-[56rem]:w-full',
                        here && 'bg-accent font-medium text-accent-foreground',
                      )}
                    >
                      <Link
                        to={{ hash: groupAnchor(group.id) }}
                        aria-current={here ? 'location' : undefined}
                      >
                        <GroupIcon group={group} />
                        {group.label}
                      </Link>
                    </Button>
                  </li>
                );
              })}
              <li>
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'justify-start pointer-coarse:h-11 @min-[56rem]:w-full',
                    current === SHORTCUTS_ANCHOR && 'bg-accent font-medium text-accent-foreground',
                  )}
                >
                  <Link
                    to={{ hash: SHORTCUTS_ANCHOR }}
                    aria-current={current === SHORTCUTS_ANCHOR ? 'location' : undefined}
                  >
                    <Keyboard aria-hidden="true" />
                    Keyboard shortcuts
                  </Link>
                </Button>
              </li>
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-8">
            {groups.map(({ group, guides }) => {
              const headingId = `${groupAnchor(group.id)}-title`;
              const open = guides.filter((guide) => openIds.includes(guide.id)).map((g) => g.id);
              return (
                <section
                  key={group.id}
                  id={groupAnchor(group.id)}
                  aria-labelledby={headingId}
                  className="flex scroll-mt-20 flex-col gap-3"
                >
                  <h2 id={headingId} className="text-lg font-semibold">
                    {group.label}
                  </h2>
                  <GuideAccordion
                    guides={guides}
                    anchors
                    className="px-5"
                    value={open}
                    onValueChange={(next) =>
                      setOpenIds((all) => [
                        ...all.filter((id) => !guides.some((guide) => guide.id === id)),
                        ...next,
                      ])
                    }
                  />
                </section>
              );
            })}
            <section
              id={SHORTCUTS_ANCHOR}
              aria-labelledby={ids.keys}
              className="flex scroll-mt-20 flex-col gap-3"
            >
              <h2 id={ids.keys} className="text-lg font-semibold">
                Keyboard shortcuts
              </h2>
              <ShortcutsList idPrefix={ids.keys} />
            </section>
            <CommonQuestions headingId={ids.faq} />
            {children}
          </div>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-4 text-[13px] text-muted-foreground">
        <span>Material Mule{version ? <span className="font-mono"> {version}</span> : null}</span>
        <span className="flex items-center gap-1.5">
          <Building2 className="size-4" aria-hidden="true" />
          Runs on the office network only
        </span>
        {footExtra}
      </footer>
    </div>
  );
}
