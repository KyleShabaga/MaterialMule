import {
  BLOCKED_REASON_LABEL,
  CAPABILITY_SOURCE_LABEL,
  PROJECT_CAPABILITY_ACTIONS,
  PROJECT_CAPABILITY_ACTION_LABEL,
  PROJECT_INVOLVEMENT_LABEL,
  type Capability,
  type ProjectCapabilities,
  type ProjectCapabilityAction,
} from '@materialmule/shared';
import { Check, Lock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { shortTime } from '../dashboard/format';
import { TeamCard } from './TeamCard';

// Team & permissions › Your permissions here (STRATA-85, MM-AO05): what the signed-in person can
// do on this project and where it comes from, exactly as the server's capability list says. The
// browser never works out a permission itself.

const KNOWN = new Set<string>(PROJECT_CAPABILITY_ACTIONS);

/** Only the project actions this screen knows how to name, in the server's order. */
// eslint-disable-next-line react-refresh/only-export-components -- shared with the person drawer
export function knownCapabilities(capabilities: Capability[]): Capability[] {
  return capabilities.filter((c) => KNOWN.has(c.action));
}

// eslint-disable-next-line react-refresh/only-export-components -- shared with the person drawer
export function actionLabel(capability: Capability): string {
  return PROJECT_CAPABILITY_ACTION_LABEL[capability.action as ProjectCapabilityAction];
}

/** Where an allowed action comes from ("As Lead Project Engineer"), or why not and who could. */
// eslint-disable-next-line react-refresh/only-export-components -- shared with the person drawer
export function capabilitySource(capability: Capability, own: boolean): string {
  if (capability.allowed) {
    return `As ${capability.sources.map((s) => CAPABILITY_SOURCE_LABEL[s]).join(', ')}`;
  }
  if (!capability.blocked) return 'Not allowed';
  const grantedBy = capability.blocked.grantedBy.map((s) => CAPABILITY_SOURCE_LABEL[s]);
  // The blocked reason is worded for the signed-in person ("Your account isn't active").
  const reason = own ? `${BLOCKED_REASON_LABEL[capability.blocked.code]} ` : '';
  return `${reason}${grantedBy.length ? `Allowed for: ${grantedBy.join(', ')}.` : ''}`.trim();
}

export function CapabilityList({
  capabilities,
  own,
  label,
}: {
  capabilities: Capability[];
  /** The signed-in person's own list (adds the server's reason in their words). */
  own: boolean;
  label: string;
}) {
  const rows = knownCapabilities(capabilities);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No actions reported.</p>;
  }
  return (
    <ItemGroup aria-label={label} className="gap-0">
      {rows.map((row) => (
        <Item key={row.action} role="listitem" size="sm" className="px-0 py-2">
          <ItemMedia>
            {row.allowed ? (
              <Check aria-hidden="true" className="size-4 text-stage-storage-fg" />
            ) : (
              <Lock aria-hidden="true" className="size-4 text-muted-foreground" />
            )}
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="font-normal">
              <span>
                {actionLabel(row)}
                <span className="text-muted-foreground">
                  : {row.allowed ? 'allowed' : 'not allowed'}
                </span>
              </span>
            </ItemTitle>
            <ItemDescription className="line-clamp-none">
              {capabilitySource(row, own)}
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}

export function YourPermissions({
  capabilities,
  checkedAt,
  onRefresh,
}: {
  capabilities: ProjectCapabilities;
  /** When the server last reported it. */
  checkedAt: string;
  onRefresh: () => void;
}) {
  return (
    <TeamCard
      id="team-permissions"
      title="Your permissions here"
      meta={`As the server reports it · checked ${shortTime(checkedAt)}`}
      action={
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      }
    >
      <p className="text-sm">
        {capabilities.involvement.length
          ? `Your part in this project: ${capabilities.involvement
              .map((i) => PROJECT_INVOLVEMENT_LABEL[i])
              .join(', ')}.`
          : 'You have no assignment on this project. You can still see it.'}
      </p>
      {capabilities.reviewerScopes.length ? (
        <p className="text-sm text-muted-foreground">
          You review: {capabilities.reviewerScopes.map((s) => s.label).join(', ')}.
        </p>
      ) : null}
      {capabilities.issuerScopes.length ? (
        <p className="text-sm text-muted-foreground">
          You may issue: {capabilities.issuerScopes.map((s) => s.label).join(', ')}.
        </p>
      ) : null}
      <CapabilityList
        capabilities={capabilities.capabilities}
        own
        label="Your permissions on this project"
      />
    </TeamCard>
  );
}
