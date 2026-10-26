import { GRAPH_SELECT, type GraphProfile } from '../../../profile/profile-merge.js';

export class GraphProfileError extends Error {
  constructor(readonly status: number | null) {
    super(status ? `Microsoft Graph answered HTTP ${status}` : 'Microsoft Graph unreachable');
    this.name = 'GraphProfileError';
  }
}

const field = (body: Record<string, unknown>, key: string): string | null =>
  typeof body[key] === 'string' ? (body[key] as string) : null;

/**
 * Reads the signed-in user's own profile: `GET /v1.0/me` with an explicit `$select`, using the
 * delegated `User.Read` token. Nothing else is read from Graph.
 */
export async function fetchGraphProfile(
  graphBaseUrl: string,
  accessToken: string,
): Promise<GraphProfile> {
  let response: Response;
  try {
    response = await fetch(`${graphBaseUrl}/v1.0/me?$select=${GRAPH_SELECT.join(',')}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GraphProfileError(null);
  }
  if (!response.ok) {
    throw new GraphProfileError(response.status);
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    displayName: field(body, 'displayName'),
    givenName: field(body, 'givenName'),
    surname: field(body, 'surname'),
    mail: field(body, 'mail'),
    userPrincipalName: field(body, 'userPrincipalName'),
    jobTitle: field(body, 'jobTitle'),
    department: field(body, 'department'),
    officeLocation: field(body, 'officeLocation'),
  };
}
