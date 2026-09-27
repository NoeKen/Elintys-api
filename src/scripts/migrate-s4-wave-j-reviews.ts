import type { Db } from 'mongodb';
import { MigrationDefinition, MigrationOutcome, runMigrationCli } from './lib/migration-runner';
import { listIndexesOrEmpty } from './lib/collection-indexes';

/**
 * Wave J — index des avis vérifiés V2 (additif, aucun avis supprimé).
 *
 * Contrat CLI (voir lib/migration-runner.ts) :
 *   npm run wave-j:reviews:migrate -- --environment=<dev|uat> [--env-file=.env.uat.local]
 *   npm run wave-j:reviews:migrate -- --environment=<dev|uat> --apply --backup-path=<dir>
 */

const LEGACY_INDEX = 'author_1_targetType_1_targetId_1';
const VERIFIED_UNIQUE_INDEX = 'review_verified_context_unique';
const PUBLIC_FEED_INDEX = 'review_public_feed';

export async function runReviewMigration(db: Db, apply: boolean): Promise<MigrationOutcome> {
  const reviews = db.collection('reviews');
  const documents = await reviews.find({}).toArray();
  const indexes = await listIndexesOrEmpty(reviews);
  const legacy = indexes.find((index) => index.name === LEGACY_INDEX);
  const verified = documents.filter((review) => review.schemaVersion === 2);
  const invalid = verified.filter((review) => !review.contextType || !review.contextId || !review.direction || !review.verifiedAt);
  if (invalid.length) throw new Error('INVALID_VERIFIED_REVIEW');
  const preflight = { database: db.databaseName, reviews: documents.length, verified: verified.length, legacyUniquePresent: Boolean(legacy) };
  if (!apply) return { preflight };

  await reviews.createIndex(
    { author: 1, contextType: 1, contextId: 1, direction: 1 },
    { unique: true, name: VERIFIED_UNIQUE_INDEX, partialFilterExpression: { schemaVersion: 2 } },
  );
  await reviews.createIndex({ targetType: 1, targetId: 1, createdAt: -1, _id: -1 }, { name: PUBLIC_FEED_INDEX });
  if (legacy) await reviews.dropIndex(LEGACY_INDEX);

  // ── Post-validation ──
  const after = await reviews.countDocuments({});
  if (after !== documents.length) throw new Error('REVIEW_COUNT_CHANGED');
  const current = await listIndexesOrEmpty(reviews);
  const uniqueIndex = current.find((index) => index.name === VERIFIED_UNIQUE_INDEX);
  const verifiedUniquePresent = uniqueIndex?.unique === true
    && JSON.stringify(uniqueIndex.partialFilterExpression) === JSON.stringify({ schemaVersion: 2 });
  const publicFeedPresent = current.some((index) => index.name === PUBLIC_FEED_INDEX);
  const legacyStillPresent = current.some((index) => index.name === LEGACY_INDEX);
  // Orphelins : signalés (pré-existants possibles), la migration ne les crée pas et n'y touche pas.
  const authorIds = [...new Set(documents.map((review) => String(review.author)))];
  const existingAuthors = authorIds.length
    ? await db.collection('users').countDocuments({ _id: { $in: documents.map((review) => review.author) } })
    : 0;
  const errors: string[] = [];
  if (!verifiedUniquePresent) errors.push('VERIFIED_REVIEW_UNIQUE_INDEX_MISSING');
  if (!publicFeedPresent) errors.push('REVIEW_PUBLIC_FEED_INDEX_MISSING');
  if (legacyStillPresent) errors.push('LEGACY_REVIEW_INDEX_STILL_PRESENT');

  return {
    preflight,
    changes: { legacyIndexDropped: Boolean(legacy) },
    postValidation: {
      passed: errors.length === 0,
      checks: {
        reviewsBefore: documents.length,
        reviewsAfter: after,
        verifiedUniquePresent,
        publicFeedPresent,
        legacyStillPresent,
        reviewAuthorsMissing: authorIds.length - existingAuthors,
      },
      errors,
    },
  };
}

export const reviewMigration: MigrationDefinition = {
  name: 'wave-j-reviews',
  run: ({ db, mode }) => runReviewMigration(db, mode === 'apply'),
};

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) runMigrationCli(reviewMigration);
