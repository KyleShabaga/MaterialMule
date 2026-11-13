import type { AccessSummary, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { AccessPanel } from './AccessPanel';

// MM-AO06 / STRATA-101: My access as the server reports it, the "isn't available to you" notice,
// and the shared LAB account described read-only. Fictional people only.

const PAT = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-js',
  displayName: 'Jordan Smith',
  initials: 'JS',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read', 'project_access.read', 'receipt.confirm', 'label.print'],
  sessionExpiresAt: '2026-11-12T23:00:00.000Z',
  ...overrides,
});

const SUMMARY: AccessSummary = {
  userId: 'u-js',
  displayName: 'Jordan Smith',
  initials: 'JS',
  accountType: 'personal',
  status: 'active',
  effectiveJobTitle: { value: 'Senior Technician', source: 'override' },
  roles: ['lab_technician'],
  reviewerEligibility: [],
  capabilities: [],
  projects: [
    {
      project: { id: 'p-a', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
      lead: false,
      teamMember: { since: '2026-10-29T15:00:00.000Z', by: PAT, reason: 'Supporting engineer' },
      reviewer: [],
      acceptanceDelegate: null,
      reportIssuer: [],
      pendingLeadNomination: false,
    },
  ],
  projectsTotal: 1,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(handler: (url: string) => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return handler(String(input));
    }),
  );
  return urls;
}

function renderPanel(user = me(), blockedSection?: string) {
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <MemoryRouter>
        <AccessPanel blockedSection={blockedSection} />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings › My access (STRATA-101)', () => {
  it('lists roles, what the person can do with its source, and project access', async () => {
    stub(() => json(200, SUMMARY));
    renderPanel();

    expect(screen.getByRole('heading', { name: 'My access' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'App roles' })).getByText('Lab Technician'),
    ).toBeInTheDocument();
    const what = document.querySelector('dl[aria-label="What you can do"]');
    expect(what).toHaveTextContent('Receive samples and issue IDs');
    expect(what).toHaveTextContent('From: Lab Technician role');
    expect(screen.getByText('Print labels')).toBeInTheDocument();
    expect(screen.queryByText('Approve disposal')).not.toBeInTheDocument();

    const projects = await screen.findByRole('link', { name: 'DEMO-2601' });
    expect(projects).toHaveAttribute('href', '/projects/p-a');
    expect(screen.getByText(/Responsibilities: Team member/)).toBeInTheDocument();
    expect(screen.getByText('From: Project team, DEMO-2601')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opened from a hidden section: says it isn’t available and explains My access', async () => {
    stub(() => json(200, SUMMARY));
    renderPanel(me(), 'Staff');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Staff isn’t available to you.');
    expect(alert).toHaveTextContent(
      'Settings opened on My access instead. It shows what you can do and where each part comes from.',
    );
    await screen.findByRole('link', { name: 'DEMO-2601' });
  });

  it('LAB: describes the shared account from the session and never asks for personal access', () => {
    const urls = stub(() => json(403, { code: 'forbidden' }));
    renderPanel(
      me({
        id: 'lab',
        displayName: 'LAB',
        initials: null,
        accountType: 'shared_lab',
        roles: [],
        permissions: ['inventory.read', 'receipt.confirm'],
      }),
    );

    expect(screen.getByText('Shared LAB account')).toBeInTheDocument();
    expect(screen.getByText('Receive samples and issue IDs')).toBeInTheDocument();
    expect(screen.getAllByText('From: Shared LAB account').length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'App roles' })).not.toBeInTheDocument();
    expect(urls).toEqual([]);
  });
});
