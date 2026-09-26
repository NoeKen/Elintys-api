import mongoose, { Types } from 'mongoose';
import type { Db } from 'mongodb';
import { MigrationDefinition, MigrationOutcome, runMigrationCli } from './lib/migration-runner';

/**
 * Wave J — rattachement des salles à un profil gestionnaire (additif).
 * Aucune salle, réservation, événement ou média n'est supprimé.
 *
 * Contrat CLI (voir lib/migration-runner.ts) :
 *   npm run wave-j:venues:migrate -- --environment=<dev|uat> [--env-file=.env.uat.local]
 *   npm run wave-j:venues:migrate -- --environment=<dev|uat> --apply --backup-path=<dir>
 */

const LEGACY_VENUE_INDEX = 'user_1';
const MANAGER_USER_INDEX = 'user_1';
const VENUE_OWNERSHIP_INDEX = 'managerProfile_1_createdAt_-1__id_1';

function sameBson(left: unknown, right: unknown): boolean {
  return mongoose.mongo.BSON.EJSON.stringify(left) === mongoose.mongo.BSON.EJSON.stringify(right);
}

export async function runVenueMigration(db: Db, apply: boolean): Promise<MigrationOutcome> {
  const venues = db.collection('venueprofiles');
  const managers = db.collection('venuemanagerprofiles');
  const allVenues = await venues.find({}).toArray();
  const indexes = await venues.indexes();
  const legacy = indexes.find(index => index.name === LEGACY_VENUE_INDEX);
  if (legacy && (JSON.stringify(legacy.key) !== JSON.stringify({ user: 1 }) || legacy.unique !== true)) {
    throw new Error('UNEXPECTED_LEGACY_INDEX');
  }
  const users = await db.collection('users').find({ _id: { $in: allVenues.map(venue => venue.user as Types.ObjectId) } }).project({ _id: 1, fullName: 1 }).toArray();
  const userNames = new Map(users.map(user => [user._id.toString(), user.fullName as string]));
  for (const venue of allVenues) {
    if (!(venue.user instanceof Types.ObjectId) || !userNames.has(venue.user.toString())) throw new Error('VENUE_OWNER_MISSING');
    if (venue.managerProfile) {
      const owner = await managers.findOne({ _id: venue.managerProfile, user: venue.user });
      if (!owner) throw new Error('VENUE_MANAGER_LINK_INVALID');
    }
  }
  const preflight = {
    database: db.databaseName,
    venues: allVenues.length,
    pendingLinks: allVenues.filter(venue => !venue.managerProfile).length,
    legacyUniquePresent: !!legacy,
  };
  if (!apply) return { preflight };

  await managers.createIndex({ user: 1 }, { unique: true, name: MANAGER_USER_INDEX });
  let linked = 0;
  for (const venue of allVenues) {
    if (venue.managerProfile) continue;
    const manager = await managers.findOneAndUpdate({ user: venue.user }, { $setOnInsert: { user: venue.user, professionalName: userNames.get(venue.user.toString()) || 'Gestionnaire', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true, returnDocument: 'after' });
    if (!manager) throw new Error('MANAGER_UPSERT_FAILED');
    const result = await venues.updateOne({ _id: venue._id, user: venue.user, managerProfile: { $exists: false } }, { $set: { managerProfile: manager._id } });
    if (result.matchedCount !== 1) throw new Error('CONCURRENT_VENUE_CHANGE');
    linked += 1;
  }
  await venues.createIndex({ managerProfile: 1, createdAt: -1, _id: 1 }, { name: VENUE_OWNERSHIP_INDEX });
  if (await venues.countDocuments({ managerProfile: { $exists: false } })) throw new Error('BACKFILL_INCOMPLETE');
  // Replacement is last: the new ownership index and all links already exist.
  if (legacy) await venues.dropIndex(LEGACY_VENUE_INDEX);

  // ── Post-validation ──
  const after = await venues.find({}).toArray();
  if (after.length !== allVenues.length) throw new Error('VENUE_COUNT_CHANGED');
  for (const before of allVenues) {
    const current = after.find(venue => venue._id.equals(before._id));
    if (!current) throw new Error('VENUE_DISAPPEARED');
    for (const key of Object.keys(before)) {
      if (!sameBson(current[key], before[key])) throw new Error('EXISTING_VENUE_FIELD_CHANGED');
    }
  }
  const errors: string[] = [];
  let orphanVenues = 0;
  for (const venue of after) {
    const owner = venue.managerProfile ? await managers.findOne({ _id: venue.managerProfile, user: venue.user }) : null;
    if (!owner) orphanVenues += 1;
  }
  if (orphanVenues) errors.push('VENUE_ORPHANS_AFTER_MIGRATION');
  const [venueIndexes, managerIndexes] = [await venues.indexes(), await managers.indexes()];
  const ownershipIndexPresent = venueIndexes.some(index => index.name === VENUE_OWNERSHIP_INDEX);
  const managerUniquePresent = managerIndexes.some(index => index.name === MANAGER_USER_INDEX && index.unique === true);
  const legacyStillPresent = venueIndexes.some(index => index.name === LEGACY_VENUE_INDEX);
  if (!ownershipIndexPresent) errors.push('VENUE_OWNERSHIP_INDEX_MISSING');
  if (!managerUniquePresent) errors.push('MANAGER_USER_UNIQUE_INDEX_MISSING');
  if (legacyStillPresent) errors.push('LEGACY_VENUE_INDEX_STILL_PRESENT');

  return {
    preflight,
    changes: { linkedVenues: linked, legacyIndexDropped: !!legacy },
    postValidation: {
      passed: errors.length === 0,
      checks: {
        venuesBefore: allVenues.length,
        venuesAfter: after.length,
        managers: await managers.countDocuments({}),
        orphanVenues,
        ownershipIndexPresent,
        managerUniquePresent,
        legacyStillPresent,
      },
      errors,
    },
  };
}

export const venueMigration: MigrationDefinition = {
  name: 'wave-j-venues',
  run: ({ db, mode }) => runVenueMigration(db, mode === 'apply'),
};

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) runMigrationCli(venueMigration);
