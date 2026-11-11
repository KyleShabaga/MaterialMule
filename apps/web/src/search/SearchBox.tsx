import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { searchDestination } from './api';

const SEARCH_PLACEHOLDER = 'Search units, samples, projects, programs…';
const SEARCH_MAX_LENGTH = 100;

/**
 * Field Ledger top-bar search (docs/redesign/design.md, "Shell additions"): one field for units,
 * samples, projects and programs. Enter (or a handheld scanner's Enter) opens the unit straight
 * away when the text is exactly one storage unit's ID or label; anything else lands on /search
 * with grouped results. A text input with a search hint rather than a search box, so it never
 * competes with a page's own Search field.
 */
export function SearchBox({ inert }: { inert?: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const current = pathname === '/search' ? (params.get('q') ?? '') : '';
  const [text, setText] = useState(current);
  const [shownFor, setShownFor] = useState(current);
  const [busy, setBusy] = useState(false);
  // Follow the results page's query (Back, a link from Not found) without fighting typing.
  if (shownFor !== current) {
    setShownFor(current);
    setText(current);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const to = await searchDestination(q);
      if (to.startsWith('/sample-storage/')) setText('');
      void navigate(to);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="lab-search top-search"
      role="search"
      aria-label="Search"
      onSubmit={(event) => void submit(event)}
      inert={inert}
      aria-busy={busy || undefined}
    >
      <svg
        className="lab-search-icon"
        aria-hidden="true"
        focusable="false"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        type="text"
        aria-label="Search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={SEARCH_MAX_LENGTH}
        placeholder={SEARCH_PLACEHOLDER}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </form>
  );
}
