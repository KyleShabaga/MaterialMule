// Merging Microsoft profile data into the app user (TRP-T05). Pure, so the rules are unit tested.
// - A successful Graph read is the truth, including fields that are now blank.
// - A failed read never overwrites a known value: the last known profile stays.
// - Official initials are confirmed by an admin and are never set or changed here.

/** The fields read from Microsoft Graph `GET /v1.0/me` (an explicit $select). */
export interface GraphProfile {
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
}

export const GRAPH_SELECT = [
  'displayName',
  'givenName',
  'surname',
  'mail',
  'userPrincipalName',
  'jobTitle',
  'department',
  'officeLocation',
] as const;

/** Profile columns on app_user that Microsoft data may fill. */
export interface ProfileFields {
  display_name: string;
  given_name: string | null;
  surname: string | null;
  work_email: string | null;
  sign_in_username: string | null;
  job_title: string | null;
  department: string | null;
  office_location: string | null;
}

export type ProfileSourceValue = 'microsoft_graph' | 'microsoft_id_token';

export interface IdentityClaims {
  name: string | null;
  preferredUsername: string | null;
}

export interface MergeResult {
  fields: ProfileFields;
  /** Null when nothing new was learned (a failed refresh of a known user). */
  source: ProfileSourceValue | null;
  /** Changed fields only, for the audit event. */
  changes: { before: Partial<ProfileFields>; after: Partial<ProfileFields> };
}

const LIMITS: Record<keyof ProfileFields, number> = {
  display_name: 200,
  given_name: 100,
  surname: 100,
  work_email: 320,
  sign_in_username: 320,
  job_title: 200,
  department: 200,
  office_location: 200,
};

function clean(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

export function mergeProfile(
  stored: ProfileFields | null,
  graph: GraphProfile | null,
  identity: IdentityClaims,
): MergeResult {
  let fields: ProfileFields;
  let source: ProfileSourceValue | null;

  if (graph) {
    fields = {
      display_name:
        clean(graph.displayName, LIMITS.display_name) ??
        clean(identity.name, LIMITS.display_name) ??
        stored?.display_name ??
        clean(identity.preferredUsername, LIMITS.display_name) ??
        'Microsoft user',
      given_name: clean(graph.givenName, LIMITS.given_name),
      surname: clean(graph.surname, LIMITS.surname),
      work_email: clean(graph.mail, LIMITS.work_email),
      sign_in_username:
        clean(graph.userPrincipalName, LIMITS.sign_in_username) ??
        clean(identity.preferredUsername, LIMITS.sign_in_username) ??
        stored?.sign_in_username ??
        null,
      job_title: clean(graph.jobTitle, LIMITS.job_title),
      department: clean(graph.department, LIMITS.department),
      office_location: clean(graph.officeLocation, LIMITS.office_location),
    };
    source = 'microsoft_graph';
  } else if (stored) {
    fields = { ...stored };
    source = null;
  } else {
    // First sign-in and Graph failed: start from the ID token so the person can still get in.
    fields = {
      display_name:
        clean(identity.name, LIMITS.display_name) ??
        clean(identity.preferredUsername, LIMITS.display_name) ??
        'Microsoft user',
      given_name: null,
      surname: null,
      work_email: null,
      sign_in_username: clean(identity.preferredUsername, LIMITS.sign_in_username),
      job_title: null,
      department: null,
      office_location: null,
    };
    source = 'microsoft_id_token';
  }

  const before: Partial<ProfileFields> = {};
  const after: Partial<ProfileFields> = {};
  for (const key of Object.keys(fields) as (keyof ProfileFields)[]) {
    const previous = stored ? stored[key] : null;
    if (previous !== fields[key]) {
      (before as Record<string, unknown>)[key] = previous;
      (after as Record<string, unknown>)[key] = fields[key];
    }
  }
  return { fields, source, changes: { before, after } };
}
