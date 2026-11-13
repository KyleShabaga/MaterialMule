import type { Printer } from '@materialmule/shared';
import { Plus } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { notifySuccess } from '../../components/strata/toast';
import { fetchPrinters, savePrinters } from '../../printing/api';
import { useMe } from '../../session/context';
import { SettingsPanel } from '../modal/SettingsPanel';
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
  TextField,
  TOUCH,
} from '../reference/panel-parts';

// Settings › Printers (MM-T15, STRATA-118, STRATA-102; canvas R9PrintersPanel list and drawer).
// The Zebra label printers: a table, and a drawer to add or change one. Lab Managers and
// administrators hold `printer.manage`; the server checks every change. A printer's address lives
// only on the server and in this admin form: label printing names a printer by its key, never a
// host. Printers are never deleted; one not in use isn't offered when printing.

export const PRINTERS_NOT_ALLOWED_TEXT =
  'Only Lab Managers and administrators can change printers.';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; printers: Printer[] };

const BLANK: Printer = {
  id: '',
  name: '',
  host: '',
  port: 9100,
  enabled: true,
  isDefault: false,
  checkStatus: true,
};

const NEW = '__new__';

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid min-w-0 gap-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <span id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </span>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-hint`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** One printer's settings; a new printer also chooses its permanent ID. */
function PrinterForm({
  initial,
  isNew,
  titleId,
  onSaved,
  onCancel,
}: {
  initial: Printer;
  isNew: boolean;
  titleId: string;
  onSaved: (printers: Printer[], saved: Printer) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Printer>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Printer>(key: K, value: Printer[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await savePrinters({ printers: [draft] });
    setSaving(false);
    if (result.ok) onSaved(result.data, draft);
    else setError(result.message);
  }

  const title = isNew ? 'Add a printer' : initial.name || initial.id;
  return (
    <>
      <DrawerHead
        titleId={titleId}
        eyebrow={isNew ? 'Zebra ZD621' : `${initial.id} · Zebra`}
        title={title}
        aside={
          isNew ? null : (
            <>
              {initial.enabled ? (
                <StateBadge tone="storage">In use</StateBadge>
              ) : (
                <StateBadge tone="closed">Not in use</StateBadge>
              )}
              {initial.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            </>
          )
        }
      />
      <form
        aria-label={title}
        noValidate
        className="grid gap-5"
        onSubmit={(event) => void submit(event)}
      >
        {isNew ? (
          <TextField
            label="Printer ID"
            hint="Lowercase letters, digits and dashes. Can’t change later."
            value={draft.id}
            onChange={(value) => set('id', value)}
            required
            mono
          />
        ) : null}
        <TextField label="Name" value={draft.name} onChange={(v) => set('name', v)} required />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <TextField
            label="IP address or host name"
            hint="Fixed address from IT, e.g. 10.0.0.50"
            value={draft.host}
            onChange={(value) => set('host', value)}
            required
            mono
          />
          <TextField
            label="Port"
            hint="Zebra uses 9100"
            type="number"
            min={1}
            max={65535}
            value={String(draft.port)}
            onChange={(value) => set('port', Number(value))}
            required
            mono
          />
        </div>
        <div className="grid gap-4">
          <SwitchRow
            label="In use"
            hint="Printers not in use aren’t offered when printing."
            checked={draft.enabled}
            onChange={(value) => set('enabled', value)}
          />
          <SwitchRow
            label="Default printer for labels"
            hint="Offered first when anyone prints labels. Only one printer is the default."
            checked={draft.isDefault}
            onChange={(value) => set('isDefault', value)}
          />
          <SwitchRow
            label="Check printer status before sending"
            hint="Asks the printer about paper, head and pause first."
            checked={draft.checkStatus}
            onChange={(value) => set('checkStatus', value)}
          />
        </div>
        <FormMessage message={error} />
        <FormActions>
          <Button type="submit" size="sm" className={TOUCH} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Add printer' : 'Save'}
          </Button>
          <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onCancel}>
            Cancel
          </Button>
        </FormActions>
      </form>
      <p className="text-sm text-muted-foreground">
        Printing never changes a storage unit’s ID or record.
      </p>
    </>
  );
}

const COLUMNS: DataTableColumn<Printer>[] = [
  {
    id: 'printer',
    header: 'Printer',
    priority: 'identity',
    cell: (printer) => (
      <span className="grid min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{printer.name}</span>
          {printer.isDefault ? <Badge variant="secondary">Default</Badge> : null}
        </span>
        <span className="truncate font-mono text-[13px] text-muted-foreground">{printer.id}</span>
      </span>
    ),
  },
  {
    id: 'address',
    header: 'Address',
    priority: 'attribute',
    hideBelow: '30rem',
    mono: true,
    width: '18ch',
    cell: (printer) => `${printer.host}:${printer.port}`,
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'state',
    width: '8rem',
    wrap: true,
    cell: (printer) =>
      printer.enabled ? (
        <StateBadge tone="storage">In use</StateBadge>
      ) : (
        <StateBadge tone="closed">Not in use</StateBadge>
      ),
  },
];

/** Settings › Printers (Lab Managers and administrators). */
export function PrintersPanel() {
  const me = useMe();
  const allowed = me.permissions.includes('printer.manage');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void fetchPrinters().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', printers: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [allowed, attempt]);

  const ready = load.state === 'ready';
  const actions =
    allowed && ready ? (
      <Button size="sm" className={TOUCH} onClick={() => setOpenId(NEW)}>
        <Plus aria-hidden="true" />
        Add a printer
      </Button>
    ) : null;

  let body;
  if (!allowed) body = <ReadOnlyNote>{PRINTERS_NOT_ALLOWED_TEXT}</ReadOnlyNote>;
  else if (load.state === 'loading') body = <PanelLoading label="Loading printers…" />;
  else if (load.state === 'error') {
    body = <PanelError message={load.message} onRetry={() => setAttempt((a) => a + 1)} />;
  } else {
    const printers = load.printers;
    const open = openId === NEW ? null : (printers.find((p) => p.id === openId) ?? null);
    const onSaved = (next: Printer[], saved: Printer) => {
      setLoad({ state: 'ready', printers: next });
      setOpenId(saved.id);
      notifySuccess(openId === NEW ? `${saved.name} added.` : 'Printer settings saved.');
    };
    body = (
      <div className="grid gap-3">
        <CountLine>{printers.length === 1 ? '1 printer' : `${printers.length} printers`}</CountLine>
        <RecordSplit
          listLabel="Printers"
          titleId={titleId}
          openId={openId}
          onClose={() => setOpenId(null)}
          list={
            <DataTable
              caption="Printers"
              columns={COLUMNS}
              data={printers}
              getRowId={(printer) => printer.id}
              rowLabel={(printer) => printer.name}
              openRowId={openId}
              onOpenRow={(printer) => setOpenId(printer.id)}
              freeColumnMin="10rem"
              empty="No label printer yet. Add the ZD621 once IT has given it a fixed IP."
            />
          }
          drawer={
            openId === NEW ? (
              <PrinterForm
                key={NEW}
                initial={BLANK}
                isNew
                titleId={titleId}
                onSaved={onSaved}
                onCancel={() => setOpenId(null)}
              />
            ) : open ? (
              <PrinterForm
                key={`${open.id}:${JSON.stringify(open)}`}
                initial={open}
                isNew={false}
                titleId={titleId}
                onSaved={onSaved}
                onCancel={() => setOpenId(null)}
              />
            ) : null
          }
        />
        <p className="text-sm text-muted-foreground">
          Addresses stay on the server: label printing names a printer, never its address. Printers
          are never removed; switch one off with In use.
        </p>
      </div>
    );
  }

  return (
    <SettingsPanel
      id="printers"
      title="Printers"
      description="The Zebra label printers and their state. Lab Managers and administrators add and change them."
      actions={actions}
      wide
    >
      {body}
    </SettingsPanel>
  );
}
