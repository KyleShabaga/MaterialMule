import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  inventoryQuerySchema,
  labProgramListQuerySchema,
  CONCRETE_REVIEW_QUEUE_PAGE_SIZE_MAX,
  INVENTORY_PAGE_SIZE_MAX,
  LAB_PROGRAM_PAGE_SIZE_MAX,
  NEEDS_YOU_SYSTEM_KINDS,
  type InboxRequestItem,
  type NeedsYouItem,
  type NeedsYouResponse,
  type NeedsYouSystemKind,
} from '@materialmule/shared';
import { can, type AuthUser } from '../auth/policy.js';
import { ConcreteHoldsService } from '../concrete/concrete-holds.service.js';
import { ConcreteReviewService } from '../concrete/concrete-review.service.js';
import { ConcreteTestingTableService } from '../concrete/concrete-testing-table.service.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { DisposalService } from '../disposal/disposal.service.js';
import { loadFeed } from '../inbox/inbox-feed.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { dashboardDates, queryFailedLabels } from '../inventory/recently-received.js';
import { LabProgramsService } from '../lab/programs.service.js';
import { involvementSql } from '../project-access/involvement.js';
import { compareNeedsYou, dateSince, idLine, plural, requestRow } from './needs-you.js';

/** Most pages a paged source reads before it stops (a cap, never an expected size). */
const MAX_PAGES = 40;

type ReadyUnit = Awaited<ReturnType<DisposalService['ready']>>['units'][number];

/** One call's shared facts: what the listed requests stand for, and reads used twice. */
interface Covered {
  /** Storage units an open retention request waiting on me is about. */
  retentionUnitIds: Set<string>;
  /** Lab programs an open closure request waiting on me is about. */
  closureProgramIds: Set<string>;
  /** The disposal "ready" list, read once per call when a source needs it. */
  ready: () => Promise<ReadyUnit[]>;
}

type Source = (user: AuthUser, covered: Covered) => Promise<NeedsYouItem | null>;

/**
 * Today's "Needs you" (STRATA-56): the person's Inbox requests waiting on them, plus system work
 * their own account may act on. Every system source reuses its screen's own query and is
 * included only when this account holds the authority for it now (policy.ts and project facts,
 * never a job title). A source that fails is listed in `unavailable`; the rest still return. The
 * requests failing fails the route (they are the Inbox's own feed).
 *
 * Not listed (no clean query exists, so nothing is invented):
 * - `tests_assigned`, `lab_unassigned`: lab tests have no assignee in the data model;
 * - `drafts_old`: the draft registry (migration 0044) records who started a draft and its
 *   deletion, but not its confirmation, so it can't tell which drafts are still unconfirmed.
 */
@Injectable()
export class TodayService {
  private readonly logger = new Logger(TodayService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly review: ConcreteReviewService,
    private readonly holds: ConcreteHoldsService,
    private readonly testing: ConcreteTestingTableService,
    private readonly disposal: DisposalService,
    private readonly programs: LabProgramsService,
    private readonly inventory: InventoryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async needsYou(user: AuthUser): Promise<NeedsYouResponse> {
    const feed = await loadFeed(this.database.pool, user.userId);
    const requests = feed
      .map((entry) => entry.item)
      .filter(
        (item): item is InboxRequestItem =>
          item.type === 'request' && item.status === 'open' && item.waitingOnMe,
      );
    const covered = await this.covered(user, requests);

    const sources: Record<NeedsYouSystemKind, Source | null> = {
      concrete_holds: (u) => this.concreteHolds(u),
      concrete_reviews: (u) => this.concreteReviews(u),
      breaks_due: (u) => this.breaksDue(u),
      tests_assigned: null,
      lab_unassigned: null,
      retention_due: (u, c) => this.retentionDue(u, c),
      disposal_approved: (u, c) => this.disposalApproved(u, c),
      labels_failed: (u) => this.labelsFailed(u),
      drafts_old: null,
      location_conflicts: (u) => this.locationConflicts(u),
      program_finished: (u, c) => this.programFinished(u, c),
    };
    const items: NeedsYouItem[] = requests.map(requestRow);
    const unavailable: NeedsYouSystemKind[] = [];
    // One at a time: each source is a few small reads, and this keeps one request's load on the
    // shared PostgreSQL pool modest.
    for (const kind of NEEDS_YOU_SYSTEM_KINDS) {
      const source = sources[kind];
      if (!source) continue;
      try {
        const item = await source(user, covered);
        if (item) items.push(item);
      } catch (error) {
        // Never the error's values: the kind is enough to find it.
        this.logger.warn(
          `Needs you: the ${kind} source failed (${error instanceof Error ? error.name : 'error'})`,
        );
        unavailable.push(kind);
      }
    }
    items.sort(compareNeedsYou);
    return {
      items,
      total: items.length,
      fromInbox: items.filter((item) => item.source === 'request').length,
      unavailable,
    };
  }

  /** Units and programs the listed requests stand for. */
  private async covered(user: AuthUser, requests: InboxRequestItem[]): Promise<Covered> {
    const retention = requests.filter((r) => r.kind === 'retention_request').map((r) => r.sourceId);
    const retentionUnitIds = new Set<string>();
    if (retention.length > 0) {
      const { rows } = await this.database.pool.query<{ id: string }>(
        `SELECT ru.storage_unit_id AS id
         FROM action_item a
         JOIN retention_request rr ON a.entity_type = 'retention_request' AND rr.id = a.entity_id
         JOIN retention_request_unit ru ON ru.request_id = rr.id
         WHERE a.id = ANY($1::uuid[]) AND rr.scope = 'units'
         UNION
         SELECT su.id
         FROM action_item a
         JOIN retention_request rr ON a.entity_type = 'retention_request' AND rr.id = a.entity_id
         JOIN storage_unit su ON su.project_id = rr.project_id
         WHERE a.id = ANY($1::uuid[]) AND rr.scope = 'project'`,
        [retention],
      );
      for (const row of rows) retentionUnitIds.add(row.id);
    }
    const closureProgramIds = new Set(
      requests
        .filter((r) => r.kind === 'closure_request' && r.record?.kind === 'lab_program')
        .map((r) => r.record!.id),
    );
    let ready: Promise<ReadyUnit[]> | null = null;
    return {
      retentionUnitIds,
      closureProgramIds,
      ready: () => (ready ??= this.readyUnits(user)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Sources, in NEEDS_YOU_SYSTEM_KINDS order.

  /** Lab Manager: concrete specimens on HOLD (the HOLD management table's open list). */
  private async concreteHolds(user: AuthUser): Promise<NeedsYouItem | null> {
    // Without a project only the Lab Manager role grants it (a lead holds it on their project).
    if (!can(user, 'concrete_ordinary_hold.manage')) return null;
    const list = await this.holds.list({ status: 'open' }, user);
    if (list.counts.open === 0) return null;
    const line = idLine(
      list.rows.map((row) => row.identity.permanentId ?? row.identity.temporaryId ?? row.letter),
    );
    return {
      key: 'system:concrete_holds',
      source: 'system',
      task: 'Hold',
      title: `${plural(list.counts.open, 'specimen')} on HOLD`,
      detail: line.text || null,
      ids: line.ids,
      stage: 'danger',
      domain: 'hold',
      action: 'Review holds',
      href: '/lab-testing/concrete/holds',
      count: list.counts.open,
      since: null,
    };
  }

  /**
   * Concrete reports waiting for this person's review: the review queue's own "mine" rows, so
   * its authority rules apply as they are (the lead or a routed designated reviewer, never one's
   * own report).
   */
  private async concreteReviews(user: AuthUser): Promise<NeedsYouItem | null> {
    const queue = await this.review.queue(
      { status: 'awaiting_review', mine: 'true', pageSize: CONCRETE_REVIEW_QUEUE_PAGE_SIZE_MAX },
      user,
    );
    if (queue.total === 0) return null;
    const line = idLine(queue.items.map((row) => row.projectNumber));
    return {
      key: 'system:concrete_reviews',
      source: 'system',
      task: 'Review',
      title: `Review ${plural(queue.total, 'concrete report')}`,
      detail: line.text || null,
      ids: line.ids,
      stage: 'due',
      domain: 'review',
      action: 'Review',
      href: '/concrete/review',
      count: queue.total,
      since: queue.items[0]?.submittedAt ?? null,
    };
  }

  /** Lab staff: today's concrete breaks (the testing table), with how many aren't started. */
  private async breaksDue(user: AuthUser): Promise<NeedsYouItem | null> {
    if (!can(user, 'concrete_test.enter')) return null;
    const table = await this.testing.table({});
    if (table.total === 0) return null;
    const notStarted = table.groups.flatMap((g) => g.rows).filter((r) => r.result === null).length;
    return {
      key: 'system:breaks_due',
      source: 'system',
      task: 'Breaks',
      title: `${plural(table.total, 'break')} due today`,
      detail: notStarted === 0 ? 'All started' : `${notStarted} not started`,
      ids: [],
      stage: 'lab',
      domain: 'breaks',
      action: 'Open breaks',
      href: '/concrete/testing',
      count: table.total,
      since: dateSince(table.today),
    };
  }

  /**
   * The lead: units at the end of retention on projects they lead (the disposal "ready" list's
   * awaiting-approval units), less the units an open retention request waiting on them is about.
   */
  private async retentionDue(user: AuthUser, covered: Covered): Promise<NeedsYouItem | null> {
    // Deciding is retention.manage on the project: its lead (a Lab Manager's lab-wide view is
    // disposal_approved and the Disposal page, not "my projects").
    if (!can(user, 'retention.manage', { leadProjectEngineerUserId: user.userId })) return null;
    const { rows: led } = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM project WHERE lead_project_engineer_user_id = $1',
      [user.userId],
    );
    const ledIds = new Set(led.map((p) => p.id));
    if (ledIds.size === 0) return null;
    const units = (await covered.ready()).filter(
      (u) =>
        u.stage === 'awaiting_approval' &&
        ledIds.has(u.project.id) &&
        !covered.retentionUnitIds.has(u.storageUnitId),
    );
    if (units.length === 0) return null;
    const line = idLine(units.map((u) => u.readableId));
    return {
      key: 'system:retention_due',
      source: 'system',
      task: 'Retention',
      title: `Decide on ${plural(units.length, 'unit')} at end of retention`,
      detail: line.text,
      ids: line.ids,
      stage: 'due',
      domain: 'retention',
      action: 'Decide',
      href: '/disposal-retention',
      count: units.length,
      since: dateSince(units[0]!.effectiveRetainUntil),
    };
  }

  /** Lab Manager: units approved for disposal and not yet removed (the disposal "ready" list). */
  private async disposalApproved(user: AuthUser, covered: Covered): Promise<NeedsYouItem | null> {
    // Without a project only the Lab Manager role grants it; leads approve on their projects.
    if (!can(user, 'disposal.approve')) return null;
    const units = (await covered.ready()).filter((u) => u.stage === 'approved');
    if (units.length === 0) return null;
    const line = idLine(units.map((u) => u.readableId));
    return {
      key: 'system:disposal_approved',
      source: 'system',
      task: 'Disposal',
      title: `${plural(units.length, 'unit')} approved for disposal`,
      detail: line.text,
      ids: line.ids,
      stage: 'due',
      domain: 'disposal',
      action: 'Start disposal',
      href: '/disposal-retention/scan',
      count: units.length,
      since: dateSince(units[0]!.effectiveRetainUntil),
    };
  }

  /** Labels this person asked for whose newest print job failed (the dashboard's newest-job rule). */
  private async labelsFailed(user: AuthUser): Promise<NeedsYouItem | null> {
    if (!can(user, 'label.print')) return null;
    const dates = dashboardDates(new Date(), this.config.BUSINESS_TIME_ZONE);
    const units = await queryFailedLabels(this.database.pool, user.userId, dates.labelsSince);
    if (units.length === 0) return null;
    const line = idLine(units.map((u) => u.readableId));
    const ids = units.slice(0, 50).map((u) => u.readableId);
    return {
      key: 'system:labels_failed',
      source: 'system',
      task: 'Labels',
      title: units.length === 1 ? "A label didn't print" : `${units.length} labels didn't print`,
      detail: line.text,
      ids: line.ids,
      stage: 'due',
      domain: 'receipt',
      action: 'Print again',
      href: `/labels/print/units?${new URLSearchParams({ ids: ids.join(',') }).toString()}`,
      count: units.length,
      since: units[0]!.failedAt.toISOString(),
    };
  }

  /** Lab Manager: units with an open location conflict (Sample Storage's conflict filter). */
  private async locationConflicts(user: AuthUser): Promise<NeedsYouItem | null> {
    // Anyone may settle a conflict (D29); the Lab Manager role is who keeps watch over them.
    if (!user.roles.includes('lab_manager') || !can(user, 'location_conflict.resolve')) {
      return null;
    }
    const page = await this.inventory.query(
      inventoryQuerySchema.parse({ conflict: 'open', pageSize: INVENTORY_PAGE_SIZE_MAX }),
    );
    if (page.total === 0) return null;
    const line = idLine(page.items.map((item) => item.readableId));
    return {
      key: 'system:location_conflicts',
      source: 'system',
      task: 'Location',
      title: `${plural(page.total, 'location check')} ${page.total === 1 ? 'disagrees' : 'disagree'}`,
      detail: line.text,
      ids: line.ids,
      stage: 'danger',
      domain: 'storage',
      action: 'Open',
      href: '/sample-storage?conflict=open',
      count: page.total,
      since: null,
    };
  }

  /**
   * Progress only: lab programs on projects this person is involved in whose lab work is all
   * done (phase "ready", waiting to be closed), less those a closure request waiting on them
   * stands for.
   */
  private async programFinished(user: AuthUser, covered: Covered): Promise<NeedsYouItem | null> {
    const { rows: mine } = await this.database.pool.query<{ project_id: string }>(
      `SELECT DISTINCT i.project_id FROM (${involvementSql('$1')}) i`,
      [user.userId],
    );
    const projects = new Set(mine.map((row) => row.project_id));
    if (projects.size === 0) return null;
    const ready = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const list = await this.programs.list(
        user,
        labProgramListQuerySchema.parse({
          status: 'submitted',
          sort: 'number',
          page,
          pageSize: LAB_PROGRAM_PAGE_SIZE_MAX,
        }),
      );
      ready.push(
        ...list.items.filter(
          (p) =>
            p.phase === 'ready' &&
            projects.has(p.project.id) &&
            !covered.closureProgramIds.has(p.id),
        ),
      );
      if (page * LAB_PROGRAM_PAGE_SIZE_MAX >= list.total) break;
    }
    if (ready.length === 0) return null;
    const line = idLine(ready.map((p) => p.programNumber ?? p.project.projectNumber));
    const one = ready.length === 1 ? ready[0]! : null;
    return {
      key: 'system:program_finished',
      source: 'system',
      task: 'Lab',
      title: one
        ? 'A lab program finished testing'
        : `${ready.length} lab programs finished testing`,
      detail: line.text,
      ids: line.ids,
      stage: 'lab',
      domain: 'lab',
      action: 'Open',
      href: one ? `/lab-testing/programs/${one.id}` : '/lab-testing/programs',
      count: ready.length,
      since: null,
    };
  }

  /** Every unit on the disposal "ready" list, oldest retain-until first. */
  private async readyUnits(user: AuthUser): Promise<ReadyUnit[]> {
    const units: ReadyUnit[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const ready = await this.disposal.ready(user, page);
      units.push(...ready.units);
      if (page * ready.pageSize >= ready.total) break;
    }
    return units;
  }
}
