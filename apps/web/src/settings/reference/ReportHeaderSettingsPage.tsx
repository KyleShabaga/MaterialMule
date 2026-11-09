import {
  concreteReportHeaderSchema,
  type ConcreteReportHeader,
  type UpdateConcreteReportHeaderRequest,
} from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../api/client';
import { BandedCard, ErrorState, FormField } from '../../components/ui';
import { useMe } from '../../session/context';
import './reference-settings.css';

// Settings → Report header (MM-V2-C32): the company block printed at the top of issued concrete
// reports. The default is the fictional "Material Mule Testing Laboratory" until the owner
// supplies branding; no accreditation marks. Everyone may look; admins change it (proposal,
// enforced by the server). Issued files never change: a new header applies to later issues.

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

export function ReportHeaderSettingsPage() {
  const me = useMe();
  const canManage = me.permissions.includes('concrete_settings.report_header.manage');
  const [header, setHeader] = useState<ConcreteReportHeader | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [form, setForm] = useState({ companyName: '', address: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

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

  if (failed) {
    return (
      <ErrorState
        message="The report header couldn’t be loaded."
        onRetry={() => setReloads((n) => n + 1)}
      />
    );
  }
  if (!header) return <p role="status">Loading…</p>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const result = await save({
      version: header.version,
      companyName: form.companyName,
      address: form.address,
      phone: form.phone,
    });
    setSaving(false);
    if (result.ok) {
      setHeader(result.data);
      setMessage({
        tone: 'ok',
        text: 'Report header saved. It applies to reports issued from now on.',
      });
    } else {
      setMessage({ tone: 'error', text: result.message });
    }
  };

  return (
    <BandedCard title="Report header">
      <p className="field-hint">
        Printed at the top of every issued concrete report. Reports already issued keep the header
        they were issued with.
      </p>
      <form onSubmit={submit} className="report-header-form">
        <FormField label="Company name" required>
          {(props) => (
            <input
              {...props}
              value={form.companyName}
              maxLength={200}
              required
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Address">
          {(props) => (
            <textarea
              {...props}
              value={form.address}
              maxLength={500}
              rows={3}
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Phone">
          {(props) => (
            <input
              {...props}
              value={form.phone}
              maxLength={50}
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          )}
        </FormField>
        {canManage ? (
          <div className="page-actions">
            <button type="submit" className="primary" disabled={saving}>
              Save header
            </button>
          </div>
        ) : (
          <p className="field-hint">{REPORT_HEADER_NOT_ALLOWED_TEXT}</p>
        )}
        {message ? (
          <p
            className={message.tone === 'ok' ? 'field-hint' : 'field-error'}
            role={message.tone === 'ok' ? 'status' : 'alert'}
          >
            {message.text}
          </p>
        ) : null}
      </form>
    </BandedCard>
  );
}
