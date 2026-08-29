import {
  IdempotentOperationSchema,
  IdempotentOperationStatus,
} from './idempotent-operation.schema';

describe('IdempotentOperationSchema', () => {
  it('désactive la création implicite des indexes au démarrage', () => {
    expect(IdempotentOperationSchema.get('autoIndex')).toBe(false);
  });

  it('déclare une identité unique sur le hash de clé, jamais sur la clé brute', () => {
    const indexes = IdempotentOperationSchema.indexes();
    expect(indexes).toContainEqual([
      { scope: 1, actorId: 1, keyHash: 1 },
      expect.objectContaining({ unique: true, name: 'idempotent_ops_unique' }),
    ]);
    expect(IdempotentOperationSchema.path('idempotencyKey')).toBeUndefined();
  });

  it('applique le TTL à expiresAt et conserve les PROCESSING sans expiration TTL', () => {
    const indexes = IdempotentOperationSchema.indexes();
    expect(indexes).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0, name: 'idempotent_ops_ttl' }),
    ]);
    expect(IdempotentOperationStatus.PROCESSING).toBe('PROCESSING');
  });
});
