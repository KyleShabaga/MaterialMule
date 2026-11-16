import { Injectable, NotFoundException } from '@nestjs/common';
import {
  normalizeUserPreferences,
  type InboxQuery,
  type StationInboxPage,
  type StationInboxSummary,
} from '@materialmule/shared';
import { DatabaseService } from '../database/database.service.js';
import { InboxService } from '../inbox/inbox.service.js';
import { readSetting } from '../me-settings/person-setting-store.js';
import { findActiveStaff } from '../staff-directory/staff-directory.js';

/**
 * The station Inbox (STRATA-27): a picked person's Inbox on a LAB station, only when that person
 * turned on "Show my Inbox on shared LAB computers" (`shareInboxOnStations`), checked on every
 * call. Read-only: the feed is built for the person's user ID (InboxService.pageFor/summaryFor),
 * never by swapping the request's user, so LAB gains none of their roles or permissions anywhere;
 * nothing is cached across people and no read state changes. Item content is never logged.
 */
@Injectable()
export class StationInboxService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inbox: InboxService,
  ) {}

  async page(personId: string, query: InboxQuery): Promise<StationInboxPage> {
    const { person, shared } = await this.consent(personId);
    if (!shared) return { state: 'private', person };
    return { state: 'shared', person, page: await this.inbox.pageFor(person.userId, query) };
  }

  async summary(personId: string): Promise<StationInboxSummary> {
    const { person, shared } = await this.consent(personId);
    if (!shared) return { state: 'private', person };
    return { state: 'shared', person, summary: await this.inbox.summaryFor(person.userId) };
  }

  /** The person (active staff only, else 404 with no detail) and whether they share. */
  private async consent(personId: string) {
    const staff = await findActiveStaff(this.database.pool, personId);
    if (!staff) throw new NotFoundException({ code: 'person_not_found' });
    const stored = await readSetting(this.database.pool, staff.id, 'preferences');
    const shared =
      stored.value !== null && normalizeUserPreferences(stored.value).shareInboxOnStations === true;
    return { person: { userId: staff.id, name: staff.displayName }, shared };
  }
}
