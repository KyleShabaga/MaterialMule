import {
  CONCRETE_EXCEPTION_LABEL,
  type ConcreteProjectSettings,
  type ProjectReportIssuers,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { BandedCard, ConfirmDialog, ErrorState, PageHeader } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import { fetchConcreteSettings, fetchReportIssuers, problemText, sendCommand } from './api';
import { ReportPreview } from './ReportPreview';
import { ActionButton, Labelled, StateBadge } from './ReviewReportPage';
import { issueBlock, whoCanIssue } from './rules';
import { useReviewData } from './useReviewData';
import './review.css';

// MM-V2-C28: the issue view (Combined Plan "Issuance workflow"): the exact version, its reviewer
// and date, the documented exceptions and the issuer's options; Issue report keeps that version
// and records the issuer and time (C09). The final layout is C32's: this preview is interim.

export function IssueReportPage() {
  const { reportId = '' } = useParams();
  const { load, reload } = useReviewData(reportId, null);
  const me = useMe();
  const [settings, setSettings] = useState<ConcreteProjectSettings | null>(null);
  const [issuers, setIssuers] = useState<ProjectReportIssuers | null>(null);
  const [machine, setMachine] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const projectId = load.state === 'ready' ? load.data.detail.projectId : null;
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    fetchConcreteSettings(projectId).then(
      (s) => {
        if (!current) return;
        setSettings(s);
        // MM-V2-C38: the project's setting is the starting choice; unset starts as Omit. The
        // issuer may change it either way, but is never forced to choose.
        setMachine((m) => m ?? s.includeMachineInfo ?? false);
      },
      () => current && setSettings(null),
    );
    fetchReportIssuers(projectId).then(
      (i) => current && setIssuers(i),
      () => current && setIssuers(null),
    );
    return () => {
      current = false;
    };
  }, [projectId]);

  if (load.state === 'loading') return <p aria-busy="true">Loading the report…</p>;
  if (load.state === 'error' || load.state === 'empty') {
    return (
      <>
        <PageHeader title="Issue report" />
        <ErrorState
          message={
            load.state === 'empty'
              ? 'This report hasn’t been submitted for review yet.'
              : 'The report couldn’t be loaded.'
          }
          onRetry={load.state === 'error' ? reload : undefined}
        />
      </>
    );
  }

  const { detail, version, checklist } = load.data;
  const issuedVersion = version.issued;
  const documented = checklist.filter((i) => i.status !== 'open');
  const block = issueBlock({ me, detail, issuers });
  const review = version.review;

  return (
    <div className="review-page">
      <PageHeader
        title={`Issue field report · ${detail.projectNumber}`}
        actions={<Link to={`/concrete/review/${detail.id}`}>Back to the review</Link>}
      />
      <div className="review-summary">
        <StateBadge state={detail.lifecycle.state} />
      </div>
      {message ? (
        <p
          className={
            message.tone === 'ok' ? 'review-message' : 'review-message review-message-error'
          }
          role={message.tone === 'ok' ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      ) : null}

      <div className="review-layout">
        <ReportPreview snapshot={version.snapshot} changes={[]} versionNo={version.versionNo} />
        <aside className="review-side" aria-label="Issue">
          <BandedCard title={issuedVersion ? 'Issued' : 'What will be issued'}>
            <dl className="review-fields">
              <Labelled label="Version">
                v{version.versionNo}
                {version.revisionOfVersionNo
                  ? ` (revision of v${version.revisionOfVersionNo})`
                  : ''}
                <br />
                <span className="mono review-muted">
                  Snapshot {version.snapshotSha256.slice(0, 12)}
                </span>
              </Labelled>
              <Labelled label="Submitted">
                {version.submittedStaff.name}, {shortDateTime(version.submittedAt)}
              </Labelled>
              <Labelled label="Reviewed">
                {review ? `${review.reviewedBy.name}, ${shortDateTime(review.reviewedAt)}` : '—'}
              </Labelled>
              {issuedVersion ? (
                <Labelled label="Issued">
                  {issuedVersion.by.name}, {shortDateTime(issuedVersion.at)}
                </Labelled>
              ) : null}
            </dl>
          </BandedCard>

          <BandedCard title="Documented exceptions">
            {checklist.length === 0 ? (
              <p>None: the version was submitted without exceptions.</p>
            ) : (
              <ul className="review-checklist">
                {documented.map((item) => (
                  <li key={item.key} className="review-check-item">
                    <strong>{CONCRETE_EXCEPTION_LABEL[item.code]}</strong>
                    <ul className="review-messages">
                      {item.messages.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                    {item.note ? (
                      <p className="review-note">
                        “{item.note.note}” — {item.note.documentedBy.name},{' '}
                        {shortDateTime(item.note.documentedAt)}
                      </p>
                    ) : (
                      <p className="review-muted">Resolved before review.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </BandedCard>

          <BandedCard title="Options">
            {issuedVersion ? (
              <dl className="review-fields">
                <Labelled label="Photos">
                  {issuedVersion.includePhotos === null
                    ? 'Not recorded'
                    : issuedVersion.includePhotos
                      ? 'Included'
                      : 'Omitted'}
                </Labelled>
                <Labelled label="Testing machine information">
                  {issuedVersion.includeMachineInfo === null
                    ? 'Not recorded'
                    : issuedVersion.includeMachineInfo
                      ? 'Included'
                      : 'Omitted'}
                </Labelled>
              </dl>
            ) : (
              <fieldset className="review-options">
                <legend className="visually-hidden">Issue options</legend>
                <label className="review-check review-option-disabled">
                  <input type="checkbox" checked={false} disabled aria-describedby="photos-why" />
                  Include photos
                </label>
                <p id="photos-why" className="review-action-reason">
                  Unavailable: no photos are recorded for concrete reports yet (they arrive with
                  attachments, C15).
                </p>
                <p className="review-option-label" id="machine-label">
                  Testing machine information (make, model, calibration dates)
                </p>
                <div role="radiogroup" aria-labelledby="machine-label" className="review-radios">
                  <label className="review-check">
                    <input
                      type="radio"
                      name="machine"
                      checked={machine === true}
                      onChange={() => setMachine(true)}
                    />
                    Include
                  </label>
                  <label className="review-check">
                    <input
                      type="radio"
                      name="machine"
                      checked={machine === false}
                      onChange={() => setMachine(false)}
                    />
                    Omit
                  </label>
                </div>
                <p className="field-hint">
                  {settings === null
                    ? 'The project’s setting couldn’t be read: issuing uses it (omitted when unset) unless you choose.'
                    : settings.includeMachineInfo === null
                      ? 'The project hasn’t set a default, so it’s omitted unless you choose Include.'
                      : `Project setting: ${settings.includeMachineInfo ? 'include' : 'omit'}.`}
                </p>
              </fieldset>
            )}
          </BandedCard>

          {!issuedVersion ? (
            <section className="review-actions" aria-label="Issue actions">
              <p className="review-who">
                Who can issue it: {whoCanIssue(detail, issuers)}. Never the report’s technician;
                personal accounts only.
              </p>
              <ActionButton
                label="Issue report"
                primary
                block={block}
                busy={busy}
                onClick={() => setConfirming(true)}
              />
            </section>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Issue this report?"
        confirmLabel="Issue report"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          setBusy(true);
          setMessage(null);
          try {
            await sendCommand(detail.id, 'issue', {
              version: detail.version,
              idempotencyKey: crypto.randomUUID(),
              includePhotos: false,
              // Left out when nothing is chosen yet: the server applies the project setting.
              ...(machine === null ? {} : { includeMachineInfo: machine }),
            });
            setMessage({ tone: 'ok', text: `Version ${version.versionNo} issued.` });
            reload();
          } catch (error) {
            setMessage({ tone: 'error', text: problemText(error) });
            if ((error as { code?: string }).code === 'version_conflict') reload();
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Version {version.versionNo} is issued exactly as shown, with testing machine information{' '}
          {machine === null
            ? 'as the project setting says (omitted when unset)'
            : machine
              ? 'included'
              : 'omitted'}{' '}
          and no photos. It can’t be changed afterwards; corrections make a linked revision.
        </p>
      </ConfirmDialog>
    </div>
  );
}
