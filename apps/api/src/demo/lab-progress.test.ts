import { nextReviewState, type ReviewState } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { bringTo, type Crew, type LabActor, type Target } from './lab-progress.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PROGRAM = 'program-1';
const ORDER = ['requested', 'in_progress', 'completed', 'review'];

interface FakeRequest {
  id: string;
  code: string;
  status: string;
  reviewState: ReviewState | null;
  version: number;
}

/**
 * A simulated lab API with the server's status and review rules. `stopAfter(path)` makes the
 * next request to `path` succeed on the server and then fail, as an interrupted run would.
 */
class FakeLabApi {
  readonly requests = new Map<string, FakeRequest>();
  readonly calls: string[] = [];
  private stopOn: string | null = null;
  closed = false;

  constructor(codes: string[]) {
    for (const code of codes) {
      this.requests.set(`tr-${code}`, {
        id: `tr-${code}`,
        code,
        status: 'requested',
        reviewState: null,
        version: 1,
      });
    }
  }

  stopAfter(suffix: string) {
    this.stopOn = suffix;
  }

  /** The program detail as `ensureProgram` returns it (no review sub-state). */
  program(): Json {
    return {
      id: PROGRAM,
      lines: [
        {
          coverage: [{ included: true, unitType: 'bucket', storageUnitId: 'u-1' }],
          requests: [...this.requests.values()].map((r) => ({
            id: r.id,
            code: r.code,
            status: r.status,
            version: r.version,
          })),
        },
      ],
    };
  }

  actor(): LabActor {
    return {
      get: (path) => Promise.resolve(this.get(path)),
      post: (path, body) => Promise.resolve(this.post(path, (body ?? {}) as Json)),
    };
  }

  close() {
    if (![...this.requests.values()].every((r) => r.status === 'accepted')) {
      throw new Error('program has unresolved tests');
    }
    this.closed = true;
  }

  private get(path: string): Json {
    if (path === `/lab-programs/${PROGRAM}/work`) {
      return {
        requests: [...this.requests.values()].map((r) => ({
          testRequestId: r.id,
          status: r.status,
          version: r.version,
          reviewState: r.reviewState,
        })),
      };
    }
    throw new Error(`unexpected GET ${path}`);
  }

  private post(path: string, body: Json): Json {
    const [, , id, action] = path.split('/');
    const request = this.requests.get(id!);
    if (!request) throw new Error(`unexpected POST ${path}`);
    if (body.version !== request.version) throw new Error(`409 version conflict on ${path}`);
    this.calls.push(`${request.code} ${action}${body.action ? `:${body.action}` : ''}`);
    if (action === 'status') {
      if (ORDER.indexOf(body.to) !== ORDER.indexOf(request.status) + 1) {
        throw new Error(`422 ${request.status} → ${body.to}`);
      }
      request.status = body.to;
      request.reviewState = body.to === 'review' ? 'awaiting_review' : null;
    } else if (action === 'review') {
      const to = request.reviewState && nextReviewState(request.reviewState, body.action);
      if (request.status !== 'review' || !to) throw new Error(`422 review ${body.action}`);
      request.reviewState = to;
    } else if (action === 'accept') {
      if (request.reviewState !== 'review_complete') throw new Error('422 review_not_complete');
      request.status = 'accepted';
      request.reviewState = null;
    } else {
      throw new Error(`unexpected POST ${path}`);
    }
    request.version += 1;
    const result = { status: request.status, reviewState: request.reviewState };
    if (this.stopOn && path.endsWith(this.stopOn)) {
      this.stopOn = null;
      throw new Error('interrupted');
    }
    return { ...result, version: request.version };
  }
}

function crewOf(api: FakeLabApi): Crew {
  return { tech: api.actor(), reviewer: api.actor(), lead: api.actor() };
}

const bring = (api: FakeLabApi, code: string, target: Target) =>
  bringTo(api.program(), 0, code, target, crewOf(api));

describe('demo seed: bringTo resumes from the review sub-state', () => {
  it('reaches accepted from scratch with one review decision and one acceptance', async () => {
    const api = new FakeLabApi(['MC']);
    await bring(api, 'MC', 'accepted');
    expect(api.calls).toEqual([
      'MC status',
      'MC status',
      'MC status',
      'MC review:complete',
      'MC accept',
    ]);
    expect(api.requests.get('tr-MC')).toMatchObject({ status: 'accepted' });
  });

  it('finishes review and acceptance after a run stopped right after entering review', async () => {
    const api = new FakeLabApi(['MC', 'VI']);
    await bring(api, 'MC', 'completed');
    // The move into review succeeds on the server, then the run stops.
    api.stopAfter('tr-MC/status');
    await expect(bring(api, 'MC', 'accepted')).rejects.toThrow('interrupted');
    expect(api.requests.get('tr-MC')).toMatchObject({
      status: 'review',
      reviewState: 'awaiting_review',
    });

    api.calls.length = 0;
    await bring(api, 'MC', 'accepted');
    expect(api.calls).toEqual(['MC review:complete', 'MC accept']);
    expect(api.requests.get('tr-MC')).toMatchObject({ status: 'accepted' });

    await bring(api, 'VI', 'accepted');
    api.close();
    expect(api.closed).toBe(true);
  });

  it('accepts after a run stopped between review complete and acceptance', async () => {
    const api = new FakeLabApi(['MC']);
    api.stopAfter('tr-MC/review');
    await expect(bring(api, 'MC', 'accepted')).rejects.toThrow('interrupted');
    expect(api.requests.get('tr-MC')).toMatchObject({ reviewState: 'review_complete' });

    api.calls.length = 0;
    await bring(api, 'MC', 'accepted');
    expect(api.calls).toEqual(['MC accept']);
    api.close();
    expect(api.closed).toBe(true);
  });

  it('returns a test stopped in review once, and leaves a returned test alone', async () => {
    const api = new FakeLabApi(['MC']);
    await bring(api, 'MC', 'review');
    api.calls.length = 0;
    await bring(api, 'MC', 'returned');
    expect(api.calls).toEqual(['MC review:return']);
    expect(api.requests.get('tr-MC')).toMatchObject({ reviewState: 'returned' });

    api.calls.length = 0;
    await bring(api, 'MC', 'returned');
    await bring(api, 'MC', 'accepted');
    expect(api.calls).toEqual([]);
  });

  it('does nothing for an accepted test or one already at its target', async () => {
    const api = new FakeLabApi(['MC', 'SA']);
    await bring(api, 'MC', 'accepted');
    await bring(api, 'SA', 'in_progress');
    api.calls.length = 0;
    await bring(api, 'MC', 'accepted');
    await bring(api, 'SA', 'in_progress');
    expect(api.calls).toEqual([]);
  });
});
