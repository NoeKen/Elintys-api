import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertEnvironmentGuards } from './migrate-sprint3-wave4-indexes';

/** Additive dev migration. No venue, booking, event or media is deleted. */
export async function migrateVenues(apply: boolean, backupDirectory?: string): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI_REQUIRED');
  assertEnvironmentGuards(process.env.ELINTYS_ENV, decodeURIComponent(new URL(uri).pathname.slice(1)));
  if (apply && !backupDirectory) throw new Error('BACKUP_DIRECTORY_REQUIRED');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  try {
    const db = mongoose.connection.db!;
    assertEnvironmentGuards(process.env.ELINTYS_ENV, db.databaseName);
    const venues = db.collection('venueprofiles');
    const managers = db.collection('venuemanagerprofiles');
    const allVenues = await venues.find({}).toArray();
    const indexes = await venues.indexes();
    const legacy = indexes.find(index => index.name === 'user_1');
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
    const report = { mode: apply ? 'apply' : 'dry-run', database: db.databaseName, venues: allVenues.length, pendingLinks: allVenues.filter(venue => !venue.managerProfile).length, legacyUniquePresent: !!legacy };
    console.log(JSON.stringify(report));
    if (!apply) return;

    // Save exact BSON and indexes before modifying links or uniqueness. Never commit this directory.
    const directory = resolve(backupDirectory!, `wave-j-${Date.now()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'venues.ejson'), mongoose.mongo.BSON.EJSON.stringify(allVenues, { relaxed: false }), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'indexes.json'), JSON.stringify(indexes, null, 2), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'managers.ejson'), mongoose.mongo.BSON.EJSON.stringify(await managers.find({}).toArray(), { relaxed: false }), { mode: 0o600, flag: 'wx' });
    await managers.createIndex({ user: 1 }, { unique: true, name: 'user_1' });
    for (const venue of allVenues) {
      if (venue.managerProfile) continue;
      const manager = await managers.findOneAndUpdate({ user: venue.user }, { $setOnInsert: { user: venue.user, professionalName: userNames.get(venue.user.toString()) || 'Gestionnaire', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true, returnDocument: 'after' });
      if (!manager) throw new Error('MANAGER_UPSERT_FAILED');
      const linked = await venues.updateOne({ _id: venue._id, user: venue.user, managerProfile: { $exists: false } }, { $set: { managerProfile: manager._id } });
      if (linked.matchedCount !== 1) throw new Error('CONCURRENT_VENUE_CHANGE');
    }
    await venues.createIndex({ managerProfile: 1, createdAt: -1, _id: 1 }, { name: 'managerProfile_1_createdAt_-1__id_1' });
    if (await venues.countDocuments({ managerProfile: { $exists: false } })) throw new Error('BACKFILL_INCOMPLETE');
    // Replacement is last: the new ownership index and all links already exist.
    if (legacy) await venues.dropIndex('user_1');
    const after = await venues.find({}).toArray();
    if (after.length !== allVenues.length) throw new Error('VENUE_COUNT_CHANGED');
    for (const before of allVenues) {
      const current = after.find(venue => venue._id.equals(before._id));
      if (!current) throw new Error('VENUE_DISAPPEARED');
      for (const key of Object.keys(before)) {
        if (mongoose.mongo.BSON.EJSON.stringify(current[key]) !== mongoose.mongo.BSON.EJSON.stringify(before[key])) throw new Error('EXISTING_VENUE_FIELD_CHANGED');
      }
    }
    console.log(JSON.stringify({ verified: true, preservedVenues: after.length, backupDirectory: directory }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  const backupIndex = process.argv.indexOf('--backup-dir');
  migrateVenues(process.argv.includes('--apply'), backupIndex < 0 ? undefined : process.argv[backupIndex + 1])
    .catch((error: unknown) => {
      // Print only our explicit codes; driver messages may contain hostnames or URI data.
      const message = error instanceof Error ? error.message : '';
      const safeCode = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'PREFLIGHT_OR_DATABASE_ERROR';
      console.error(`WAVE_J_MIGRATION_FAILED ${safeCode} — inspect preflight and backups; no automatic rollback.`);
      process.exitCode = 1;
    });
}
