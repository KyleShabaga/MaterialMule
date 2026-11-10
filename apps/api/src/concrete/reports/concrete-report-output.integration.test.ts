import { createHash, randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteReportHeaderSchema,
  concreteReportVersionListSchema,
  concreteSummaryReportListSchema,
  concreteSummaryReportSchema,
  type ConcreteFieldReportDetail,
} from '@materialmule/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../../auth/auth.guard.js';
import { REPORT_ISSUER_GRANT } from '../../project-access/grant-tables.js';
import { testDatabaseUrl } from '../../test-support/database.js';
import { endGrantDuring } from '../../test-support/grant-race.js';
import { createLabHarness, newKey, type LabHarness } from '../../test-support/lab-harness.js';
import { pdfText } from '../../test-support/pdf-text.js';

// MM-V2-C32 T1: render at issue, hash, frozen file (AC1, AC2), revision linking, the report
// number allocator through the issue command, the project summary report and the report header.
// Real PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (led by Pat Example `pe`),
// Alex Tester (`tech`), invented suppliers, tickets and machines.

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.runIf(testDatabaseUrl)('concrete report output (MM-V2-C32)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  let year: number;

  const send = (method: 'post' | 'patch' | 'put', url: string, body: unknown, as: string) =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as] ?? as)
      .send(body as object);
  const get = (url: string, as: string) =>
    h
      .http()
      .get(url)
      .set('Cookie', cookies[as] ?? as);
  /** Binary GET: the body as a Buffer. */
  const download = (url: string, as: string): Promise<Response & { body: Buffer }> =>
    h
      .http()
      .get(url)
      .set('Cookie', cookies[as] ?? as)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      }) as never;
  const reportPath = (id: string, rest = '') => `/api/concrete/field-reports/${id}${rest}`;

  const SPEC = {
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
  };
  const completeFields = () => ({
    reportDate: '2026-11-08',
    contractorName: 'Example Builders',
    paperFieldId: 'F-C32',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber: `T-${randomUUID().slice(0, 8)}`,
    truckNumber: 'T-7',
    plantName: 'North Plant',
    batchedAt: '2026-11-08T15:00:00.000Z',
    loadVolumeM3: 8,
    cumulativeVolumeM3: 24,
    projectSpec: SPEC,
    ticketSpec: SPEC,
    arrivedAt: '2026-11-08T15:20:00.000Z',
    sampledAt: '2026-11-08T15:30:00.000Z',
    testedAt: '2026-11-08T15:35:00.000Z',
    timeLimitExceeded: false,
    loadRejected: false,
    loadDecisionByName: 'Sam Example',
    loadDecisionByCompany: 'Example Builders',
    samplingLocation: 'chute',
    placementMethods: ['chute'],
    material: 'concrete',
    superplasticizerAdded: 'none',
    concreteTempC: 18,
    ambientTempC: -4,
    waterAdded: false,
    specimensCast: false,
    resultsReportedToName: 'Sam Example',
    resultsReportedToCompany: 'Example Builders',
    readings: [
      // 130 mm is outside 80 ± 30: printed as recorded with ⚠.
      { id: randomUUID(), test: 'slump', context: 'initial', value: 130 },
      { id: randomUUID(), test: 'air', context: 'initial', value: 6 },
    ],
    attachmentRefs: [{ id: randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' }],
  });

  async function ok(
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
  ) {
    if (action === 'review') {
      // C28: exceptions documented before review (setup only; no audit event).
      await h.db.pool.query(
        `INSERT INTO concrete_report_exception_note
           (project_id, field_report_id, version_id, code, field, note, documented_by_user_id)
         SELECT v.project_id, v.field_report_id, v.id, w->>'code', w->>'field',
                'Checked with the supplier', $2
         FROM concrete_report_version v
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.snapshot->'warnings', '[]')) w
         WHERE v.field_report_id = $1 AND v.state = 'submitted'
         ON CONFLICT DO NOTHING`,
        [report.id, h.users.pe],
      );
    }
    const response = await send(
      'post',
      reportPath(report.id, `/${action}`),
      { idempotencyKey: newKey(), version: report.version, ...extra },
      as,
    );
    expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function reviewedReport(fields = completeFields()) {
    const created = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), ...fields },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const report = concreteFieldReportDetailSchema.parse(created.body);
    return ok('review', await ok('submit', report, 'tech'), 'pe');
  }

  async function versions(reportId: string) {
    return concreteReportVersionListSchema.parse(
      (await get(reportPath(reportId, '/versions'), 'tech')).body,
    ).versions;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    const { rows } = await h.db.pool.query<{ year: number }>(
      `SELECT extract(year FROM (now() AT TIME ZONE 'America/Edmonton'))::int AS year`,
    );
    year = rows[0]!.year;
    const machine = await send(
      'post',
      '/api/concrete/testing-machine',
      {
        kind: 'testing_machine',
        identifier: 'TM-C32',
        make: 'Demo Instruments',
        model: 'CM-3000',
        idempotencyKey: newKey(),
      },
      'lm',
    );
    expect(machine.status, JSON.stringify(machine.body)).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  let issuedReport: ConcreteFieldReportDetail;
  let firstFile: { id: string; sha256: string; bytes: Buffer };

  it('issuing renders the PDF from the frozen snapshot and stores it with its hash, number and template', async () => {
    const reviewed = await reviewedReport();
    issuedReport = await ok('issue', reviewed, 'pe', { includeMachineInfo: true });
    const issued = issuedReport.lifecycle.latestVersion!.issued!;
    expect(issued.reportNumber).toMatch(new RegExp(`^CF-${year}-\\d{5}$`));
    expect(issued.file).toMatchObject({
      kind: 'field',
      reportNumber: issued.reportNumber,
      revisionNo: 0,
      supersedesFileId: null,
      mediaType: 'application/pdf',
      includePhotos: false,
      includeMachineInfo: true,
      template: { revision: 'P1', name: 'Field report template', provisional: true },
    });
    const file = issued.file!;

    // The template in force is recorded on the issued version.
    const { rows } = await h.db.pool.query<{
      report_template_id: string;
      report_number_id: string;
    }>('SELECT report_template_id, report_number_id FROM concrete_report_version WHERE id = $1', [
      issuedReport.lifecycle.latestVersion!.id,
    ]);
    expect(rows[0]!.report_template_id).toBe(file.template.id);

    // Download (inventory.read, LAB included): exactly the stored bytes.
    const response = await download(`/api/concrete/report-files/${file.id}`, 'lab');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['x-content-sha256']).toBe(file.sha256);
    expect(sha(response.body)).toBe(file.sha256);
    expect(response.body.length).toBe(file.byteSize);
    const text = pdfText(response.body);
    expect(text).toContain(issued.reportNumber!);
    expect(text).toContain('Rev 0');
    expect(text).toContain('Pat Example');
    expect(text).toContain('Demo Instruments');
    expect(text).toContain('Checked with the supplier');
    expect(text).toContain(
      "Reading outside the mix's specified range. The value is printed as recorded.",
    );
    firstFile = { id: file.id, sha256: file.sha256, bytes: response.body };

    // The audit records the number, template and hash.
    const { rows: audit } = await h.db.pool.query<{ after_values: Record<string, unknown> }>(
      `SELECT after_values FROM audit_event WHERE entity_id = $1
         AND action = 'concrete_field_report.issued' ORDER BY occurred_at DESC LIMIT 1`,
      [issuedReport.id],
    );
    expect(audit[0]!.after_values).toMatchObject({
      reportNumber: issued.reportNumber,
      templateRevision: 'P1',
      fileSha256: file.sha256,
      reportRevisionNo: 0,
    });
  });

  it('AC1/AC2: later source, header, people and machine-register changes leave the file unchanged', async () => {
    await h.db.pool.query(`UPDATE project SET name = 'Renamed Demo Project' WHERE id = $1`, [
      h.projects.a,
    ]);
    await h.db.pool.query(`UPDATE app_user SET display_name = 'Pat Renamed' WHERE id = $1`, [
      h.users.pe,
    ]);
    const header = concreteReportHeaderSchema.parse(
      (await get('/api/concrete/report-header', 'tech')).body,
    );
    expect(
      (
        await send(
          'put',
          '/api/concrete/report-header',
          { version: header.version, companyName: 'Changed Lab Name', address: null, phone: null },
          'admin',
        )
      ).status,
    ).toBe(200);
    const { rows: machine } = await h.db.pool.query<{ id: string; version: number }>(
      `SELECT id, version FROM concrete_equipment WHERE kind = 'testing_machine'`,
    );
    const patched = await send(
      'patch',
      `/api/concrete/testing-machine/${machine[0]!.id}`,
      { version: machine[0]!.version, make: 'Other Instruments', reason: 'Nameplate' },
      'lm',
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const again = await download(`/api/concrete/report-files/${firstFile.id}`, 'tech');
    expect(sha(again.body)).toBe(firstFile.sha256);
    expect(again.body.equals(firstFile.bytes)).toBe(true);
    const text = pdfText(again.body);
    expect(text).toContain('Demo Instruments');
    expect(text).not.toContain('Other Instruments');
    expect(text).not.toContain('Changed Lab Name');
    await h.db.pool.query(`UPDATE app_user SET display_name = 'Pat Example' WHERE id = $1`, [
      h.users.pe,
    ]);
  });

  it('a revision keeps the number and stores Rev 1, linked to Rev 0; the original stays', async () => {
    const revising = await ok('revise', issuedReport, 'pe', {
      comment: 'Ambient temperature misread',
    });
    const fixed = concreteFieldReportDetailSchema.parse(
      (
        await send(
          'patch',
          reportPath(issuedReport.id),
          { idempotencyKey: newKey(), version: revising.version, ambientTempC: -6 },
          'tech',
        )
      ).body,
    );
    const reissued = await ok(
      'issue',
      await ok('review', await ok('submit', fixed, 'tech'), 'pe'),
      'pe',
      { includeMachineInfo: false },
    );
    const all = await versions(issuedReport.id);
    const [v1, v2] = all.filter((v) => v.state === 'issued');
    expect(v2!.issued!.reportNumber).toBe(v1!.issued!.reportNumber);
    expect(v2!.issued!.file).toMatchObject({
      revisionNo: 1,
      supersedesFileId: v1!.issued!.file!.id,
      includeMachineInfo: false,
    });
    expect(v1!.issued!.file!.sha256).toBe(firstFile.sha256);
    const text = pdfText(
      (await download(`/api/concrete/report-files/${v2!.issued!.file!.id}`, 'tech')).body,
    );
    expect(text).toContain('Rev 1, supersedes Rev 0 issued');
    expect(text).toContain('Revision reason: Ambient temperature misread');
    expect(text).toContain('-6 °C');
    expect(text).toContain('Changed Lab Name');
    expect(text).not.toContain('Testing machine');
    expect(reissued.issuance.issueCount).toBe(2);
  });

  it('concurrent first issues take distinct, consecutive numbers', async () => {
    const reviewed = await Promise.all([reviewedReport(), reviewedReport(), reviewedReport()]);
    const before = await h.db.pool.query<{ last_seq: number }>(
      `SELECT last_seq FROM concrete_report_number_counter WHERE report_kind = 'field'`,
    );
    const issued = await Promise.all(reviewed.map((r) => ok('issue', r, 'pe')));
    const seqs = issued
      .map((r) => Number(r.lifecycle.latestVersion!.issued!.reportNumber!.slice(-5)))
      .sort((a, b) => a - b);
    const start = before.rows[0]!.last_seq;
    expect(seqs).toEqual([start + 1, start + 2, start + 3]);
  });

  it('unknown or malformed file ids are 404; anonymous is 401', async () => {
    expect((await get(`/api/concrete/report-files/${randomUUID()}`, 'tech')).status).toBe(404);
    expect((await get('/api/concrete/report-files/not-a-uuid', 'tech')).status).toBe(404);
    expect((await h.http().get(`/api/concrete/report-files/${firstFile.id}`)).status).toBe(401);
  });

  describe('project summary report', () => {
    const summaryPath = (rest = '') =>
      `/api/concrete/projects/${h.projects.a}/summary-reports${rest}`;

    it('previews unnumbered and never stores anything', async () => {
      const before = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM concrete_report_file',
      );
      const preview = await download(summaryPath('/preview'), 'lab');
      expect(preview.status).toBe(200);
      expect(preview.headers['content-type']).toBe('application/pdf');
      const text = pdfText(preview.body);
      expect(text).toContain('PREVIEW — not numbered, not issued');
      expect(text).toContain('Project Concrete Summary Report');
      const after = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM concrete_report_file',
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      expect(
        (await get(summaryPath('/preview?from=2026-12-01&to=2026-11-01'), 'tech')).status,
      ).toBe(422);
    });

    it('issuing needs report.issue on the project; the lead issues a CSR-numbered file', async () => {
      const body = () => ({ idempotencyKey: newKey(), filters: { from: null, to: null } });
      for (const caller of ['tech', 'lm', 'admin', 'lab']) {
        const refused = await send('post', summaryPath(), body(), caller);
        expect(refused.status, caller).toBe(403);
      }
      const list = concreteSummaryReportListSchema.parse((await get(summaryPath(), 'tech')).body);
      expect(list.canIssue).toBe(false);
      expect(
        concreteSummaryReportListSchema.parse((await get(summaryPath(), 'pe')).body).canIssue,
      ).toBe(true);

      const key = newKey();
      const issued = await send('post', summaryPath(), { idempotencyKey: key, filters: {} }, 'pe');
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      const report = concreteSummaryReportSchema.parse(issued.body);
      expect(report.reportNumber).toMatch(new RegExp(`^CSR-${year}-\\d{4}$`));
      expect(report.file).toMatchObject({ kind: 'summary', revisionNo: 0 });
      expect(report.totals.sets).toBe(0);
      // Retry with the same key returns the same report; another body with it is refused.
      const retry = await send('post', summaryPath(), { idempotencyKey: key, filters: {} }, 'pe');
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(report.id);
      const reused = await send(
        'post',
        summaryPath(),
        { idempotencyKey: key, filters: { from: '2026-01-01' } },
        'pe',
      );
      expect(reused.status).toBe(409);
      const file = await download(`/api/concrete/report-files/${report.file.id}`, 'tech');
      expect(sha(file.body)).toBe(report.file.sha256);
      expect(pdfText(file.body)).toContain(report.reportNumber);
      const listed = concreteSummaryReportListSchema.parse((await get(summaryPath(), 'tech')).body);
      expect(listed.items.map((i) => i.id)).toContain(report.id);
    });

    it('review fix #134: an issuer grant revoked before the final check refuses it; nothing is stored', async () => {
      const granted = await send(
        'post',
        `/api/projects/${h.projects.a}/report-issuers`,
        {
          issuerUserId: h.users.js,
          scopeCode: 'concrete_field',
          reason: 'Signs reports while the lead is away',
          idempotencyKey: newKey(),
        },
        'pe',
      );
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      const { rows } = await h.db.pool.query<{ id: string }>(
        `SELECT id FROM project_report_issuer_grant
         WHERE project_id = $1 AND issuer_user_id = $2 AND revoked_at IS NULL`,
        [h.projects.a, h.users.js],
      );
      const stored = async () =>
        (
          await h.db.pool.query(
            `SELECT (SELECT count(*)::int FROM concrete_summary_report) AS summaries,
                    (SELECT count(*)::int FROM concrete_report_file) AS files,
                    (SELECT count(*)::int FROM audit_event
                     WHERE entity_type = 'concrete_summary_report') AS audit`,
          )
        ).rows[0];
      const before = await stored();
      const response = await endGrantDuring(
        h.db.pool,
        REPORT_ISSUER_GRANT,
        rows[0]!.id,
        { userId: h.users.pe, initials: 'PE', displayName: 'Pat Example' },
        () => send('post', summaryPath(), { idempotencyKey: newKey(), filters: {} }, 'js'),
        { revocation_kind: 'ordinary' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(await stored()).toEqual(before);
    });
  });

  describe('report header setting', () => {
    it('admins change it; others are refused; a stale version is 409', async () => {
      const current = concreteReportHeaderSchema.parse(
        (await get('/api/concrete/report-header', 'lab')).body,
      );
      for (const caller of ['tech', 'lm', 'pe', 'lab']) {
        const refused = await send(
          'put',
          '/api/concrete/report-header',
          { version: current.version, companyName: 'Nope', address: null, phone: null },
          caller,
        );
        expect(refused.status, caller).toBe(403);
      }
      const stale = await send(
        'put',
        '/api/concrete/report-header',
        { version: current.version + 5, companyName: 'Stale', address: null, phone: null },
        'admin',
      );
      expect(stale.status).toBe(409);
      const changed = await send(
        'put',
        '/api/concrete/report-header',
        {
          version: current.version,
          companyName: 'Material Mule Testing Laboratory',
          address: '100 Example Street\nEdmonton AB',
          phone: '780-555-0100',
        },
        'admin',
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body).toMatchObject({ version: current.version + 1, phone: '780-555-0100' });
    });
  });
});
