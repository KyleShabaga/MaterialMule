import type { ConcreteSupplier, ConcreteSupplierList, FieldError } from '@materialmule/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DataTable, ErrorState, FormField, StatusBadge } from '../../components/ui';
import { createSupplier, fetchSuppliers, updateSupplier, type SaveResult } from './api';
import './reference-settings.css';

// Settings → Suppliers (MM-V2-C37, owner decision 2026-11-08): the listed concrete suppliers and
// their plants. Everyone may look; Lab Managers and admins add, edit and deactivate them (the
// server enforces the same rule). Mixes keep their own free-text supplier and plant names and may
// link a listed supplier; a supplier is never deleted.

export const SUPPLIERS_NOT_ALLOWED_TEXT = 'Only Lab Managers and admins can change suppliers.';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: ConcreteSupplierList };

const errorFor = (errors: FieldError[], field: string) =>
  errors.find((error) => error.field === field || error.field.startsWith(`${field}.`))?.message ??
  null;

/** One plant per line (commas also split), blanks dropped. */
function plantsFrom(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((plant) => plant.trim())
    .filter((plant) => plant.length > 0);
}

function SupplierForm({
  supplier,
  onSaved,
  onCancel,
}: {
  supplier: ConcreteSupplier | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(supplier?.name ?? '');
  const [plants, setPlants] = useState((supplier?.plantNames ?? []).join('\n'));
  const [active, setActive] = useState(supplier?.active ?? true);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const title = supplier ? `Edit ${supplier.name}` : 'Add a supplier';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors([]);
    setMessage(null);
    const plantNames = plantsFrom(plants);
    const result: SaveResult<ConcreteSupplier> = supplier
      ? await updateSupplier(supplier.id, {
          version: supplier.version,
          name,
          plantNames,
          active,
          reason: reason.trim() === '' ? null : reason,
        })
      : await createSupplier({ name, plantNames });
    setSaving(false);
    if (result.ok) {
      onSaved(supplier ? `${result.data.name} saved.` : `${result.data.name} added.`);
    } else if (result.kind === 'conflict') {
      onSaved(result.message);
    } else if (result.kind === 'invalid') {
      setErrors(result.errors);
      setMessage(result.message);
    } else {
      setMessage(result.message);
    }
  }

  return (
    <form className="inline-form" aria-label={title} noValidate onSubmit={(e) => void submit(e)}>
      <h3>{title}</h3>
      <FormField label="Supplier name" required error={errorFor(errors, 'name')}>
        {(props) => (
          <input
            {...props}
            type="text"
            value={name}
            required
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Plants"
        hint="One plant per line. Mixes still name their own plant."
        error={errorFor(errors, 'plantNames')}
      >
        {(props) => (
          <textarea
            {...props}
            rows={3}
            value={plants}
            onChange={(e) => setPlants(e.target.value)}
          />
        )}
      </FormField>
      {supplier ? (
        <>
          <div className="form-field checkbox-field">
            <label>
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />{' '}
              Active (offered when linking a mix)
            </label>
          </div>
          <FormField label="Reason (optional)" error={errorFor(errors, 'reason')}>
            {(props) => (
              <input
                {...props}
                type="text"
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </FormField>
        </>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : supplier ? 'Save' : 'Add supplier'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {message ? (
        <p className="field-error" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function SuppliersSettingsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [includeInactive, setIncludeInactive] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void fetchSuppliers(includeInactive).then((result) => {
      if (!live) return;
      setLoad(
        result.ok
          ? { state: 'ready', data: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      live = false;
    };
  }, [includeInactive, attempt]);

  if (load.state === 'loading') return <p aria-busy="true">Loading suppliers…</p>;
  if (load.state === 'error') {
    return (
      <ErrorState
        message={load.message}
        onRetry={() => {
          setLoad({ state: 'loading' });
          reload();
        }}
      />
    );
  }
  const { items, canManage } = load.data;
  const saved = (message: string) => {
    setEditing(null);
    setNotice(message);
    reload();
  };
  const editingSupplier = items.find((item) => item.id === editing) ?? null;

  return (
    <>
      <p role="status" className="field-hint">
        {notice ?? ''}
      </p>
      <section className="card" aria-labelledby="suppliers-heading">
        <div className="section-header">
          <h2 id="suppliers-heading">Concrete suppliers</h2>
          {canManage && editing === null ? (
            <button type="button" onClick={() => setEditing('new')}>
              Add a supplier
            </button>
          ) : null}
        </div>
        <p className="field-hint">
          The suppliers and plants a mix can link. A mix keeps the supplier and plant names it was
          entered with, and a mix number stays unique per project and supplier.
        </p>
        <div className="form-field checkbox-field">
          <label>
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />{' '}
            Show inactive suppliers
          </label>
        </div>
        {editing === 'new' ? (
          <SupplierForm supplier={null} onSaved={saved} onCancel={() => setEditing(null)} />
        ) : null}
        <DataTable
          caption="Concrete suppliers"
          rows={items}
          rowKey={(row) => row.id}
          empty="No suppliers are listed yet."
          columns={[
            { header: 'Supplier', cell: (row) => row.name },
            {
              header: 'Plants',
              cell: (row) => (row.plantNames.length > 0 ? row.plantNames.join(', ') : '—'),
            },
            {
              header: 'Status',
              cell: (row) =>
                row.active ? (
                  <StatusBadge tone="success">Active</StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">Inactive</StatusBadge>
                ),
            },
            { header: 'Linked mixes', cell: (row) => String(row.linkedMixCount) },
            ...(canManage
              ? [
                  {
                    header: 'Actions',
                    cell: (row: ConcreteSupplier) => (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setEditing(row.id)}
                      >
                        Edit {row.name}
                      </button>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {editingSupplier ? (
          <SupplierForm
            key={editingSupplier.id}
            supplier={editingSupplier}
            onSaved={saved}
            onCancel={() => setEditing(null)}
          />
        ) : null}
        {canManage ? null : <p className="field-hint">{SUPPLIERS_NOT_ALLOWED_TEXT}</p>}
      </section>
    </>
  );
}
