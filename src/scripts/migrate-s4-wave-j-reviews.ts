import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertEnvironmentGuards } from './migrate-sprint3-wave4-indexes';

const LEGACY_INDEX = 'author_1_targetType_1_targetId_1';

export async function migrateReviewIndexes(apply: boolean, backupDirectory?: string): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI_REQUIRED');
  assertEnvironmentGuards(process.env.ELINTYS_ENV, decodeURIComponent(new URL(uri).pathname.slice(1)));
  if (apply && !backupDirectory) throw new Error('BACKUP_DIRECTORY_REQUIRED');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000, autoIndex: false });
  try {
    const db = mongoose.connection.db!;
    assertEnvironmentGuards(process.env.ELINTYS_ENV, db.databaseName);
    const reviews = db.collection('reviews');
    const documents = await reviews.find({}).toArray();
    const indexes = await reviews.indexes();
    const legacy = indexes.find((index) => index.name === LEGACY_INDEX);
    const verified = documents.filter((review) => review.schemaVersion === 2);
    const invalid = verified.filter((review) => !review.contextType || !review.contextId || !review.direction || !review.verifiedAt);
    if (invalid.length) throw new Error('INVALID_VERIFIED_REVIEW');
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', database: db.databaseName, reviews: documents.length, verified: verified.length, legacyUniquePresent: Boolean(legacy) }));
    if (!apply) return;

    const directory = resolve(backupDirectory!, `wave-j-reviews-${Date.now()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'reviews.ejson'), mongoose.mongo.BSON.EJSON.stringify(documents, { relaxed: false }), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'indexes.json'), JSON.stringify(indexes, null, 2), { mode: 0o600, flag: 'wx' });
    await reviews.createIndex(
      { author: 1, contextType: 1, contextId: 1, direction: 1 },
      { unique: true, name: 'review_verified_context_unique', partialFilterExpression: { schemaVersion: 2 } },
    );
    await reviews.createIndex({ targetType: 1, targetId: 1, createdAt: -1, _id: -1 }, { name: 'review_public_feed' });
    if (legacy) await reviews.dropIndex(LEGACY_INDEX);
    if (await reviews.countDocuments({}) !== documents.length) throw new Error('REVIEW_COUNT_CHANGED');
    console.log(JSON.stringify({ verified: true, preservedReviews: documents.length, backupDirectory: directory }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  const backupIndex = process.argv.indexOf('--backup-dir');
  migrateReviewIndexes(process.argv.includes('--apply'), backupIndex < 0 ? undefined : process.argv[backupIndex + 1])
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      console.error(`WAVE_J_REVIEW_MIGRATION_FAILED ${/^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'PREFLIGHT_OR_DATABASE_ERROR'}`);
      process.exitCode = 1;
    });
}
