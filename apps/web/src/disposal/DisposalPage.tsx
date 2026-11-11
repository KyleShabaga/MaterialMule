import type {
  DisposalCandidate,
  DisposalCandidates,
  InventoryItem,
  ProjectSummary,
} from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  BandedCard,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  SectionHead,
  Segmented,
  SidePanel,
  StatusBadge,
} from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { PHONE_QUERY } from '../components/useTableView';
import { ContextRow } from '../layout/ContextRow';
import { formatExpiry } from '../lib/format';
import { businessToday, retentionBands, type BandKey } from '../retention/bands';
import { RetentionBand } from '../retention/RetentionBands';
import { useMe } from '../session/context';
import './disposal.css';
import { ProjectFilter } from '../inventory/ProjectFilter';
import { fetchProject } from '../inventory/api';
import { approveUnits, fetchCandidates, revokeApproval } from './api';
import { ReadyForDisposal } from './ReadyForDisposal';
import { ConcreteReadyForDisposal } from '../concrete/holds/ConcreteReadyForDisposal';
import '../concrete/holds/holds.css';

/**
 * Disposal & Retention (MM-T30): pick a project, see each current unit's standard eligibility
 * and reasons, approve eligible units (single or batch) or revoke an approval with a reason.
 * Approval never disposes: approved units are scanned out in Disposal scan mode. "Ready for
 * disposal" (MISC-13) lists what can go now in every project, before a project is chosen.
 */
export function DisposalPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? undefined;
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [data, setData] = useState<DisposalCandidates | null>(null);
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  // Review fix (#120): the route's project can change without the picker (the "Approve in
  // project" link, Back/Forward, a direct URL). Selections and the confirmation belong to the
  // project they were made in, so both are dropped whenever the route's project changes.
  const [selectionProject, setSelectionProject] = useState(projectId);
  if (selectionProject !== projectId) {
    setSelectionProject(projectId);
    setChosen([]);
    setConfirming(false);
  }
  // The picker label comes from the route's project identity, never from a previous pick.
  const selectedProject = project && project.id === projectId ? project : null;
  useEffect(() => {
    if (!projectId || selectedProject) return;
    let cancelled = false;
    void fetchProject(projectId).then((response) => {
      if (!cancelled && response.ok) setProject(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedProject]);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  // Field Ledger Retention: the three bands and the disposal list at the side. Approval is a
  // personal account's act (the server checks the project's Lead or a Lab Manager), never LAB.
  const me = useMe();
  const canList = me.accountType !== 'shared_lab';
  const [today] = useState(() => businessToday());
  const bands = retentionBands(today);
  const [listed, setListed] = useState<ReadonlyMap<string, InventoryItem>>(new Map());
  const [confirmingList, setConfirmingList] = useState(false);
  const [listKey, setListKey] = useState(() => crypto.randomUUID());
  const phone = useMediaQuery(PHONE_QUERY);
  const [phoneBand, setPhoneBand] = useState<BandKey>('overdue');
  const [bandTotals, setBandTotals] = useState<Partial<Record<BandKey, number>>>({});
  const [recordTotal] = useState(
    () =>
      Object.fromEntries(
        (['overdue', 'month', 'later'] as const).map((key) => [
          key,
          (total: number) => setBandTotals((current) => ({ ...current, [key]: total })),
        ]),
      ) as Record<BandKey, (total: number) => void>,
  );
  // MM-V2-C26 (owner decision 2026-11-08): concrete specimens join Ready for disposal behind a
  // type filter; storage units stay the default and behave as before.
  const [readyType, setReadyType] = useState<'storage_unit' | 'concrete_specimen'>(
    params.get('ready') === 'concrete' ? 'concrete_specimen' : 'storage_unit',
  );
  const typeFilter = (
    <div className="disposal-type-filter" role="group" aria-label="Show">
      {(
        [
          ['storage_unit', 'Storage units'],
          ['concrete_specimen', 'Concrete specimens'],
        ] as const
      ).map(([value, text]) => (
        <button
          key={value}
          type="button"
          aria-pressed={readyType === value}
          onClick={() => setReadyType(value)}
        >
          {text}
        </button>
      ))}
    </div>
  );

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void fetchCandidates(projectId, page).then((next) => {
      if (active) setData(next);
    });
    return () => {
      active = false;
    };
  }, [projectId, page, tick]);

  const reload = () => {
    setChosen([]);
    setTick((n) => n + 1);
  };
  // Only a result for the route's project is shown or approvable: while another project's load
  // is in flight, the previous project's units are hidden and nothing can be approved.
  const shown = projectId && data?.projectId === projectId ? data : null;
  const eligible = shown?.units.filter((u) => u.eligible) ?? [];
  const approved = shown?.units.filter((u) => u.approval) ?? [];
  const others = shown?.units.filter((u) => !u.eligible && !u.approval && !u.retentionExempt) ?? [];
  // Tested units aren't blocked by holds or dates: they leave through their own removal (MM-T71).
  const tested = shown?.units.filter((u) => !u.eligible && !u.approval && u.retentionExempt) ?? [];
  const selected = eligible.filter((u) => chosen.includes(u.storageUnitId));
  const totalPages = shown ? Math.max(1, Math.ceil(shown.total / shown.pageSize)) : 1;
  const turnPage = (next: number) => {
    if (!projectId) return;
    setChosen([]);
    setParams(next > 1 ? { projectId, page: String(next) } : { projectId });
  };

  async function approve() {
    setConfirming(false);
    if (selected.length === 0) return;
    const outcome = await approveUnits(
      selected.map((u) => u.storageUnitId),
      key,
    );
    setKey(crypto.randomUUID());
    setNotice(outcome.ok ? `${selected.length} approved for disposal.` : outcome.message);
    reload();
  }

  const listedItems = [...listed.values()];

  async function approveListed() {
    setConfirmingList(false);
    if (listedItems.length === 0) return;
    const outcome = await approveUnits(
      listedItems.map((item) => item.id),
      listKey,
    );
    setListKey(crypto.randomUUID());
    if (outcome.ok) {
      setNotice(`${listedItems.length} approved for disposal. Scan them out to dispose of them.`);
      setListed(new Map());
    } else {
      setNotice(outcome.message);
    }
    reload();
  }

  return (
    <div className="disposal-page">
      <ContextRow align="end">
        <Link className="button" to="/disposal-retention/scan">
          Disposal scan
        </Link>
      </ContextRow>
      <div className="retention-title">
        <PageHeader title="Retention" />
        <span className="section-meta">Keep, extend or dispose · as of {today}</span>
      </div>
      <p className="field-hint">
        Approving marks units for disposal; it doesn’t dispose them. Approved units are scanned out
        in Disposal scan mode, which checks holds and programs again at that moment. Tested Shelby
        tubes and bulk samples use “Confirm removal after testing” on their own page instead.
      </p>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="retention-layout">
        <div className="retention-bands">
          {phone ? (
            <Segmented
              label="Retention band"
              className="retention-phone-tabs"
              value={phoneBand}
              onChange={setPhoneBand}
              options={bands.map((band) => ({
                value: band.key,
                label: (
                  <>
                    <span className="retention-phone-tab-count">{bandTotals[band.key] ?? '…'}</span>
                    <span>{band.tag}</span>
                  </>
                ),
              }))}
            />
          ) : null}
          {bands.map((band) => (
            <RetentionBand
              key={band.key}
              band={band}
              hidden={phone && band.key !== phoneBand}
              onTotal={recordTotal[band.key]}
              refresh={tick}
              listed={new Set(listed.keys())}
              canList={canList}
              onToggle={(item) =>
                setListed((current) => {
                  const next = new Map(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.set(item.id, item);
                  return next;
                })
              }
            />
          ))}
          {phone ? (
            <Link className="button primary retention-scan-out" to="/disposal-retention/scan">
              Scan out for disposal
            </Link>
          ) : null}
        </div>
        {canList ? (
          <SidePanel
            className="disposal-list-panel"
            title="Disposal list"
            aside={
              <span className="section-meta">
                {listedItems.length} {listedItems.length === 1 ? 'unit' : 'units'}
              </span>
            }
          >
            {listedItems.length === 0 ? (
              <p className="field-hint">
                Add overdue units with “Add to disposal”, then approve them together.
              </p>
            ) : (
              <ul className="disposal-list-items" aria-label="Units on the disposal list">
                {listedItems.map((item) => (
                  <li key={item.id} data-row>
                    <span className="mono">{item.readableId}</span>
                    <span className="field-hint">{item.location.name}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="field-hint">
              Approval records who approved and when; the units are disposed of when they are
              scanned out. Disposed units keep their ID and full history. An ID is never reused.
            </p>
            {listedItems.length > 0 ? (
              <>
                <button type="button" className="primary" onClick={() => setConfirmingList(true)}>
                  Approve the {listedItems.length} listed for disposal
                </button>
                <button type="button" onClick={() => setListed(new Map())}>
                  Clear the list
                </button>
              </>
            ) : null}
          </SidePanel>
        ) : null}
      </div>

      <SectionHead title="Ready for disposal and approvals by project" />
      {readyType === 'storage_unit' ? (
        <ReadyForDisposal refresh={tick} filter={typeFilter} />
      ) : (
        <ConcreteReadyForDisposal filter={typeFilter} />
      )}
      <ProjectFilter
        selected={selectedProject}
        selectedId={projectId}
        onSelect={(next) => {
          setProject(next);
          setData(null);
          setChosen([]);
          setParams(next ? { projectId: next.id } : {});
        }}
      />
      {!projectId ? (
        <EmptyState>
          Choose a project to approve its units or see why others aren’t eligible.
        </EmptyState>
      ) : null}
      {projectId && !shown ? <p className="field-hint">Loading…</p> : null}
      {shown ? (
        <>
          <p className="field-hint" aria-label="Units shown">
            {shown.total === 0
              ? 'No current units in this project.'
              : `Units ${(shown.page - 1) * shown.pageSize + 1}–${
                  (shown.page - 1) * shown.pageSize + shown.units.length
                } of ${shown.total} current units, by storage unit ID.`}
          </p>
          <BandedCard
            title="Eligible for disposal"
            subtitle={`As of ${shown.asOf}: retain-until reached, no hold, every covering program closed.`}
          >
            {eligible.length === 0 ? (
              <EmptyState>No units are eligible.</EmptyState>
            ) : (
              <ul className="disposal-list">
                {eligible.map((unit) => (
                  <li key={unit.storageUnitId}>
                    <label>
                      {shown.canApprove ? (
                        <input
                          type="checkbox"
                          checked={chosen.includes(unit.storageUnitId)}
                          onChange={(event) =>
                            setChosen((list) =>
                              event.target.checked
                                ? [...list, unit.storageUnitId]
                                : list.filter((id) => id !== unit.storageUnitId),
                            )
                          }
                        />
                      ) : null}{' '}
                      <UnitLine unit={unit} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {shown.canApprove && eligible.length > 0 ? (
              <button
                type="button"
                className="primary"
                disabled={selected.length === 0}
                onClick={() => setConfirming(true)}
              >
                Approve {selected.length || ''} for disposal
              </button>
            ) : null}
          </BandedCard>
          <BandedCard title="Approved, waiting for the disposal scan">
            {approved.length === 0 ? (
              <EmptyState>None approved.</EmptyState>
            ) : (
              <ul className="disposal-list">
                {approved.map((unit) => (
                  <ApprovedRow
                    key={unit.storageUnitId}
                    unit={unit}
                    canRevoke={shown.canApprove}
                    onChanged={reload}
                  />
                ))}
              </ul>
            )}
          </BandedCard>
          <BandedCard title="Not eligible">
            {others.length === 0 ? (
              <EmptyState>None.</EmptyState>
            ) : (
              <ul className="disposal-list">
                {others.map((unit) => (
                  <li key={unit.storageUnitId}>
                    <UnitLine unit={unit} />
                    <span className="field-hint">
                      {' '}
                      {unit.blockers.map((b) => b.label).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </BandedCard>
          {tested.length > 0 ? (
            <BandedCard
              title="Tested: removed after testing"
              subtitle="Retention doesn’t apply. Open each unit and use “Confirm removal after testing”."
            >
              <ul className="disposal-list">
                {tested.map((unit) => (
                  <li key={unit.storageUnitId}>
                    <Link to={`/sample-storage/${unit.readableId}`}>{unit.readableId}</Link> ·{' '}
                    {unit.location.name} · Retention: Not applicable
                    {unit.blockers.length > 0 ? (
                      <span className="field-hint">
                        {' '}
                        · {unit.blockers.map((b) => b.label).join(' · ')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </BandedCard>
          ) : null}
          {shown.total > shown.pageSize ? (
            <nav className="pager" aria-label="Pages">
              <button type="button" disabled={page <= 1} onClick={() => turnPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => turnPage(page + 1)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog
        open={confirming && shown !== null && selected.length > 0}
        title={`Approve ${selected.length} for disposal?`}
        confirmLabel="Approve"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void approve()}
      >
        <p>Each is eligible: retain-until reached, no hold, programs closed.</p>
        <ul>
          {selected.map((unit) => (
            <li key={unit.storageUnitId}>
              {unit.readableId} · retain until {unit.effectiveRetainUntil}
            </li>
          ))}
        </ul>
        <p>Approval doesn’t dispose anything; the units stay in stock until scanned out.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmingList && listedItems.length > 0}
        title={`Approve ${listedItems.length} for disposal?`}
        confirmLabel="Approve"
        onCancel={() => setConfirmingList(false)}
        onConfirm={() => void approveListed()}
      >
        <p>
          Material Mule checks each one again: retain-until reached, no hold, every covering program
          closed, and that you may approve for its project.
        </p>
        <ul>
          {listedItems.map((item) => (
            <li key={item.id}>
              {item.readableId} · retain until {item.retention?.effectiveRetainUntil ?? '—'}
            </li>
          ))}
        </ul>
        <p>Approval doesn’t dispose anything; the units stay in stock until scanned out.</p>
      </ConfirmDialog>
    </div>
  );
}

function UnitLine({ unit }: { unit: DisposalCandidate }) {
  return (
    <>
      <Link to={`/sample-storage/${unit.readableId}`}>{unit.readableId}</Link> ·{' '}
      {unit.location.name} · retain until {unit.effectiveRetainUntil}
    </>
  );
}

function ApprovedRow({
  unit,
  canRevoke,
  onChanged,
}: {
  unit: DisposalCandidate;
  canRevoke: boolean;
  onChanged: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const approval = unit.approval!;

  async function revoke(event: FormEvent) {
    event.preventDefault();
    const outcome = await revokeApproval(approval.id, reason, key);
    if (!outcome.ok) setError(outcome.message);
    onChanged();
  }

  return (
    <li aria-label={`Approved ${unit.readableId}`}>
      <StatusBadge tone="warning">Approved for disposal</StatusBadge> <UnitLine unit={unit} />
      <span className="field-hint">
        {' '}
        · approved by {approval.approvedBy.initials ?? approval.approvedBy.name} ·{' '}
        {formatExpiry(approval.approvedAt)}
        {unit.blockers.length > 0
          ? ` · Now blocked: ${unit.blockers.map((b) => b.label).join(' · ')}`
          : ''}
      </span>
      {canRevoke && !revoking ? (
        <button type="button" onClick={() => setRevoking(true)}>
          Revoke
        </button>
      ) : null}
      {revoking ? (
        <form aria-label="Revoke approval" onSubmit={(event) => void revoke(event)}>
          <label>
            Reason for revoking (required)
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={!reason.trim()}>
            Revoke approval
          </button>
        </form>
      ) : null}
    </li>
  );
}
