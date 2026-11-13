import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { newDraft } from '../draft';
import { useReceiptDraft, type DraftRegistryClient } from '../useReceiptDraft';
import { DraftDeleteError } from './ownership';
import { newRecord, type StoredDraft } from './record';
import { indexedDbDraftStore as store } from './store';

// STRATA-108 in the draft hook: ownership is registered after the first stored save (metadata
// only), never for a legacy draft, and a person's delete asks the server before the local copy
// goes. Fictional people only.

const PAT = { id: '00000000-0000-4000-8000-000000000101', accountType: 'personal' as const };

function registry(overrides: Partial<DraftRegistryClient> = {}): DraftRegistryClient {
  return {
    register: vi.fn(async (draftId: string) => ({
      draftId,
      registered: true,
      starter: { userId: PAT.id, initials: 'PE', name: 'Pat Example' },
      startedOnStation: false,
      createdAt: new Date().toISOString(),
      deletedAt: null,
      canDelete: true,
      reason: 'starter' as const,
    })),
    authorizeDelete: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mount(record: StoredDraft, client: DraftRegistryClient) {
  return renderHook(() =>
    useReceiptDraft(record, { accountId: PAT.id, persisted: false, registry: client }),
  );
}

describe('draft ownership in useReceiptDraft (STRATA-108)', () => {
  it('registers once after the first save and stores when it was registered', async () => {
    const client = registry();
    const record = newRecord(newDraft(null, '2026-11-12'), PAT);
    const { result } = mount(record, client);
    act(() => result.current.update((d) => ({ ...d, description: 'Two buckets' })));
    await act(() => result.current.flush());
    await waitFor(() => expect(result.current.record.registeredAt).not.toBeNull());
    expect(client.register).toHaveBeenCalledTimes(1);
    expect(client.register).toHaveBeenCalledWith(record.draftId, undefined);
    // Only metadata is sent: the draft ID (and, on LAB, the person).
    expect(JSON.stringify(vi.mocked(client.register).mock.calls)).not.toContain('Two buckets');
    await waitFor(async () => expect((await store.get(record.draftId))?.registeredAt).toBeTruthy());
    act(() => result.current.update((d) => ({ ...d, description: 'Three buckets' })));
    await act(() => result.current.flush());
    expect(client.register).toHaveBeenCalledTimes(1);
  });

  it('never registers a legacy draft', async () => {
    const client = registry();
    const record = { ...newRecord(newDraft(null, '2026-11-12'), PAT), legacy: true, starter: null };
    const { result } = mount(record, client);
    act(() => result.current.update((d) => ({ ...d, description: 'Old draft' })));
    await act(() => result.current.flush());
    expect(client.register).not.toHaveBeenCalled();
  });

  it('a refused delete keeps the draft; an authorized one removes it', async () => {
    const refuse = registry({
      authorizeDelete: vi.fn(async () => {
        throw new DraftDeleteError(
          'refused',
          'Only Jordan Lab or a Lab Manager can delete this draft.',
        );
      }),
    });
    const record = newRecord(newDraft(null, '2026-11-12'), PAT);
    await store.put(record);
    const first = mount(record, refuse);
    await expect(act(() => first.result.current.discard())).rejects.toBeInstanceOf(
      DraftDeleteError,
    );
    expect(await store.get(record.draftId)).not.toBeNull();
    first.unmount();

    const allow = registry();
    const second = mount(record, allow);
    await act(() => second.result.current.discard());
    expect(allow.authorizeDelete).toHaveBeenCalledWith(record.draftId, null);
    expect(await store.get(record.draftId)).toBeNull();
  });
});
