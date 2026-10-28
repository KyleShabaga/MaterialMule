import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createTestGroupRequestSchema,
  createTestSubgroupRequestSchema,
  createTestTemplateRequestSchema,
  createTestTypeRequestSchema,
  updateTestGroupRequestSchema,
  updateTestSubgroupRequestSchema,
  updateTestTemplateRequestSchema,
  updateTestTypeRequestSchema,
  versionedRequestSchema,
  type TestCatalogue,
  type TestGroup,
  type TestSubgroup,
  type TestTemplate,
  type TestType,
} from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { CatalogueService } from './catalogue.service.js';

/**
 * Lab test catalogue and templates (MM-T23). Everyone who enters programs reads them (LAB too);
 * changes need `test_catalog.manage` (Lab Manager and admin). 409 `version_conflict` (with the
 * current record), `test_code_exists`, `test_group_exists`, `test_subgroup_exists`,
 * `test_template_exists`; 422 `subgroup_not_in_group`, `test_group_not_found`, `retired_tests`.
 */
@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('test-catalogue')
  @RequirePermission('lab_program.read')
  read(): Promise<TestCatalogue> {
    return this.catalogue.catalogue();
  }

  @Get('test-types')
  @RequirePermission('lab_program.read')
  async testTypes(): Promise<TestType[]> {
    return (await this.catalogue.catalogue()).tests;
  }

  @Post('test-groups')
  @RequirePermission('test_catalog.manage')
  createGroup(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<TestGroup> {
    return this.catalogue.createGroup(parseBody(createTestGroupRequestSchema, body), user);
  }

  @Patch('test-groups/:id')
  @RequirePermission('test_catalog.manage')
  updateGroup(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.catalogue.updateGroup(id, parseBody(updateTestGroupRequestSchema, body), user);
  }

  @Post('test-subgroups')
  @RequirePermission('test_catalog.manage')
  createSubgroup(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<TestSubgroup> {
    return this.catalogue.createSubgroup(parseBody(createTestSubgroupRequestSchema, body), user);
  }

  @Patch('test-subgroups/:id')
  @RequirePermission('test_catalog.manage')
  updateSubgroup(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.catalogue.updateSubgroup(
      id,
      parseBody(updateTestSubgroupRequestSchema, body),
      user,
    );
  }

  @Post('test-types')
  @RequirePermission('test_catalog.manage')
  createTestType(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<TestType> {
    return this.catalogue.createTestType(parseBody(createTestTypeRequestSchema, body), user);
  }

  @Patch('test-types/:id')
  @RequirePermission('test_catalog.manage')
  updateTestType(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<TestType> {
    return this.catalogue.updateTestType(id, parseBody(updateTestTypeRequestSchema, body), user);
  }

  @Post('test-types/:id/retire')
  @HttpCode(200)
  @RequirePermission('test_catalog.manage')
  retireTestType(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { version } = parseBody(versionedRequestSchema, body);
    return this.catalogue.setTestTypeActive(id, version, false, user);
  }

  @Post('test-types/:id/restore')
  @HttpCode(200)
  @RequirePermission('test_catalog.manage')
  restoreTestType(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { version } = parseBody(versionedRequestSchema, body);
    return this.catalogue.setTestTypeActive(id, version, true, user);
  }

  @Get('test-templates')
  @RequirePermission('lab_program.read')
  templates(): Promise<TestTemplate[]> {
    return this.catalogue.listTemplates();
  }

  @Post('test-templates')
  @RequirePermission('test_catalog.manage')
  createTemplate(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<TestTemplate> {
    return this.catalogue.createTemplate(parseBody(createTestTemplateRequestSchema, body), user);
  }

  @Patch('test-templates/:id')
  @RequirePermission('test_catalog.manage')
  updateTemplate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<TestTemplate> {
    return this.catalogue.updateTemplate(
      id,
      parseBody(updateTestTemplateRequestSchema, body),
      user,
    );
  }

  @Post('test-templates/:id/retire')
  @HttpCode(200)
  @RequirePermission('test_catalog.manage')
  retireTemplate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { version } = parseBody(versionedRequestSchema, body);
    return this.catalogue.setTemplateActive(id, version, false, user);
  }

  @Post('test-templates/:id/restore')
  @HttpCode(200)
  @RequirePermission('test_catalog.manage')
  restoreTemplate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { version } = parseBody(versionedRequestSchema, body);
    return this.catalogue.setTemplateActive(id, version, true, user);
  }
}
