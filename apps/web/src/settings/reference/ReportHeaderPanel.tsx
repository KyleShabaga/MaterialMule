import {
  concreteReportHeaderSchema,
  type ConcreteReportHeader,
  type UpdateConcreteReportHeaderRequest,
} from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '../../api/client';
import { notifySuccess } from '../../components/strata/toast';
import { useMe } from '../../session/context';
import { SettingsPanel } from '../modal/SettingsPanel';
import {
  FormActions,
  FormMessage,
  OpenItem,
  PanelError,
  PanelLoading,
  ReadOnlyNote,
  TextAreaField,
  TextField,
  TOUCH,
} from './panel-parts';

// Settings › Report header (MM-V2-C32; STRATA-102, canvas R9ConcretePanel report-header): the
// company block printed at the top of issued concrete reports. The default is the fictional
// "Material Mule Testing Laboratory" until the owner supplies branding; no accreditation marks.
// Everyone may read; administrators change it (`concrete_settings.report_header.manage`, enforced
// by the server). Issued files never change: a new header applies to later issues. The report
// layout itself is a gate (report templates), so the preview shows the header only.

export const REPORT_HEADER_NOT_ALLOWED_TEXT = 'Only admins can change the report header.';

async function load(): Promise<ConcreteReportHeader> {
  const response = await apiFetch('/api/concrete/report-header');
  if (!response.ok) throw new Error('load_failed');
  return concreteReportHeaderSchema.parse(await response.json());
}

async function save(
  body: UpdateConcreteReportHeaderRequest,
): Promise<{ ok: true; data: ConcreteReportHeader } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await apiFetch('/api/concrete/report-header', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: 'Material Mule couldn’t be reached. Check the connection.' };
  }
  const json = (await response.json().catch(() => null)) as {
    code?: string;
    errors?: { message?: string }[];
  } | null;
  if (response.ok) return { ok: true, data: concreteReportHeaderSchema.parse(json) };
  if (response.status === 409) {
    return {
      ok: false,
      message: 'Someone changed the header while you had it open. Reload and try again.',
    };
  }
  if (response.status === 403) return { ok: false, message: REPORT_HEADER_NOT_ALLOWED_TEXT };
  return {
    ok: false,
    message: json?.errors?.map((e) => e.message).join('; ') || 'Check the entries and try again.',
  };
}

/** Settings › Report header (everyone reads; administrators change). */
export function ReportHeaderPanel() {
  const me = useMe();
  const canManage = me.permissions.includes('concrete_settings.report_header.manage');
  const [header, setHeader] = useState<ConcreteReportHeader | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [form, setForm] = useState({ companyName: '', address: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    load().then(
      (data) => {
        if (!current) return;
        setHeader(data);
        setFailed(false);
        setForm({
          companyName: data.companyName,
          address: data.address ?? '',
          phone: data.phone ?? '',
        });
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [reloads]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!header) return;
    setSaving(true);
    setError(null);
    const result = await save({
      version: header.version,
      companyName: form.companyName,
      address: form.address,
      phone: form.phone,
    });
    setSaving(false);
    if (result.ok) {
      setHeader(result.data);
      notifySuccess('Report header saved. It applies to reports issued from now on.');
    } else {
      setError(result.message);
    }
  };

  let body;
  if (failed) {
    body = (
      <PanelError
        message="The report header couldn’t be loaded."
        onRetry={() => setReloads((n) => n + 1)}
      />
    );
  } else if (!header) {
    body = <PanelLoading label="Loading the report header…" />;
  } else {
    body = (
      <>
        <form
          aria-label="Report header"
          noValidate
          className="grid max-w-xl gap-5"
          onSubmit={(event) => void submit(event)}
        >
          <TextField
            label="Company name"
            value={form.companyName}
            onChange={(companyName) => setForm({ ...form, companyName })}
            required
            maxLength={200}
            disabled={!canManage}
          />
          <TextAreaField
            label="Address"
            value={form.address}
            onChange={(address) => setForm({ ...form, address })}
            maxLength={500}
            disabled={!canManage}
          />
          <TextField
            label="Phone"
            value={form.phone}
            onChange={(phone) => setForm({ ...form, phone })}
            maxLength={50}
            disabled={!canManage}
          />
          <FormMessage message={error} />
          {canManage ? (
            <FormActions>
              <Button type="submit" size="sm" className={TOUCH} disabled={saving}>
                {saving ? 'Saving…' : 'Save header'}
              </Button>
            </FormActions>
          ) : (
            <ReadOnlyNote>{REPORT_HEADER_NOT_ALLOWED_TEXT}</ReadOnlyNote>
          )}
        </form>
        <section aria-labelledby="report-header-preview" className="grid gap-3">
          <h3 id="report-header-preview" className="border-b pb-3 text-base font-semibold">
            Preview of the printed header
          </h3>
          {/* Paper stays black on white in both themes, like printed labels. */}
          <figure className="m-0 grid gap-2">
            <div className="grid gap-1 rounded-md border bg-white p-6 text-black shadow-xs">
              <p className="text-lg font-semibold">{form.companyName || 'Company name'}</p>
              {form.address ? <p className="text-sm whitespace-pre-line">{form.address}</p> : null}
              {form.phone ? <p className="text-sm">{form.phone}</p> : null}
              <hr
                data-slot="report-header-rule"
                aria-hidden="true"
                className="my-2 border-black/40"
              />
              <p className="text-sm">Concrete report · placeholder layout</p>
            </div>
            <figcaption className="text-sm text-muted-foreground">
              On screen only. Reports already issued keep the header they were issued with.
            </figcaption>
          </figure>
        </section>
        <OpenItem title="Report templates">
          The issued report’s layout is a gate. This preview shows only the header; the rest of the
          report isn’t designed here.
        </OpenItem>
      </>
    );
  }

  return (
    <SettingsPanel
      id="report-header"
      title="Report header"
      description="Printed at the top of every issued concrete report. Everyone can read it; administrators change it."
    >
      {body}
    </SettingsPanel>
  );
}
