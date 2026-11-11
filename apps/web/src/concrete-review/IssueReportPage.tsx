import {
  CONCRETE_EXCEPTION_LABEL,
  concreteReportFileUrl,
  type ConcreteProjectSettings,
  type ProjectReportIssuers,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ConfirmDialog,
  ErrorState,
  Notice,
  PageHeader,
  SidePanel,
  StatusBadge,
} from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { ContextRow } from '../layout/ContextRow';
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
// Field Ledger (ConcreteIssue board): the interim preview on a paper sheet beside the issue checks
// (documented exceptions, options, who can issue); Issue report stays disabled while blocked.

export function IssueReportPage() {
  const { reportId = '' } = useParams();
  const { load, reload } = useReviewData(reportId, null);
  const me = useMe();
  // Review fix #144: React Router reuses this page for another report, so the settings are kept
  // with the project they belong to and a manual choice with the report it was made on.
  const [loadedSettings, setLoadedSettings] = useState<{
    projectId: string;
    settings: ConcreteProjectSettings | null;
  } | null>(null);
  const [issuers, setIssuers] = useState<ProjectReportIssuers | null>(null);
  const [override, setOverride] = useState<{ reportId: string; include: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const projectId = load.state === 'ready' ? load.data.detail.projectId : null;
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    fetchConcreteSettings(projectId).then(
      (s) => current && setLoadedSettings({ projectId, settings: s }),
      () => current && setLoadedSettings({ projectId, settings: null }),
    );
    fetchReportIssuers(projectId).then(
      (i) => current && setIssuers(i),
      () => current && setIssuers(null),
    );
    return () => {
      current = false;
    };
  }, [projectId]);

  const settings = loadedSettings?.projectId === projectId ? loadedSettings.settings : null;
  // MM-V2-C38: this project's setting is the starting choice; unset starts as Omit. The issuer
  // may change it either way, but is never forced to choose. Null: nothing to go on yet (the
  // server then applies the project setting).
  const machine: boolean | null =
    override?.reportId === reportId
      ? override.include
      : settings
        ? (settings.includeMachineInfo ?? false)
        : null;
  const setMachine = (include: boolean) => setOverride({ reportId, include });

  if (load.state === 'loading') return <p aria-busy="true">Loading the report…</p>;
  if (load.state === 'error' || load.state === 'empty') {
    return (
      <div className="crv-page">
        <ContextRow>
          <Link to={`/concrete/review/${reportId}`}>Back to the review</Link>
        </ContextRow>
        <PageHeader title="Issue report" />
        <ErrorState
          message={
            load.state === 'empty'
              ? 'This report hasn’t been submitted for review yet.'
              : 'The report couldn’t be loaded.'
          }
          onRetry={load.state === 'error' ? reload : undefined}
        />
      </div>
    );
  }

  const { detail, version, checklist, isLatest } = load.data;
  const issuedVersion = version.issued;
  const documented = checklist.filter((i) => i.status !== 'open');
  // Review fix #139: only the report's latest version, as shown, can be issued.
  const block = isLatest
    ? issueBlock({ me, detail, issuers })
    : 'The report changed while it loaded. Reload to see its latest version.';
  const review = version.review;

  return (
    <div className="crv-page">
      <ContextRow>
        <Link to={`/concrete/review/${detail.id}`}>Back to the review</Link>
        <StateBadge state={detail.lifecycle.state} />
      </ContextRow>
      <PageHeader title={`Issue field report · ${detail.projectNumber}`} />
      {message ? (
        <Notice tone={message.tone === 'ok' ? 'success' : 'danger'} className="crv-message">
          {message.text}
        </Notice>
      ) : null}

      <div className="crv-layout">
        <div className="crv-main">
          <p className="field-label crv-paper-label">
            {issuedVersion ? 'The version that was issued' : 'The version that will be issued'}
          </p>
          <div className="crv-paper">
            <ReportPreview snapshot={version.snapshot} changes={[]} versionNo={version.versionNo} />
          </div>
        </div>
        <aside className="crv-side" aria-label="Issue">
          <SidePanel title={issuedVersion ? 'Issued' : 'What will be issued'}>
            <dl className="crv-fields crv-fields-stack">
              <Labelled label="Version">
                v{version.versionNo}
                {version.revisionOfVersionNo
                  ? ` (revision of v${version.revisionOfVersionNo})`
                  : ''}
                <br />
                <span className="mono crv-muted">
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
              {issuedVersion?.reportNumber ? (
                <Labelled label="Report number">{issuedVersion.reportNumber}</Labelled>
              ) : null}
            </dl>
            {issuedVersion?.file ? (
              <p className="crv-issued-file">
                {/* MM-V2-C32: the stored file, exactly as issued (never re-rendered). */}
                <a
                  className="button"
                  href={concreteReportFileUrl(issuedVersion.file.id)}
                  target="_blank"
                  rel="noopener"
                >
                  Open issued PDF (Rev {issuedVersion.file.revisionNo})
                </a>
                <span className="mono crv-muted">
                  {issuedVersion.file.template.name} {issuedVersion.file.template.revision}
                  {issuedVersion.file.template.provisional ? ' (provisional)' : ''} · SHA-256{' '}
                  {issuedVersion.file.sha256.slice(0, 12)}
                </span>
              </p>
            ) : null}
          </SidePanel>

          <SidePanel title={issuedVersion ? 'As issued' : 'Before it goes out'}>
            <h3 className="crv-subhead">Documented exceptions</h3>
            {checklist.length === 0 ? (
              <p>None: the version was submitted without exceptions.</p>
            ) : (
              <ul className="crv-checks">
                {documented.map((item) => (
                  <li key={item.key} className="crv-check-row">
                    <StatusBadge tone="storage">
                      {item.status === 'resolved' ? 'Resolved' : 'Documented'}
                    </StatusBadge>
                    <div>
                      <strong>{CONCRETE_EXCEPTION_LABEL[item.code]}</strong>
                      <ul className="crv-messages">
                        {item.messages.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                      {item.note ? (
                        <p className="crv-note">
                          “{item.note.note}” — {item.note.documentedBy.name},{' '}
                          {shortDateTime(item.note.documentedAt)}
                        </p>
                      ) : (
                        <p className="crv-muted">Resolved before review.</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="crv-subhead">Options</h3>
            {issuedVersion ? (
              <dl className="crv-fields crv-fields-stack">
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
              <fieldset className="crv-options">
                <legend className="visually-hidden">Issue options</legend>
                <label className="crv-check crv-option-disabled">
                  <input type="checkbox" checked={false} disabled aria-describedby="photos-why" />
                  Include photos
                </label>
                <p id="photos-why" className="crv-reason">
                  Unavailable: no photos are recorded for concrete reports yet (they arrive with
                  attachments, C15).
                </p>
                <p className="field-label crv-option-label" id="machine-label">
                  Testing machine information (make, model, calibration dates)
                </p>
                <div role="radiogroup" aria-labelledby="machine-label" className="crv-radios">
                  <label className="crv-check">
                    <input
                      type="radio"
                      name="machine"
                      checked={machine === true}
                      onChange={() => setMachine(true)}
                    />
                    Include
                  </label>
                  <label className="crv-check">
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

            {!issuedVersion ? (
              <section className="crv-issue-actions" aria-label="Issue actions">
                <p className="crv-who">
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
          </SidePanel>
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
              // Review fix #139: the server refuses the issue if this isn't the latest version.
              reportVersionNo: version.versionNo,
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
