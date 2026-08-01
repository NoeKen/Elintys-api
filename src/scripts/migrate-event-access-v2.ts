import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import {
  AdmissionMode,
  EventAccessPolicyType,
  EventDiscoverability,
  EventVisibility,
} from '../modules/events/event.schema';

type LegacyEvent = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  visibility?: EventVisibility;
  accessRules?: {
    accessCode?: boolean;
    allowedEmailDomain?: string;
    manualApproval?: boolean;
  };
  accessModelVersion?: number;
};

type MigrationPlan = {
  eventId: mongoose.Types.ObjectId;
  legacyVisibility: EventVisibility | undefined;
  update?: Record<string, unknown>;
  ambiguousReason?: string;
};

function normalizedDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

export function planEventAccessMigration(event: LegacyEvent): MigrationPlan {
  const base = { accessModelVersion: 2 };
  if (event.visibility === EventVisibility.PUBLIC || !event.visibility) {
    return {
      eventId: event._id,
      legacyVisibility: event.visibility,
      update: {
        ...base,
        discoverability: EventDiscoverability.PUBLIC,
        accessPolicy: { type: EventAccessPolicyType.OPEN },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      },
    };
  }
  if (event.visibility === EventVisibility.INVITE_ONLY) {
    return {
      eventId: event._id,
      legacyVisibility: event.visibility,
      update: {
        ...base,
        discoverability: EventDiscoverability.UNLISTED,
        accessPolicy: { type: EventAccessPolicyType.INVITATION_TOKEN },
        admissionModes: [AdmissionMode.INVITATION],
      },
    };
  }
  if (event.accessRules?.accessCode) {
    return {
      eventId: event._id,
      legacyVisibility: event.visibility,
      ambiguousReason: 'ACCESS_CODE_MISSING_RAW_VALUE',
    };
  }
  if (event.accessRules?.allowedEmailDomain) {
    return {
      eventId: event._id,
      legacyVisibility: event.visibility,
      update: {
        ...base,
        discoverability: EventDiscoverability.UNLISTED,
        accessPolicy: {
          type: EventAccessPolicyType.EMAIL_DOMAIN,
          requiresAuthentication: true,
          allowedDomains: [normalizedDomain(event.accessRules.allowedEmailDomain)],
        },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      },
    };
  }
  if (event.accessRules?.manualApproval) {
    return {
      eventId: event._id,
      legacyVisibility: event.visibility,
      update: {
        ...base,
        discoverability: EventDiscoverability.PRIVATE,
        accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL, requiresAuthentication: true },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      },
    };
  }
  return {
    eventId: event._id,
    legacyVisibility: event.visibility,
    ambiguousReason: 'PRIVATE_INTENT_UNDETERMINED',
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);
  const collection = mongoose.connection.db?.collection<LegacyEvent>('events');
  if (!collection) throw new Error('MongoDB connection is unavailable');

  const events = await collection.find({ accessModelVersion: { $ne: 2 } }).toArray();
  const plans = events.map(planEventAccessMigration);
  const executable = plans.filter((plan) => plan.update);
  const ambiguous = plans.filter((plan) => plan.ambiguousReason);
  const byVisibility = Object.fromEntries(
    Object.values(EventVisibility).map((visibility) => [
      visibility,
      plans.filter((plan) => plan.legacyVisibility === visibility).length,
    ]),
  );
  const report = {
    mode: process.argv.includes('--execute') ? 'execute' : 'dry-run',
    total: events.length,
    mapping: byVisibility,
    migratable: executable.length,
    ambiguous: ambiguous.length,
    ambiguousEvents: ambiguous.map((plan) => ({
      eventId: plan.eventId.toString(),
      reason: plan.ambiguousReason,
    })),
  };

  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!process.argv.includes('--confirm-access-v2')) {
    throw new Error('MIGRATION_REFUSED: add --confirm-access-v2 after reviewing the dry-run report.');
  }

  const rollbackFile = `event-access-v2-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    rollbackFile,
    JSON.stringify(events.map((event) => ({
      _id: event._id.toString(),
      visibility: event.visibility,
      accessRules: event.accessRules,
      accessModelVersion: event.accessModelVersion,
    })), null, 2),
    { flag: 'wx', mode: 0o600 },
  );

  let migrated = 0;
  for (const plan of executable) {
    const result = await collection.updateOne(
      { _id: plan.eventId, accessModelVersion: { $ne: 2 } },
      { $set: plan.update! },
    );
    migrated += result.modifiedCount;
  }
  console.log(JSON.stringify({ ...report, migrated, rollbackFile }, null, 2));
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Unknown migration error');
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect());
}
