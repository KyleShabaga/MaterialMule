import {
  concreteReviewChecklist,
  diffConcreteReportSnapshots,
  type ConcreteChecklistItem,
  type ConcreteExceptionNote,
  type ConcreteFieldReportDetail,
  type ConcreteReportVersionDetail,
  type ConcreteReportVersionList,
  type ConcreteReportVersionSummary,
  type ConcreteSnapshotChange,
} from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { fetchExceptionNotes, fetchReport, fetchVersion, fetchVersions } from './api';

// MM-V2-C28: everything the review and issue screens show for one report and one of its versions,
// read together so they never mix two moments.

export interface ReviewData {
  detail: ConcreteFieldReportDetail;
  versions: ConcreteReportVersionList;
  version: ConcreteReportVersionDetail;
  previous: ConcreteReportVersionDetail | null;
  notes: ConcreteExceptionNote[];
  changes: ConcreteSnapshotChange[];
  checklist: ConcreteChecklistItem[];
  isLatest: boolean;
}

export type ReviewLoad =
  | { state: 'loading' }
  | { state: 'error'; status: number | null }
  | { state: 'empty'; detail: ConcreteFieldReportDetail }
  | { state: 'ready'; data: ReviewData };

/** Reads of the detail and the version list retried when they disagree (review fix #139). */
const AGREEMENT_ATTEMPTS = 3;

export async function loadReviewData(
  reportId: string,
  versionNo: number | null,
): Promise<ReviewLoad> {
  let [detail, versions] = await Promise.all([fetchReport(reportId), fetchVersions(reportId)]);
  // Review fix #139: the two reads run in parallel, so a (re)submission between them can leave
  // the list a version behind the detail. Read again until they name the same latest version.
  for (let attempt = 1; attempt < AGREEMENT_ATTEMPTS; attempt += 1) {
    if (sameVersion(detail.lifecycle.latestVersion, versions.versions.at(-1) ?? null)) break;
    [detail, versions] = await Promise.all([fetchReport(reportId), fetchVersions(reportId)]);
  }
  const latest = versions.versions.at(-1);
  if (!latest) return { state: 'empty', detail };
  const chosen =
    versionNo !== null && versions.versions.some((v) => v.versionNo === versionNo)
      ? versionNo
      : latest.versionNo;
  const [version, previous, notes] = await Promise.all([
    fetchVersion(reportId, chosen),
    chosen > 1 ? fetchVersion(reportId, chosen - 1) : Promise.resolve(null),
    fetchExceptionNotes(reportId, chosen),
  ]);
  // Actions act on the report's latest version (the detail's), so they are offered only while
  // the version shown is exactly that one, in the same state.
  const isLatest = sameVersion(detail.lifecycle.latestVersion, version);
  const submitted = (version.snapshot.warnings ?? []) as Parameters<
    typeof concreteReviewChecklist
  >[0]['submitted'];
  const checklist = concreteReviewChecklist({
    submitted,
    // Live rechecks count only while this version is the one awaiting review.
    live: isLatest && version.state === 'submitted' ? detail.review.warnings : null,
    notes: notes.notes,
  });
  return {
    state: 'ready',
    data: {
      detail,
      versions,
      version,
      previous,
      notes: notes.notes,
      changes: diffConcreteReportSnapshots(previous?.snapshot ?? null, version.snapshot),
      checklist,
      isLatest,
    },
  };
}

function sameVersion(
  a: Pick<ConcreteReportVersionSummary, 'id' | 'state'> | null,
  b: Pick<ConcreteReportVersionSummary, 'id' | 'state'> | null,
): boolean {
  return a !== null && b !== null && a.id === b.id && a.state === b.state;
}

export function useReviewData(reportId: string, versionNo: number | null) {
  // Each answer is kept with the report and version it answers: another report or version reads
  // as loading until its own answer arrives, while a reload keeps showing the current one.
  const key = `${reportId}|${versionNo ?? ''}`;
  const [answer, setAnswer] = useState<{ key: string; load: ReviewLoad }>({
    key: '',
    load: { state: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    loadReviewData(reportId, versionNo).then(
      (next) => current && setAnswer({ key, load: next }),
      (error: unknown) =>
        current &&
        setAnswer({
          key,
          load: { state: 'error', status: (error as { status?: number }).status ?? null },
        }),
    );
    return () => {
      current = false;
    };
  }, [reportId, versionNo, attempt, key]);
  const load: ReviewLoad = answer.key === key ? answer.load : { state: 'loading' };
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, reload };
}
