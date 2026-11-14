import {
  CONCRETE_EXCEPTION_LABEL,
  concreteReportFileUrl,
  type ConcreteProjectSettings,
  type ProjectReportIssuers,
} from '@materialmule/shared';
import { Eye, FileCheck, FilePenLine, Send } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { notifySuccess } from '../components/strata/toast';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import { fetchConcreteSettings, fetchReportIssuers, problemText, sendCommand } from './api';
import { PanelSection, ReportLoading, ReportPaper, ReportSplit } from './ReportLayout';
import { ReportPreview } from './ReportPreview';
import {
  CommentDialog,
  FieldReportHeader,
  Labelled,
  PANEL_DL,
  ReportError,
  ReportUnavailable,
  StaleAlert,
} from './ReviewReportPage';
import { issueBlock, whoCanIssue } from './rules';
import { useReviewData } from './useReviewData';
import './review.css';

// MM-V2-C28 / STRATA-96 (boards R8Issue*, R8Issued): the report page's Issue step. The exact
// version that will be issued (paper) beside the Issue panel: "Before it goes out" (the issue
// options, each with the project default), the documented exceptions and the version itself;
// Issue report asks once more (it can't be undone) and keeps that version (C09). The CF number is
// allocated inside the issue transaction, never by this preview, so until then the paper says
// "CF number at issue". An issued report shows "As issued" and its stored file (C32), never
// re-rendered; a revision starts a new draft and never changes the issued version.

const included = (value: boolean | null) =>
  value === null ? 'Not recorded' : value ? 'Included' : 'Omitted';

export function IssueReportPage() {
  const { reportId = '' } = useParams();
  const { load, reload } = useReviewData(reportId, null);
  const me = useMe();
  const machineId = useId();
  const blockId = useId();
  // Review fix #144: React Router reuses this page for another report, so the settings are kept
  // with the project they belong to and a manual choice with the report it was made on.
  const [loadedSettings, setLoadedSettings] = useState<{
    projectId: string;
    settings: ConcreteProjectSettings | null;
  } | null>(null);
  const [issuers, setIssuers] = useState<ProjectReportIssuers | null>(null);
  const [override, setOverride] = useState<{ reportId: string; include: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (load.state === 'loading') return <ReportLoading />;
  if (load.state === 'error') return <ReportError status={load.status} onRetry={reload} />;
  if (load.state === 'empty') {
    return (
      <ReportUnavailable
        detail={load.detail}
        title="This report hasn’t been submitted for review yet."
        text="It can be issued once it has been submitted and reviewed."
      />
    );
  }

  const { data } = load;
  const { detail, version, checklist, isLatest } = data;
  const issuedVersion = version.issued;
  const documented = checklist.filter((i) => i.status !== 'open');
  // Review fix #139: only the report's latest version, as shown, can be issued.
  const block = isLatest
    ? issueBlock({ me, detail, issuers })
    : 'Reload to issue the latest version first.';
  const review = version.review;
  const date = detail.fields.reportDate;
  const machineWords =
    machine === null ? 'As the project setting says' : machine ? 'Included' : 'Omitted';
  const canRevise = detail.lifecycle.allowedActions.includes('revise');

  const issue = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
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
      notifySuccess(`Version ${version.versionNo} issued.`);
      reload();
    } catch (failure) {
      setError(problemText(failure));
      if ((failure as { code?: string }).code === 'version_conflict') reload();
    } finally {
      setBusy(false);
    }
  };

  const panel = issuedVersion ? (
    <>
      <PanelSection id="issue-as-issued" title="As issued">
        <dl className={PANEL_DL}>
          <Labelled label="Number">
            {issuedVersion.reportNumber ? (
              <>
                <span className="font-mono">{issuedVersion.reportNumber}</span>
                {issuedVersion.file ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · Rev {issuedVersion.file.revisionNo}
                  </span>
                ) : null}
              </>
            ) : (
              'Not recorded'
            )}
          </Labelled>
          <Labelled label="Issued">
            {issuedVersion.by.name} · {shortDateTime(issuedVersion.at)}
          </Labelled>
          <Labelled label="Version">
            {version.versionNo}
            {review ? ` (reviewed by ${review.reviewedBy.name})` : ''}
          </Labelled>
          <Labelled label="Photos">{included(issuedVersion.includePhotos)}</Labelled>
          <Labelled label="Machine info">{included(issuedVersion.includeMachineInfo)}</Labelled>
        </dl>
        {issuedVersion.file ? (
          <div className="flex flex-col gap-1">
            {/* MM-V2-C32: the stored file, exactly as issued (never re-rendered). */}
            <div>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={concreteReportFileUrl(issuedVersion.file.id)}
                  target="_blank"
                  rel="noopener"
                >
                  Open issued PDF (Rev {issuedVersion.file.revisionNo})
                </a>
              </Button>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {issuedVersion.file.template.name} {issuedVersion.file.template.revision}
              {issuedVersion.file.template.provisional ? ' (provisional)' : ''} · SHA-256{' '}
              {issuedVersion.file.sha256.slice(0, 12)}
            </p>
          </div>
        ) : null}
      </PanelSection>
      <PanelSection id="issue-revise" title="Correct it after issue">
        <p className="text-sm text-muted-foreground">
          A correction starts a revision: the report becomes a draft again and is issued again as a
          new revision. This issued version never changes.
        </p>
        {canRevise ? (
          <div>
            <Button variant="outline" size="sm" onClick={() => setRevising(true)}>
              <FilePenLine aria-hidden="true" />
              Start a revision
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          The lead, a designated reviewer or the person who issued it can start one, with a reason.
        </p>
      </PanelSection>
    </>
  ) : (
    <>
      <PanelSection id="issue-options" title="Before it goes out">
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium">Include photos</p>
            <p id="photos-why" className="text-muted-foreground">
              Not available yet: no photos are recorded for concrete reports yet (they arrive with
              attachments, C15).
            </p>
          </div>
          <Switch
            checked={false}
            disabled
            aria-label="Include photos"
            aria-describedby="photos-why"
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium" id={machineId}>
            Testing machine information
          </legend>
          <p className="text-sm text-muted-foreground">
            {settings === null
              ? 'The project’s setting couldn’t be read: issuing uses it (omitted when unset) unless you choose.'
              : settings.includeMachineInfo === null
                ? 'The project hasn’t set a default, so it’s omitted unless you choose Include.'
                : `Project setting: ${settings.includeMachineInfo ? 'include' : 'omit'}.`}
          </p>
          <RadioGroup
            aria-labelledby={machineId}
            value={machine === null ? '' : machine ? 'include' : 'omit'}
            onValueChange={(v) => setMachine(v === 'include')}
            className="flex gap-4"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="include" id={`${machineId}-include`} />
              <Label htmlFor={`${machineId}-include`}>Include</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="omit" id={`${machineId}-omit`} />
              <Label htmlFor={`${machineId}-omit`}>Omit</Label>
            </div>
          </RadioGroup>
        </fieldset>
      </PanelSection>
      <PanelSection
        id="issue-exceptions"
        title="Documented exceptions"
        count={documented.length || undefined}
      >
        {checklist.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None: the version was submitted without exceptions.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {documented.map((item) => (
              <li key={item.key} className="text-sm">
                <p className="font-medium">
                  {CONCRETE_EXCEPTION_LABEL[item.code]}{' '}
                  <span className="font-normal text-muted-foreground">
                    ({item.status === 'resolved' ? 'resolved' : 'documented'})
                  </span>
                </p>
                {item.note ? (
                  <p className="text-muted-foreground">
                    “{item.note.note}” — {item.note.documentedBy.name},{' '}
                    {shortDateTime(item.note.documentedAt)}
                  </p>
                ) : (
                  <p className="text-muted-foreground">Resolved before review.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <PanelSection id="issue-version" title="The version that will be issued">
        <dl className={PANEL_DL}>
          <Labelled label="Version">
            v{version.versionNo}
            {version.revisionOfVersionNo ? ` (revision of v${version.revisionOfVersionNo})` : ''}
            {' · submitted '}
            {shortDateTime(version.submittedAt)} by {version.submittedStaff.name}
          </Labelled>
          <Labelled label="Reviewed">
            {review ? `${review.reviewedBy.name} · ${shortDateTime(review.reviewedAt)}` : '—'}
          </Labelled>
          <Labelled label="Snapshot">
            <span className="font-mono">Snapshot {version.snapshotSha256.slice(0, 12)}</span>
          </Labelled>
          <Labelled label="Template">Field report P1 (provisional)</Labelled>
          <Labelled label="Number">The next CF number, given when you issue</Labelled>
        </dl>
        <p className="text-sm text-muted-foreground">
          Who can issue it: {whoCanIssue(detail, issuers)}. Never the report’s technician; personal
          accounts only.
        </p>
      </PanelSection>
    </>
  );

  const footer = issuedVersion ? null : (
    <>
      {error ? <FieldError>{error}</FieldError> : null}
      {block ? (
        <p id={blockId} className="text-sm text-muted-foreground">
          {block}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" asChild>
          <Link to={`/concrete/review/${detail.id}`}>Back to review</Link>
        </Button>
        <Button
          disabled={block !== null || busy}
          aria-describedby={block ? blockId : undefined}
          onClick={() => setConfirming(true)}
        >
          <Send aria-hidden="true" />
          Issue report
        </Button>
      </div>
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FieldReportHeader detail={detail} versionNo={version.versionNo} on="issue" />
      <ReportSplit
        panelLabel="Issue panel"
        alert={<StaleAlert data={data} explicit={false} onLatest={reload} />}
        paper={
          <ReportPaper
            icon={issuedVersion ? FileCheck : Eye}
            label={
              issuedVersion
                ? 'As issued. The stored file is the record; it never changes.'
                : 'The version that will be issued. Review preview, not the issued file · template P1 is provisional (report templates are an open item).'
            }
          >
            <ReportPreview
              snapshot={version.snapshot}
              changes={[]}
              versionNo={version.versionNo}
              reportNumber={issuedVersion?.reportNumber ?? null}
              issuedAt={issuedVersion?.at ?? null}
            />
          </ReportPaper>
        }
        panel={panel}
        footer={footer}
      />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {date ? `Issue the ${date} field report?` : 'Issue this field report?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Version {version.versionNo} is frozen as issued and gets the next CF number, with
              testing machine information{' '}
              {machine === null
                ? 'as the project setting says (omitted when unset)'
                : machine
                  ? 'included'
                  : 'omitted'}{' '}
              and no photos. This can’t be undone: a later correction starts a revision and leaves
              this version as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className={PANEL_DL}>
            <Labelled label="Project">
              <span className="font-mono">{detail.projectNumber}</span>
            </Labelled>
            <Labelled label="Photos">Not included</Labelled>
            <Labelled label="Machine info">{machineWords}</Labelled>
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void issue();
              }}
            >
              <Send aria-hidden="true" />
              Issue report
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CommentDialog
        open={revising}
        title="Start a revision"
        label="Reason for the revision"
        hint="The issued version stays as issued. The report reopens for the technician to correct."
        confirmLabel="Start revision"
        busy={busy}
        error={error}
        onCancel={() => setRevising(false)}
        onConfirm={async (comment) => {
          setBusy(true);
          setError(null);
          try {
            await sendCommand(detail.id, 'revise', {
              version: detail.version,
              reportVersionNo: version.versionNo,
              idempotencyKey: crypto.randomUUID(),
              comment,
            });
            setRevising(false);
            notifySuccess('Revision started. The report is a draft again.');
            reload();
          } catch (failure) {
            setError(problemText(failure));
            if ((failure as { code?: string }).code === 'version_conflict') reload();
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
