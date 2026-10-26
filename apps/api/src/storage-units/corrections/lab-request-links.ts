import { Injectable } from '@nestjs/common';
import type { LabRequestLink } from '@trapezoid/shared';
import type { PoolClient } from 'pg';

/**
 * Finds lab requests that still reference a storage unit and aren't resolved. A project
 * correction is refused while any exist (D47): the links must be resolved first.
 */
export interface LabRequestLinkChecker {
  /** Called inside the correction transaction, after the unit row is locked. */
  unresolvedLinks(client: PoolClient, storageUnitId: string): Promise<LabRequestLink[]>;
}

export const LAB_REQUEST_LINK_CHECKER = Symbol('LabRequestLinkChecker');

/** Lab requests don't exist until TRP-T23, so nothing can be linked yet. */
@Injectable()
export class NoLabRequestLinks implements LabRequestLinkChecker {
  unresolvedLinks(): Promise<LabRequestLink[]> {
    return Promise.resolve([]);
  }
}
