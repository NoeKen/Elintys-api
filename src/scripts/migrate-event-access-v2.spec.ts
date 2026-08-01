import { Types } from 'mongoose';
import { planEventAccessMigration } from './migrate-event-access-v2';
import { EventAccessPolicyType, EventDiscoverability, EventVisibility } from '../modules/events/event.schema';

describe('event access v2 migration plan', () => {
  const id = new Types.ObjectId();

  it('mappe public et invite_only de façon déterministe', () => {
    expect(planEventAccessMigration({ _id: id, visibility: EventVisibility.PUBLIC }).update)
      .toMatchObject({ discoverability: EventDiscoverability.PUBLIC, accessPolicy: { type: EventAccessPolicyType.OPEN } });
    expect(planEventAccessMigration({ _id: id, visibility: EventVisibility.INVITE_ONLY }).update)
      .toMatchObject({ discoverability: EventDiscoverability.UNLISTED, accessPolicy: { type: EventAccessPolicyType.INVITATION_TOKEN } });
  });

  it('signale les événements privés ambigus sans produire de mise à jour', () => {
    const plan = planEventAccessMigration({ _id: id, visibility: EventVisibility.PRIVATE });
    expect(plan.update).toBeUndefined();
    expect(plan.ambiguousReason).toBe('PRIVATE_INTENT_UNDETERMINED');
  });

  it('ne prétend pas migrer un code dont la valeur brute est absente', () => {
    const plan = planEventAccessMigration({
      _id: id,
      visibility: EventVisibility.PRIVATE,
      accessRules: { accessCode: true },
    });
    expect(plan.update).toBeUndefined();
    expect(plan.ambiguousReason).toBe('ACCESS_CODE_MISSING_RAW_VALUE');
  });
});
