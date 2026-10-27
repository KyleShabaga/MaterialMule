// Development/test-only sign-in identities (MM-T33). IDs and keys must match seed/dev.sql.
// These are fictional people; none has a Microsoft account, password or token.

export interface TestFixture {
  key: string;
  userId: string;
  summary: string;
}

export const TEST_FIXTURES: readonly TestFixture[] = [
  {
    key: 'admin',
    userId: '00000000-0000-4000-8000-000000000103',
    summary: 'Admin: staff and sessions; no project authority',
  },
  {
    key: 'lab',
    userId: '00000000-0000-4000-8000-000000000104',
    summary: 'Lab Manager role; no PM/PE assignment or delegation',
  },
  { key: 'at', userId: '00000000-0000-4000-8000-000000000102', summary: 'Technician' },
  { key: 'pe', userId: '00000000-0000-4000-8000-000000000101', summary: 'PM/PE of DEMO-2601' },
  {
    key: 'de',
    userId: '00000000-0000-4000-8000-000000000105',
    summary: 'Engineer (later an acceptance delegate)',
  },
  {
    key: 'js-tech',
    userId: '00000000-0000-4000-8000-000000000106',
    summary: 'Technician sharing the initials JS',
  },
  {
    key: 'js-eng',
    userId: '00000000-0000-4000-8000-000000000107',
    summary: 'Engineer sharing the initials JS',
  },
];
