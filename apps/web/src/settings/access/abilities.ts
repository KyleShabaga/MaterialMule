/**
 * Global permissions in plain words, for My access. `me.permissions` is what the session reports
 * for showing or hiding the interface; project-scoped authority (concrete review, mixes, holds)
 * is never global and is listed per project instead.
 */
export const GLOBAL_ABILITIES: readonly { permission: string; what: string; note: string }[] = [
  {
    permission: 'receipt.confirm',
    what: 'Receive samples and issue IDs',
    note: 'Start, edit and confirm deliveries.',
  },
  { permission: 'storage_unit.move', what: 'Move units', note: 'Any unit, any location.' },
  { permission: 'label.print', what: 'Print labels', note: 'Unit and location labels.' },
  {
    permission: 'location.manage',
    what: 'Manage locations',
    note: 'Add, change and retire locations.',
  },
  {
    permission: 'test_catalog.manage',
    what: 'Manage tests and templates',
    note: 'The lab test catalogue.',
  },
  {
    permission: 'retention.manage',
    what: 'Extend retention and place holds',
    note: 'With a reason each time.',
  },
  { permission: 'disposal.approve', what: 'Approve disposal', note: 'With a reason each time.' },
  {
    permission: 'concrete_settings.testing_machine.manage',
    what: 'Change concrete equipment',
    note: 'Testing machine and air meters.',
  },
  {
    permission: 'concrete_settings.supplier.manage',
    what: 'Change concrete suppliers',
    note: 'Suppliers and their plants.',
  },
  {
    permission: 'concrete_settings.holiday.manage',
    what: 'Change the holiday calendar',
    note: 'Used to flag break dates.',
  },
  {
    permission: 'concrete_settings.report_header.manage',
    what: 'Change the report header',
    note: 'Printed on issued concrete reports.',
  },
  { permission: 'printer.manage', what: 'Manage printers', note: 'Label printers and tests.' },
  {
    permission: 'settings.drafts.manage',
    what: 'Change the receiving draft rule',
    note: 'When unfinished drafts are deleted.',
  },
  {
    permission: 'staff.manage',
    what: 'Manage staff and access',
    note: 'Lab Managers and administrators.',
  },
  {
    permission: 'admin_role.manage',
    what: 'Make or remove administrators',
    note: 'Administrators only.',
  },
  {
    permission: 'lab_account.manage',
    what: 'Manage the shared LAB account',
    note: 'Administrators only.',
  },
  { permission: 'feedback.read', what: 'Read Feedback & bugs', note: 'Administrators only.' },
  { permission: 'system.status.read', what: 'See system status', note: 'Administrators only.' },
];
