import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { assertEnvironmentGuards } from './migrate-sprint3-wave4-indexes';

async function verifyReviewConcurrency(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI_REQUIRED');
  assertEnvironmentGuards(process.env.ELINTYS_ENV, decodeURIComponent(new URL(uri).pathname.slice(1)));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000, autoIndex: false });
  const contextId = new Types.ObjectId();
  try {
    const db = mongoose.connection.db!;
    assertEnvironmentGuards(process.env.ELINTYS_ENV, db.databaseName);
    const reviews = db.collection('reviews');
    const indexes = await reviews.indexes();
    if (!indexes.some((index) => index.name === 'review_verified_context_unique' && index.unique)) {
      throw new Error('VERIFIED_REVIEW_UNIQUE_INDEX_MISSING');
    }
    const now = new Date();
    const common = {
      schemaVersion: 2,
      author: new Types.ObjectId(),
      targetType: 'event',
      targetId: new Types.ObjectId(),
      contextType: 'event',
      contextId,
      direction: 'participant_event',
      verifiedAt: now,
      rating: 5,
      comment: 'Wave J concurrency probe',
      createdAt: now,
      updatedAt: now,
    };
    const attempts = await Promise.allSettled([
      reviews.insertOne({ _id: new Types.ObjectId(), ...common }),
      reviews.insertOne({ _id: new Types.ObjectId(), ...common }),
    ]);
    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const duplicate = attempts.filter(
      (result) => result.status === 'rejected'
        && typeof result.reason === 'object'
        && result.reason !== null
        && 'code' in result.reason
        && result.reason.code === 11000,
    );
    if (fulfilled.length !== 1 || duplicate.length !== 1) {
      throw new Error('VERIFIED_REVIEW_CONCURRENCY_INVARIANT_FAILED');
    }
    console.log(JSON.stringify({ verified: true, database: db.databaseName, accepted: 1, duplicateRejected: 1 }));
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db!.collection('reviews').deleteMany({ contextId });
    }
    await mongoose.disconnect();
  }
}

void verifyReviewConcurrency().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  console.error(`WAVE_J_REVIEW_CONCURRENCY_FAILED ${/^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'DATABASE_ERROR'}`);
  process.exitCode = 1;
});
