import type { ConcreteSupplier, ConcreteSupplierList, FieldError } from '@materialmule/shared';
import { Pencil, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { notifyError, notifySuccess } from '../../components/strata/toast';
import { SettingsPanel } from '../modal/SettingsPanel';
import { createSupplier, fetchSuppliers, updateSupplier, type SaveResult } from './api';
import {
  CountLine,
  DrawerHead,
  FormActions,
  FormMessage,
  PanelError,
  PanelLoading,
  ReadOnlyNote,
  RecordSplit,
  StateBadge,
  TextAreaField,
  TextField,
  TOUCH,
} from './panel-parts';

// Settings › Suppliers (MM-V2-C37, owner decision 2026-11-08; STRATA-102, canvas R9ConcretePanel
// suppliers): the listed concrete suppliers and their plants. Everyone may read; Lab Managers and
// administrators add, edit and deactivate them (`concrete_settings.supplier.manage`, enforced by
// the server). Mixes keep their own free-text supplier and plant names and may link a listed
// supplier; a supplier is never deleted.

export const SUPPLIERS_NOT_ALLOWED_TEXT = 'Only Lab Managers and admins can change suppliers.';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: ConcreteSupplierList };

const NEW = '__new__';

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
  titleId,
  onSaved,
  onCancel,
}: {
  supplier: ConcreteSupplier | null;
  titleId: string;
  onSaved: (message: string, ok: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(supplier?.name ?? '');
  const [plants, setPlants] = useState((supplier?.plantNames ?? []).join('\n'));
  const [active, setActive] = useState(supplier?.active ?? true);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activeId = useId();
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
      onSaved(supplier ? `${result.data.name} saved.` : `${result.data.name} added.`, true);
    } else if (result.kind === 'conflict') {
      onSaved(result.message, false);
    } else if (result.kind === 'invalid') {
      setErrors(result.errors);
      setMessage(result.message);
    } else {
      setMessage(result.message);
    }
  }

  return (
    <>
      <DrawerHead
        titleId={titleId}
        eyebrow={supplier ? `${supplier.linkedMixCount} linked mixes` : 'Concrete supplier'}
        title={supplier ? supplier.name : 'Add a supplier'}
        aside={
          supplier ? (
            supplier.active ? (
              <StateBadge tone="storage">Active</StateBadge>
            ) : (
              <StateBadge tone="closed">Inactive</StateBadge>
            )
          ) : null
        }
      />
      <form
        aria-label={title}
        noValidate
        className="grid gap-5"
        onSubmit={(event) => void submit(event)}
      >
        <TextField
          label="Supplier name"
          value={name}
          onChange={setName}
          required
          maxLength={200}
          error={errorFor(errors, 'name')}
        />
        <TextAreaField
          label="Plants"
          hint="One plant per line. Mixes still name their own plant."
          value={plants}
          onChange={setPlants}
          error={errorFor(errors, 'plantNames')}
        />
        {supplier ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="grid min-w-0 gap-0.5">
                <Label htmlFor={activeId} className="text-sm font-medium">
                  Active
                </Label>
                <span id={`${activeId}-hint`} className="text-sm text-muted-foreground">
                  Offered when linking a mix. A supplier with linked mixes is made inactive, never
                  removed.
                </span>
              </div>
              <Switch
                id={activeId}
                aria-describedby={`${activeId}-hint`}
                checked={active}
                onCheckedChange={setActive}
              />
            </div>
            <TextField
              label="Reason (optional)"
              value={reason}
              onChange={setReason}
              maxLength={2000}
              error={errorFor(errors, 'reason')}
            />
          </>
        ) : null}
        <FormMessage message={message} />
        <FormActions>
          <Button type="submit" size="sm" className={TOUCH} disabled={saving}>
            {saving ? 'Saving…' : supplier ? 'Save' : 'Add supplier'}
          </Button>
          <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onCancel}>
            Cancel
          </Button>
        </FormActions>
      </form>
    </>
  );
}

/** Settings › Suppliers (everyone reads; Lab Managers and administrators change). */
export function SuppliersPanel() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [includeInactive, setIncludeInactive] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const titleId = useId();
  const inactiveId = useId();

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

  const canManage = load.state === 'ready' && load.data.canManage;
  const actions = canManage ? (
    <Button size="sm" className={TOUCH} onClick={() => setOpenId(NEW)}>
      <Plus aria-hidden="true" />
      Add a supplier
    </Button>
  ) : null;

  let body;
  if (load.state === 'loading') body = <PanelLoading label="Loading suppliers…" />;
  else if (load.state === 'error') {
    body = (
      <PanelError
        message={load.message}
        onRetry={() => {
          setLoad({ state: 'loading' });
          reload();
        }}
      />
    );
  } else {
    const { items } = load.data;
    const open = items.find((item) => item.id === openId) ?? null;
    const saved = (message: string, ok: boolean) => {
      setOpenId(null);
      if (ok) notifySuccess(message);
      else notifyError(message);
      reload();
    };
    const columns: DataTableColumn<ConcreteSupplier>[] = [
      {
        id: 'supplier',
        header: 'Supplier',
        priority: 'identity',
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        id: 'plants',
        header: 'Plants',
        // Never hides: the plants are what a mix links to (and phones read them too).
        priority: 'attribute',
        wrap: true,
        cell: (row) => (row.plantNames.length > 0 ? row.plantNames.join(', ') : '—'),
      },
      {
        id: 'mixes',
        header: 'Linked mixes',
        priority: 'attribute',
        hideBelow: '32rem',
        numeric: true,
        width: '7rem',
        cell: (row) => String(row.linkedMixCount),
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'state',
        width: '6rem',
        wrap: true,
        cell: (row) =>
          row.active ? (
            <StateBadge tone="storage">Active</StateBadge>
          ) : (
            <StateBadge tone="closed">Inactive</StateBadge>
          ),
      },
      ...(load.data.canManage
        ? [
            {
              id: 'edit',
              header: <span className="sr-only">Actions</span>,
              priority: 'state' as const,
              control: true,
              width: '2.5rem',
              cell: (row: ConcreteSupplier) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  aria-label={`Edit ${row.name}`}
                  title={`Edit ${row.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenId(row.id);
                  }}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              ),
            },
          ]
        : []),
    ];
    body = (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          The suppliers and plants a mix can link. A mix keeps the supplier and plant names it was
          entered with, and a mix number stays unique per project and supplier.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CountLine>{items.length === 1 ? '1 supplier' : `${items.length} suppliers`}</CountLine>
          <div className="flex items-center gap-2">
            <Switch
              id={inactiveId}
              checked={includeInactive}
              onCheckedChange={(value) => {
                setOpenId(null);
                setIncludeInactive(value);
              }}
            />
            <Label htmlFor={inactiveId} className="text-sm">
              Show inactive suppliers
            </Label>
          </div>
        </div>
        <RecordSplit
          listLabel="Concrete suppliers"
          titleId={titleId}
          openId={openId}
          onClose={() => setOpenId(null)}
          list={
            <DataTable
              caption="Concrete suppliers"
              columns={columns}
              data={items}
              getRowId={(row) => row.id}
              rowLabel={(row) => row.name}
              openRowId={openId}
              onOpenRow={load.data.canManage ? (row) => setOpenId(row.id) : undefined}
              freeColumnMin="10rem"
              empty="No suppliers are listed yet."
            />
          }
          drawer={
            openId === NEW ? (
              <SupplierForm
                key={NEW}
                supplier={null}
                titleId={titleId}
                onSaved={saved}
                onCancel={() => setOpenId(null)}
              />
            ) : open ? (
              <SupplierForm
                key={`${open.id}:${open.version}`}
                supplier={open}
                titleId={titleId}
                onSaved={saved}
                onCancel={() => setOpenId(null)}
              />
            ) : null
          }
        />
        {load.data.canManage ? null : <ReadOnlyNote>{SUPPLIERS_NOT_ALLOWED_TEXT}</ReadOnlyNote>}
        <p className="text-sm text-muted-foreground">
          An inactive supplier stays on every mix that already names it. A supplier typed by hand on
          a mix is not added here.
        </p>
      </div>
    );
  }

  return (
    <SettingsPanel
      id="suppliers"
      title="Suppliers"
      description="Concrete suppliers and their plants. Everyone can read them; Lab Managers and administrators change them."
      actions={actions}
      wide
    >
      {body}
    </SettingsPanel>
  );
}
