import { Types } from 'mongoose';
import type { Db } from 'mongodb';
import { runReviewMigration } from './migrate-s4-wave-j-reviews';

describe('Wave J review index migration', () => {
  const author = new Types.ObjectId();
  const verifiedReview = {
    _id: new Types.ObjectId(), schemaVersion: 2, author, contextType: 'event',
    contextId: new Types.ObjectId(), direction: 'participant_event', verifiedAt: new Date(),
  };
  let reviews: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let db: Db;

  beforeEach(() => {
    reviews = {
      find: jest.fn().mockReturnValue({ toArray: async () => [verifiedReview] }),
      indexes: jest.fn().mockResolvedValue([{ name: 'author_1_targetType_1_targetId_1', unique: true }]),
      createIndex: jest.fn(), dropIndex: jest.fn(), countDocuments: jest.fn().mockResolvedValue(1),
    };
    users = { countDocuments: jest.fn().mockResolvedValue(1) };
    db = { databaseName: 'elintys-uat', collection: (name: string) => (name === 'users' ? users : reviews) } as unknown as Db;
  });

  it('devrait rester en lecture seule en dry-run', async () => {
    const outcome = await runReviewMigration(db, false);
    expect(outcome.preflight).toEqual({ database: 'elintys-uat', reviews: 1, verified: 1, legacyUniquePresent: true });
    expect(reviews.createIndex).not.toHaveBeenCalled();
    expect(reviews.dropIndex).not.toHaveBeenCalled();
  });

  it('devrait refuser un avis vérifié incomplet avant toute écriture', async () => {
    reviews.find.mockReturnValue({ toArray: async () => [{ ...verifiedReview, verifiedAt: undefined }] });
    await expect(runReviewMigration(db, true)).rejects.toThrow('INVALID_VERIFIED_REVIEW');
    expect(reviews.createIndex).not.toHaveBeenCalled();
  });

  it('devrait créer les index, retirer le legacy en dernier et valider', async () => {
    reviews.indexes
      .mockResolvedValueOnce([{ name: 'author_1_targetType_1_targetId_1', unique: true }])
      .mockResolvedValueOnce([
        { name: 'review_verified_context_unique', unique: true, partialFilterExpression: { schemaVersion: 2 } },
        { name: 'review_public_feed' },
      ]);
    const outcome = await runReviewMigration(db, true);
    expect(reviews.createIndex).toHaveBeenCalledTimes(2);
    expect(reviews.dropIndex).toHaveBeenCalledWith('author_1_targetType_1_targetId_1');
    expect(outcome.postValidation).toMatchObject({ passed: true, checks: { reviewsAfter: 1, reviewAuthorsMissing: 0 } });
  });

  it('devrait détecter une perte de documents', async () => {
    reviews.countDocuments.mockResolvedValue(0);
    await expect(runReviewMigration(db, true)).rejects.toThrow('REVIEW_COUNT_CHANGED');
  });
});
