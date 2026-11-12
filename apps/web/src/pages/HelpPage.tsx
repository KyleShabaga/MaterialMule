import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_TEXT_MAX,
  feedbackListSchema,
  healthResponseSchema,
  type FeedbackItem,
  type FeedbackKind,
} from '@materialmule/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { apiFetch } from '../api/client';
import {
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  SectionHead,
  SidePanel,
} from '../components/app-ui';
import { FEATURES } from '../features';
import { formatExpiry } from '../lib/format';
import { useMe } from '../session/context';
import './help.css';

interface Guide {
  steps: number;
  title: string;
  line: string;
  to: string;
}

/**
 * Short guides for things the app really does, each opening the screen where the job starts.
 * The wording follows the real screens' labels (Confirm receipt, Submit program, Reprint label,
 * Correct details, Disposal scan).
 */
function guides(): Guide[] {
  const list: (Guide | false)[] = [
    {
      steps: 3,
      title: 'Receive a delivery',
      line: 'Choose the project, add each storage unit with its samples per test hole, then Confirm receipt to issue the IDs.',
      to: '/receiving-log/new',
    },
    {
      steps: 2,
      title: 'Move a unit',
      line: 'Scan the shelf or location label first, then scan each unit that goes there.',
      to: '/sample-storage/move',
    },
    FEATURES.labTesting && {
      steps: 3,
      title: 'Ask the lab for tests',
      line: 'Choose the project, list the samples and tests for each unit, then Submit program.',
      to: '/lab-testing/programs/new',
    },
    {
      steps: 2,
      title: 'Reprint a label',
      line: 'Open the unit from Inventory, then choose Reprint label in its Labels section.',
      to: '/sample-storage',
    },
    FEATURES.disposalRetention && {
      steps: 3,
      title: 'Dispose of units',
      line: 'Approve the units that are due for disposal, then scan each one out on Disposal scan.',
      to: '/disposal-retention',
    },
    {
      steps: 2,
      title: 'Fix a mistake on a unit',
      line: 'Open the unit and choose Correct details, with a reason. The ID stays the same.',
      to: '/sample-storage',
    },
  ];
  return list.filter((guide): guide is Guide => guide !== false);
}

const FACTS: { q: string; a: string }[] = [
  {
    q: 'Why does a draft have no ID?',
    a: 'IDs are issued when the delivery is confirmed, so a number is never used for something that did not arrive.',
  },
  {
    q: 'Can an ID be changed or reused?',
    a: 'No. A correction changes the details and keeps the ID.',
  },
  {
    q: 'Where do individual samples go?',
    a: 'Only in a lab program. Receiving records one summary per test hole.',
  },
  {
    q: 'Does this work from home?',
    a: 'No. It runs on the office network only.',
  },
];

/** The in-app page the person came from, when the link that opened Help passed it. */
function fromPath(state: unknown): string | null {
  if (!state || typeof state !== 'object' || !('from' in state)) return null;
  const from = (state as { from: unknown }).from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return null;
  // Path only: a query string can hold searches and IDs, so it is never sent.
  const path = from.split(/[?#]/)[0]!;
  return path === '/help' ? null : path.slice(0, 200);
}

type Sent = { state: 'idle' } | { state: 'sending' } | { state: 'sent' } | { state: 'error' };

function FeedbackForm({ from }: { from: string | null }) {
  const [kind, setKind] = useState<FeedbackKind>('not_working');
  const [text, setText] = useState('');
  const [includePage, setIncludePage] = useState(true);
  const [missing, setMissing] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: 'idle' });
  const kindId = useId();
  const textId = useId();
  const pageId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) {
      setMissing(true);
      document.getElementById(textId)?.focus();
      return;
    }
    setMissing(false);
    setSent({ state: 'sending' });
    try {
      const response = await apiFetch('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          text,
          ...(from && includePage ? { page: from } : {}),
        }),
      });
      if (!response.ok) {
        setSent({ state: 'error' });
        return;
      }
      setText('');
      setSent({ state: 'sent' });
    } catch {
      setSent({ state: 'error' });
    }
  }

  return (
    <SidePanel title="Tell us something" className="help-feedback">
      <form className="help-form" onSubmit={(event) => void submit(event)} noValidate>
        {sent.state === 'sent' ? (
          <Notice tone="success">Sent. An administrator will read it here in the office.</Notice>
        ) : null}
        {sent.state === 'error' ? (
          <ErrorState
            tag="Not sent"
            message="Your message couldn't be sent."
            detail="It is still in the box below. Check the connection and send it again."
          />
        ) : null}
        <div className="form-field">
          <label htmlFor={kindId}>What kind</label>
          <select
            id={kindId}
            value={kind}
            onChange={(event) => setKind(event.target.value as FeedbackKind)}
          >
            {FEEDBACK_KINDS.map((value) => (
              <option key={value} value={value}>
                {FEEDBACK_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={textId}>What happened</label>
          <textarea
            id={textId}
            rows={5}
            maxLength={FEEDBACK_TEXT_MAX}
            required
            aria-invalid={missing}
            aria-describedby={missing ? `${textId}-error` : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (sent.state !== 'idle' && sent.state !== 'sending') setSent({ state: 'idle' });
            }}
          />
          {missing ? (
            <p id={`${textId}-error`} className="field-error">
              Say what happened.
            </p>
          ) : null}
        </div>
        {from ? (
          <div className="help-check">
            <input
              id={pageId}
              type="checkbox"
              checked={includePage}
              onChange={(event) => setIncludePage(event.target.checked)}
            />
            <label htmlFor={pageId}>
              <span className="help-check-title">Include the page I was on</span>
              <span className="help-check-path mono">{from}</span>
            </label>
          </div>
        ) : null}
        <button type="submit" className="primary" disabled={sent.state === 'sending'}>
          {sent.state === 'sending' ? 'Sending…' : 'Send to the administrator'}
        </button>
        <p className="help-note">Stays inside the office. Nothing is sent outside the building.</p>
      </form>
    </SidePanel>
  );
}

function useVersion(): string | null {
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

type Received =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: FeedbackItem[] };

/** Administrators: the latest feedback, newest first (kept on the host as audit events). */
function FeedbackReceived() {
  const [received, setReceived] = useState<Received>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void apiFetch('/api/feedback')
      .then(async (response) => {
        if (!response.ok) throw new Error('not ok');
        return feedbackListSchema.parse(await response.json());
      })
      .then(
        (items) => active && setReceived({ state: 'ready', items }),
        () => active && setReceived({ state: 'error' }),
      );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <section className="help-received" aria-labelledby="help-received">
      <SectionHead
        id="help-received"
        title="Feedback received"
        meta={received.state === 'ready' ? `LATEST ${received.items.length}` : undefined}
      />
      {received.state === 'loading' ? (
        <p aria-busy="true">Loading feedback…</p>
      ) : received.state === 'error' ? (
        <ErrorState
          message="Feedback couldn't load."
          detail="Nothing was changed."
          onRetry={() => {
            setReceived({ state: 'loading' });
            setAttempt((a) => a + 1);
          }}
        />
      ) : received.items.length === 0 ? (
        <EmptyState title="No feedback yet.">
          Messages people send from this page appear here.
        </EmptyState>
      ) : (
        <ul className="help-received-list">
          {received.items.map((item) => (
            <li key={item.id} data-row="">
              <div className="help-received-meta">
                <time className="mono" dateTime={item.submittedAt}>
                  {formatExpiry(item.submittedAt)}
                </time>
                <span>{item.name ?? 'Someone'}</span>
                <span className="help-received-kind">{FEEDBACK_KIND_LABELS[item.kind]}</span>
                {item.page ? <span className="mono">{item.page}</span> : null}
              </div>
              <p className="help-received-text">{item.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Help & Feedback (Field Ledger "Help"): short guides that open the real screens, standing
 * answers, and a feedback form whose messages stay on the host (no email, no outside service).
 */
export function HelpPage() {
  const me = useMe();
  const location = useLocation();
  const from = fromPath(location.state);
  const version = useVersion();
  const list = guides();
  const isAdmin = me.permissions.includes('staff.manage');

  return (
    <div className="help-page">
      <div className="help-title">
        <PageHeader title="Help & Feedback" />
        <p className="help-subtitle">
          How to do the common jobs, and where to say something is wrong
        </p>
      </div>
      <div className="help-layout">
        <div className="help-main">
          <section aria-labelledby="help-guides">
            <SectionHead id="help-guides" title="How do I…" meta={`${list.length} SHORT GUIDES`} />
            <ul className="help-guides">
              {list.map((guide) => (
                <li key={guide.title}>
                  <Link className="help-guide" to={guide.to}>
                    <span className="help-guide-steps">{guide.steps} steps</span>
                    <span className="help-guide-title">{guide.title}</span>
                    <span className="help-guide-line">{guide.line}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="help-facts">
            <SectionHead id="help-facts" title="Good to know" />
            <dl className="help-facts">
              {FACTS.map((fact) => (
                <div key={fact.q}>
                  <dt>{fact.q}</dt>
                  <dd>{fact.a}</dd>
                </div>
              ))}
            </dl>
          </section>
          {isAdmin ? <FeedbackReceived /> : null}
        </div>
        <aside className="help-aside" aria-label="Feedback and contacts">
          <FeedbackForm from={from} />
          <SidePanel title="Who to ask">
            <dl className="help-contacts">
              <div>
                <dt>Access and accounts</dt>
                <dd>An administrator, in Settings, Staff and access</dd>
              </div>
              <div>
                <dt>Shelves, labels, retention</dt>
                <dd>A Lab Manager</dd>
              </div>
              {version ? (
                <div>
                  <dt>Version</dt>
                  <dd className="mono">{version}</dd>
                </div>
              ) : null}
            </dl>
          </SidePanel>
        </aside>
      </div>
    </div>
  );
}
