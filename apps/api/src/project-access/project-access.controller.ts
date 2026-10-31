import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  ProjectLeadNominations,
  ProjectCapabilities,
  ProjectPeople,
  ProjectGrantReviews,
  ProjectTeamJoinRequests,
  ProjectReportIssuers,
  ProjectReviewers,
  ProjectTeam,
  ReceiverOption,
  ReviewScope,
  StaffGrants,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { GrantReviewsService } from './grant-reviews.service.js';
import { TeamJoinService } from './team-join.service.js';
import { LeadNominationsService } from './lead-nominations.service.js';
import { activeScopes, ProjectAccessService } from './project-access.service.js';
import { StaffGrantsService } from './staff-grants.service.js';

/**
 * Team & permissions (MM-AO03). Reads are open to personal accounts (`project_access.read`; broad
 * internal visibility, LAB 403). Writes are `@ActiveUser()`: the service checks the project-scoped
 * permission against the project as it stands, before reading the body:
 *
 * - team members: `project_team.manage` (the project's Lead Project Engineer or an admin, D04);
 * - reviewer assignments: `project_reviewer.manage` (Lead Project Engineer or admin, D04/D05), to
 *   a person with active eligibility for the scope;
 * - report issuers: `report_issuer.manage` (the project's Lead Project Engineer only; admin never,
 *   D06/D07).
 *
 * Removals and revocations are `DELETE …/:id` with a JSON body holding the reason (D15).
 */
@Controller()
export class ProjectAccessController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly nominations: LeadNominationsService,
    private readonly grantReviews: GrantReviewsService,
    private readonly teamJoin: TeamJoinService,
    private readonly database: DatabaseService,
  ) {}

  // Lead Project Engineer nominations (MM-AO04, D01): nominate (any personal account, project with
  // no lead), confirm and reject (admin, `project.lead_project_engineer.change`), withdraw (the
  // nominator). Each decision needs `{reason}`.

  @Get('projects/:projectId/lead-nominations')
  @RequirePermission('project_access.read')
  leadNominations(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectLeadNominations> {
    return this.nominations.list(projectId, user);
  }

  @Post('projects/:projectId/lead-nominations')
  @RequirePermission('project_lead.nominate')
  nominate(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectLeadNominations> {
    return this.nominations.nominate(projectId, body, user);
  }

  @Post('projects/:projectId/lead-nominations/:id/confirm')
  @HttpCode(200)
  @RequirePermission('project.lead_project_engineer.change')
  confirmNomination(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectLeadNominations> {
    return this.nominations.confirm(projectId, id, body, user);
  }

  @Post('projects/:projectId/lead-nominations/:id/reject')
  @HttpCode(200)
  @RequirePermission('project.lead_project_engineer.change')
  rejectNomination(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectLeadNominations> {
    return this.nominations.reject(projectId, id, body, user);
  }

  @Post('projects/:projectId/lead-nominations/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('project_lead.nominate')
  withdrawNomination(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectLeadNominations> {
    return this.nominations.withdraw(projectId, id, body, user);
  }

  @Get('review-scopes')
  @RequirePermission('project_access.read')
  async scopes(): Promise<ReviewScope[]> {
    return [...(await activeScopes(this.database.pool)).values()];
  }

  /** People eligible to review a scope (MM-AO05 reviewer lookup); `search` narrows it. */
  @Get('review-scopes/:code/eligible-reviewers')
  @RequirePermission('project_access.read')
  eligibleReviewers(
    @Param('code') code: string,
    @Query('search') search?: string,
  ): Promise<ReceiverOption[]> {
    return this.access.eligibleReviewers(
      code.slice(0, 40),
      typeof search === 'string' ? search.slice(0, 100) : undefined,
    );
  }

  @Get('projects/:projectId/capabilities')
  @RequirePermission('project_access.read')
  capabilities(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectCapabilities> {
    return this.access.capabilities(projectId, user);
  }

  // MTR-25: inherited grants flagged for a new lead. Anyone who reads the team sees them; the
  // lead or an admin keeps or revokes each one, with `{reason}`.

  @Get('projects/:projectId/grant-reviews')
  @RequirePermission('project_access.read')
  grantReviewList(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectGrantReviews> {
    return this.grantReviews.list(projectId, user);
  }

  @Post('projects/:projectId/grant-reviews/:reviewId/keep')
  @ActiveUser()
  @HttpCode(200)
  keepGrant(
    @Param('projectId') projectId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectGrantReviews> {
    return this.grantReviews.keep(projectId, reviewId, body, user);
  }

  @Post('projects/:projectId/grant-reviews/:reviewId/revoke')
  @ActiveUser()
  @HttpCode(200)
  revokeGrant(
    @Param('projectId') projectId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectGrantReviews> {
    return this.grantReviews.revoke(projectId, reviewId, body, user);
  }

  // MISC-07: any active personal account joins a team itself (pending LPE acceptance); the lead
  // or an admin accepts, or declines with `{reason}`. LAB reads and asks nothing.

  @Get('projects/:projectId/team-join-requests')
  @RequirePermission('project_access.read')
  teamJoinRequests(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectTeamJoinRequests> {
    return this.teamJoin.list(projectId, user);
  }

  @Post('projects/:projectId/team-join-requests')
  @RequirePermission('project_access.read')
  requestTeamJoin(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectTeamJoinRequests> {
    return this.teamJoin.request(projectId, body, user);
  }

  @Post('projects/:projectId/team-join-requests/:requestId/accept')
  @ActiveUser()
  @HttpCode(200)
  acceptTeamJoin(
    @Param('projectId') projectId: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectTeamJoinRequests> {
    return this.teamJoin.accept(projectId, requestId, body, user);
  }

  @Post('projects/:projectId/team-join-requests/:requestId/decline')
  @ActiveUser()
  @HttpCode(200)
  declineTeamJoin(
    @Param('projectId') projectId: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectTeamJoinRequests> {
    return this.teamJoin.decline(projectId, requestId, body, user);
  }

  /** MTR-21: each person on the project, their job title and permissions here, and why. */
  @Get('projects/:projectId/people')
  @RequirePermission('project_access.read')
  people(@Param('projectId') projectId: string): Promise<ProjectPeople> {
    return this.access.people(projectId);
  }

  @Get('projects/:projectId/team-members')
  @RequirePermission('project_access.read')
  team(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser): Promise<ProjectTeam> {
    return this.access.team(projectId, user);
  }

  @Post('projects/:projectId/team-members')
  @ActiveUser()
  addTeamMember(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectTeam> {
    return this.access.addTeamMember(projectId, body, user);
  }

  @Delete('projects/:projectId/team-members/:id')
  @ActiveUser()
  removeTeamMember(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectTeam> {
    return this.access.removeTeamMember(projectId, id, body, user);
  }

  @Get('projects/:projectId/reviewer-assignments')
  @RequirePermission('project_access.read')
  reviewers(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectReviewers> {
    return this.access.reviewers(projectId, user);
  }

  @Post('projects/:projectId/reviewer-assignments')
  @ActiveUser()
  assignReviewer(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectReviewers> {
    return this.access.assignReviewer(projectId, body, user);
  }

  @Delete('projects/:projectId/reviewer-assignments/:id')
  @ActiveUser()
  removeReviewer(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectReviewers> {
    return this.access.removeReviewer(projectId, id, body, user);
  }

  @Get('projects/:projectId/report-issuers')
  @RequirePermission('project_access.read')
  issuers(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectReportIssuers> {
    return this.access.reportIssuers(projectId, user);
  }

  @Post('projects/:projectId/report-issuers')
  @ActiveUser()
  grantIssuer(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectReportIssuers> {
    return this.access.grantReportIssuer(projectId, body, user);
  }

  @Delete('projects/:projectId/report-issuers/:id')
  @ActiveUser()
  revokeIssuer(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectReportIssuers> {
    return this.access.revokeReportIssuer(projectId, id, body, user);
  }
}

/**
 * Reviewer eligibility (D05) and staff capabilities (D01), MM-AO03. Admin only
 * (`reviewer_eligibility.manage`, `staff_capability.manage`); a person reads their own with
 * `GET /api/me/grants`.
 */
@Controller()
export class StaffGrantsController {
  constructor(private readonly grants: StaffGrantsService) {}

  @Get('me/grants')
  @ActiveUser()
  mine(@CurrentUser() user: AuthUser): Promise<StaffGrants> {
    return this.grants.grants(user.userId, user);
  }

  @Get('staff/:id/grants')
  @RequirePermission('staff.manage')
  list(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<StaffGrants> {
    return this.grants.grants(id, user);
  }

  @Post('staff/:id/reviewer-eligibility')
  @RequirePermission('reviewer_eligibility.manage')
  grantEligibility(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<StaffGrants> {
    return this.grants.grantEligibility(id, body, user);
  }

  @Delete('staff/:id/reviewer-eligibility/:grantId')
  @RequirePermission('reviewer_eligibility.manage')
  revokeEligibility(
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<StaffGrants> {
    return this.grants.revokeEligibility(id, grantId, body, user);
  }

  @Post('staff/:id/capabilities')
  @RequirePermission('staff_capability.manage')
  grantCapability(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<StaffGrants> {
    return this.grants.grantCapability(id, body, user);
  }

  @Delete('staff/:id/capabilities/:grantId')
  @RequirePermission('staff_capability.manage')
  revokeCapability(
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<StaffGrants> {
    return this.grants.revokeCapability(id, grantId, body, user);
  }
}
