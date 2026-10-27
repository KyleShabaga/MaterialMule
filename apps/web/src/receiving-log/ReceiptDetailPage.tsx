import { storageUnitTypeLabel, type ReceiptDetail, type ReceiptUnit } from '@materialmule/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  StatusBadge,
  type Column,
} from '../components/ui';
import '../inventory/inventory.css';
import { StorageUnitStatusBadge } from '../inventory/StorageUnitStatusBadge';
import { UnitContentsList } from '../inventory/UnitContents';
import { PrintLabelsPanel } from '../printing/PrintLabelsPanel';
import { receiptPrintPath, unitPrintPath } from '../printing/print-paths';
import { useSession } from '../session/context';
import { fetchReceipt, type ReceiptLogResult } from './api';
import { formatAccount, formatConfirmedAt, formatReceiver } from './format';
import type { ReceiptLinkState } from './ReceivingLogPage';
import './receiving-log.css';

/**
 * Receipt detail (MM-T51): the original receipt record as confirmed, and every storage unit it
 * created with the unit's current values. Corrections (MM-T13) and disposal never rewrite the
 * header or take a unit off its receipt. Opening this page prints nothing; Print uses the
 * existing queue (MM-T15) with the units' permanent IDs.
 */
export function ReceiptDetailPage() {
  const { receiptId = '' } = useParams();
  const location = useLocation();
  const from = (location.state as ReceiptLinkState | null)?.from ?? '';
  const { session } = useSession();
  const canPrint = session.status === 'active' && session.me.permissions.includes('label.print');
  const [loaded, setLoaded] = useState<{
    key: string;
    result: ReceiptLogResult<ReceiptDetail>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchReceipt(receiptId).then((result) => {
      if (!cancelled) setLoaded({ key: receiptId, result });
    });
    return () => {
      cancelled = true;
    };
  }, [receiptId, reloads]);

  const back = (
    <p className="back-link">
      <Link to={`/receiving-log${from}`}>← Back to Receiving Log</Link>
    </p>
  );

  if (!loaded || loaded.key !== receiptId) {
    return (
      <>
        {back}
        <PageHeader title="Receipt" />
        <p aria-busy="true">Loading receipt…</p>
      </>
    );
  }
  const { result } = loaded;
  if (!result.ok) {
    const missing = result.kind === 'not_found' || result.kind === 'invalid';
    return (
      <>
        {back}
        <PageHeader title="Receipt" />
        {missing ? (
          <EmptyState>No receipt found. Find it in the Receiving Log instead.</EmptyState>
        ) : (
          <ErrorState
            message={result.message}
            onRetry={result.kind === 'unauthenticated' ? undefined : () => setReloads((n) => n + 1)}
          />
        )}
      </>
    );
  }

  const receipt = result.data;
  const printable = receipt.units.filter((unit) => unit.status !== 'disposed');
  return (
    <>
      {back}
      <PageHeader title={`Receipt ${receipt.project.projectNumber} · ${receipt.receivedDate}`} />

      <section className="card" aria-labelledby="receipt-heading">
        <h2 id="receipt-heading">Original receipt record</h2>
        <p className="field-hint">
          As recorded at confirmation. Corrections to its storage units never change it.
        </p>
        <dl className="details">
          <Detail term="Received date">{receipt.receivedDate}</Detail>
          <Detail term="Project">
            {receipt.project.projectNumber} — {receipt.project.name} ({receipt.project.client})
          </Detail>
          <Detail term="Received by">{formatReceiver(receipt.receiver)}</Detail>
          <Detail term="Confirmed">
            <time dateTime={receipt.confirmedAt}>{formatConfirmedAt(receipt.confirmedAt)}</time>
          </Detail>
          <Detail term="Confirmed by account">{formatAccount(receipt.account)}</Detail>
          <Detail term="Storage units">{receipt.quantity}</Detail>
          <Detail term="Description">{receipt.description ?? 'None'}</Detail>
        </dl>
        <p className="field-hint">
          Project number and name show the project as it is now; the receipt keeps its link to that
          project.
        </p>
      </section>

      <section className="card" aria-labelledby="receipt-labels-heading">
        <h2 id="receipt-labels-heading">Labels</h2>
        {canPrint ? (
          <>
            {printable.length > 0 ? (
              <PrintLabelsPanel
                storageUnitIds={printable.map((unit) => unit.id)}
                // Labels were issued and first printed at confirmation; this prints them again.
                kind="reprint"
                buttonLabel={
                  printable.length === receipt.units.length
                    ? 'Print all labels'
                    : `Print ${printable.length} ${printable.length === 1 ? 'label' : 'labels'}`
                }
              />
            ) : (
              <p>Every storage unit in this receipt is disposed; there are no labels to print.</p>
            )}
            {printable.length < receipt.units.length && printable.length > 0 ? (
              <p className="field-hint">Disposed storage units are left out.</p>
            ) : null}
          </>
        ) : null}
        <p>
          {/* Print views open in a new tab so this receipt stays open (as on the labels step). */}
          <Link className="button" to={receiptPrintPath(receipt.id)} target="_blank" rel="noopener">
            Preview, print or save all labels as PDF
          </Link>
        </p>
      </section>

      <section className="card" aria-labelledby="receipt-units-heading">
        <h2 id="receipt-units-heading">Storage units in this receipt</h2>
        <p className="field-hint">
          Current values. A unit whose project or received date was corrected is marked “Corrected”;
          its history shows the change.
        </p>
        <div className="receiving-log-table table-stack">
          <UnitTable receipt={receipt} />
        </div>
      </section>
    </>
  );
}

function UnitTable({ receipt }: { receipt: ReceiptDetail }) {
  const unitPath = (unit: ReceiptUnit) => `/sample-storage/${encodeURIComponent(unit.readableId)}`;
  const columns: Column<ReceiptUnit>[] = [
    {
      header: 'Storage unit',
      cell: (unit) => (
        <span className="unit-cell">
          <Link
            className="receipt-unit-id"
            to={unitPath(unit)}
            aria-label={`Open ${unit.readableId}`}
          >
            {unit.readableId}
          </Link>
          <span>{storageUnitTypeLabel(unit.unitType)}</span>
        </span>
      ),
    },
    {
      // Hole summaries, a Shelby tube's source or a bulk sample (MM-T36).
      header: 'Sampling source',
      cell: (unit) => <UnitContentsList unit={unit} itemClassName="" />,
    },
    {
      header: 'Project',
      cell: (unit) => (
        <Current
          changed={unit.project.id !== receipt.project.id}
          original={receipt.project.projectNumber}
          historyPath={`${unitPath(unit)}#history`}
        >
          {unit.project.projectNumber} — {unit.project.name}
        </Current>
      ),
    },
    {
      header: 'Received',
      cell: (unit) => (
        <Current
          changed={unit.receivedDate !== receipt.receivedDate}
          original={receipt.receivedDate}
          historyPath={`${unitPath(unit)}#history`}
        >
          <span className="receipt-date">{unit.receivedDate}</span>
        </Current>
      ),
    },
    { header: 'Saved location', cell: (unit) => unit.location.name },
    { header: 'Status', cell: (unit) => <StorageUnitStatusBadge status={unit.status} /> },
    {
      header: 'Label',
      cell: (unit) => (
        <Link
          to={unitPrintPath(unit.readableId)}
          target="_blank"
          rel="noopener"
          aria-label={`Preview label for ${unit.readableId}`}
        >
          Preview label
        </Link>
      ),
    },
  ];
  return (
    <DataTable
      rows={receipt.units}
      rowKey={(unit) => unit.id}
      caption="Storage units in this receipt"
      empty="No storage units."
      columns={columns}
    />
  );
}

/** A unit's current value, marked "Corrected" (in words) when it differs from the receipt. */
function Current({
  changed,
  original,
  historyPath,
  children,
}: {
  changed: boolean;
  original: string;
  historyPath: string;
  children: ReactNode;
}) {
  if (!changed) return <>{children}</>;
  return (
    <span className="unit-cell receipt-corrected">
      <span>{children}</span>
      <span>
        <StatusBadge tone="info">Corrected</StatusBadge>{' '}
        <span className="field-hint">Receipt: {original}.</span>{' '}
        <Link to={historyPath}>History</Link>
      </span>
    </span>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
