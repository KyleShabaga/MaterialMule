import { UnprocessableEntityException } from '@nestjs/common';
import type { PersonSnapshot } from '@materialmule/shared';
import type { PoolClient } from 'pg';
import type { AuditActor, AuditReceiver } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { validationError } from '../validation/parse-body.js';

// "LAB for person" attribution (MM-T23/T24). A shared LAB station names the staff member doing
// each action; a personal account is always its own person. The person is attribution only: it
// grants nothing, and their roles are never borrowed. It is checked on every action, so a person
// disabled since the station chose them is refused on the next request.

export function actorOf(user: AuthUser): AuditActor {
  return {
    userId: user.userId,
    accountType: user.accountType,
    initials: user.initials,
    name: user.displayName,
  };
}

export function receiverOf(person: PersonSnapshot): AuditReceiver {
  return { userId: person.userId, initials: person.initials, name: person.name };
}

/**
 * The person an action is attributed to. LAB must send `personUserId` (400
 * `<field>`/required when missing, 422 `invalid_code` when it isn't an active staff member with
 * confirmed initials). A personal account may omit it or send its own ID; anyone else is refused,
 * because only a shared station chooses who is acting.
 */
export async function resolveActingPerson(
  client: PoolClient,
  user: AuthUser,
  personUserId: string | undefined,
  options: { field: string; invalidCode: string },
): Promise<PersonSnapshot> {
  if (user.accountType !== 'shared_lab') {
    if (personUserId !== undefined && personUserId !== user.userId) {
      throw validationError([
        {
          field: options.field,
          code: 'not_allowed',
          message: 'only a shared LAB station chooses who is acting',
        },
      ]);
    }
    return { userId: user.userId, initials: user.initials, name: user.displayName };
  }
  if (personUserId === undefined) {
    throw validationError([
      { field: options.field, code: 'required', message: 'choose who is doing this' },
    ]);
  }
  const { rows } = await client.query<{
    id: string;
    display_name: string;
    official_initials: string | null;
  }>(
    `SELECT id, display_name, official_initials FROM app_user
     WHERE id = $1 AND status = 'active' AND account_type <> 'shared_lab'
     FOR SHARE`,
    [personUserId],
  );
  const row = rows[0];
  if (!row || !row.official_initials) {
    throw new UnprocessableEntityException({
      code: options.invalidCode,
      errors: [
        {
          field: options.field,
          code: options.invalidCode,
          message: 'must be an active staff member with confirmed initials',
        },
      ],
    });
  }
  return { userId: row.id, initials: row.official_initials, name: row.display_name };
}
