import { describe, expect, it } from 'vitest';
import {
  CONCRETE_NOTIFICATION_KINDS,
  NOTIFICATION_KINDS,
  concreteNotificationRecipients,
  isConcreteNotificationKind,
  notificationSchema,
} from './notifications';

// MM-V2-C29 T1: recipient and de-duplication rules for concrete notifications (fictional ids).
const tech = 'tech-1';
const lm = 'lm-1';
const lm2 = 'lm-2';
const reviewer = 'rev-1';
const lead = 'lead-1';

describe('concreteNotificationRecipients', () => {
  it('returned: the technician and the Lab Managers', () => {
    expect(
      concreteNotificationRecipients('concrete_report.returned', {
        actorUserId: reviewer,
        technicianUserId: tech,
        labManagerUserIds: [lm, lm2],
      }),
    ).toEqual([tech, lm, lm2]);
  });

  it('AC1: a Lab Manager who returns the report gets no separate Lab Manager notice', () => {
    expect(
      concreteNotificationRecipients('concrete_report.returned', {
        actorUserId: lm,
        technicianUserId: tech,
        labManagerUserIds: [lm],
      }),
    ).toEqual([tech]);
  });

  it('AC2: a technician who is also a Lab Manager gets one notice', () => {
    expect(
      concreteNotificationRecipients('concrete_report.returned', {
        actorUserId: reviewer,
        technicianUserId: lm,
        labManagerUserIds: [lm, lm],
      }),
    ).toEqual([lm]);
  });

  it('never notifies the person who caused the event', () => {
    expect(
      concreteNotificationRecipients('concrete_report.returned', {
        actorUserId: tech,
        technicianUserId: tech,
        labManagerUserIds: [],
      }),
    ).toEqual([]);
    expect(
      concreteNotificationRecipients('concrete_test.failed', {
        actorUserId: reviewer,
        designatedReviewerUserIds: [reviewer],
        leadProjectEngineerUserId: lead,
      }),
    ).toEqual([lead]);
  });

  it('curing and failed tests: designated reviewers plus the lead, once each', () => {
    for (const kind of ['concrete_curing.out_of_range', 'concrete_test.failed'] as const) {
      expect(
        concreteNotificationRecipients(kind, {
          actorUserId: null,
          designatedReviewerUserIds: [reviewer, lead],
          leadProjectEngineerUserId: lead,
          technicianUserId: tech,
        }),
      ).toEqual([reviewer, lead]);
    }
  });

  it('equipment flags: designated reviewers only', () => {
    expect(
      concreteNotificationRecipients('concrete_equipment.flagged', {
        actorUserId: null,
        designatedReviewerUserIds: [reviewer],
        leadProjectEngineerUserId: lead,
      }),
    ).toEqual([reviewer]);
  });

  it('automatic submission: the technician only', () => {
    expect(
      concreteNotificationRecipients('concrete_report.auto_submitted', {
        actorUserId: null,
        technicianUserId: tech,
        labManagerUserIds: [lm],
        designatedReviewerUserIds: [reviewer],
      }),
    ).toEqual([tech]);
  });

  it('missing people give an empty list', () => {
    for (const kind of CONCRETE_NOTIFICATION_KINDS) {
      expect(concreteNotificationRecipients(kind, { actorUserId: null })).toEqual([]);
    }
  });
});

describe('notification kinds', () => {
  it('concrete kinds are notification kinds; action-request kinds are not concrete', () => {
    for (const kind of CONCRETE_NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KINDS).toContain(kind);
      expect(isConcreteNotificationKind(kind)).toBe(true);
    }
    expect(isConcreteNotificationKind('action_request.opened')).toBe(false);
    expect(isConcreteNotificationKind('action_request.decided')).toBe(false);
  });

  it('a concrete notification parses with a linked report and no linked request', () => {
    const parsed = notificationSchema.parse({
      id: 'n-1',
      kind: 'concrete_report.returned',
      title: 'Field report returned for correction',
      projectId: 'p-1',
      projectNumber: 'DEMO-2601',
      href: '/concrete/field-reports/r-1',
      createdAt: '2026-11-08T12:00:00.000Z',
      readAt: null,
      dismissedAt: null,
      linkedRequest: null,
      linkedReport: {
        id: 'r-1',
        kind: 'field',
        state: 'returned',
        reportDate: '2026-11-08',
        versionNo: 1,
        by: { userId: reviewer, initials: 'RV', name: 'Riley Reviewer' },
        comment: 'Slump time missing',
      },
    });
    expect(parsed.linkedReport?.state).toBe('returned');
  });
});
