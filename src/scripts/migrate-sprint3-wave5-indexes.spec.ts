import {
  WAVE5_INDEXES,
  RESERVED_BACKFILL,
  countBackfillCandidates,
  runReservedBackfill,
  type MinimalCollectionWithUpdate,
  type MinimalDbWithUpdate,
} from './migrate-sprint3-wave5-indexes';
import {
  isMatchingSpec,
  countBlockingDuplicates,
  runApply,
  runPreflight,
  runRollback,
  type ExistingIndexInfo,
  type MinimalDb,
} from './migrate-sprint3-wave4-indexes';

const asyncCursor = <T,>(items: T[]) => ({ toArray: () => Promise.resolve(items) });

function buildCollection(options: {
  indexes?: ExistingIndexInfo[];
  documentCount?: number;
  missingFieldCount?: number;
  duplicates?: unknown[];
}): MinimalCollectionWithUpdate & { _indexes: ExistingIndexInfo[]; updateMany: jest.Mock } {
  const state = { indexes: [...(options.indexes ?? [])] };
  const collection = {
    get _indexes() {
      return state.indexes;
    },
    listIndexes: jest.fn(() => asyncCursor(state.indexes)),
    createIndex: jest.fn((keys: Record<string, unknown>, opts: Record<string, unknown>) => {
      state.indexes.push({
        name: opts.name as string,
        key: keys,
        unique: opts.unique as boolean | undefined,
        sparse: opts.sparse as boolean | undefined,
        partialFilterExpression: opts.partialFilterExpression,
        expireAfterSeconds: opts.expireAfterSeconds as number | undefined,
      });
      return Promise.resolve(opts.name as string);
    }),
    dropIndex: jest.fn((name: string) => {
      state.indexes = state.indexes.filter((index) => index.name !== name);
      return Promise.resolve(undefined);
    }),
    countDocuments: jest.fn((filter?: Record<string, unknown>) =>
      Promise.resolve(filter ? (options.missingFieldCount ?? 0) : (options.documentCount ?? 0)),
    ),
    aggregate: jest.fn(() => asyncCursor(options.duplicates ?? [])),
    updateMany: jest.fn(() => Promise.resolve({ modifiedCount: options.missingFieldCount ?? 0 })),
  };
  return collection as unknown as MinimalCollectionWithUpdate & {
    _indexes: ExistingIndexInfo[];
    updateMany: jest.Mock;
  };
}

function buildDb(options: {
  collections?: string[];
  missingFieldCount?: number;
  indexes?: Record<string, ExistingIndexInfo[]>;
  replicaSet?: boolean;
}): MinimalDbWithUpdate & { _collections: Map<string, ReturnType<typeof buildCollection>> } {
  const known = new Set(options.collections ?? []);
  const cache = new Map<string, ReturnType<typeof buildCollection>>();
  const db = {
    databaseName: 'elintys-dev',
    _collections: cache,
    admin: () => ({
      command: () =>
        Promise.resolve(
          options.replicaSet === false
            ? {}
            : { setName: 'rs0', logicalSessionTimeoutMinutes: 30, isWritablePrimary: true },
        ),
    }),
    listCollections: (filter?: Record<string, unknown>) =>
      asyncCursor(
        [...known]
          .filter((name) => !filter?.name || filter.name === name)
          .map((name) => ({ name })),
      ),
    collection: (name: string) => {
      const existing = cache.get(name);
      if (existing) return existing;
      const created = buildCollection({
        indexes: options.indexes?.[name],
        missingFieldCount: name === RESERVED_BACKFILL.collection ? options.missingFieldCount : 0,
      });
      cache.set(name, created);
      return created;
    },
  };
  return db as unknown as MinimalDbWithUpdate & {
    _collections: Map<string, ReturnType<typeof buildCollection>>;
  };
}

afterEach(() => jest.clearAllMocks());

describe('WAVE5_INDEXES — liste déclarée', () => {
  it('devrait cibler exactement les collections de la vague 5', () => {
    expect([...new Set(WAVE5_INDEXES.map((index) => index.collection))].sort()).toEqual([
      'ticket_holds',
      'ticket_orders',
      'ticketpurchases',
    ]);
  });

  it('devrait porter des noms uniques et explicites', () => {
    const names = WAVE5_INDEXES.map((index) => index.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('ticket_orders_unique_payment_reference');
    expect(names).toContain('ticket_holds_unique_order_line');
  });

  it('ne devrait déclarer aucun TTL — un TTL n\'exécute aucune compensation métier', () => {
    for (const index of WAVE5_INDEXES) {
      expect(index.options.expireAfterSeconds).toBeUndefined();
    }
  });

  it('devrait restreindre la contrainte de référence de paiement aux références présentes', () => {
    const spec = WAVE5_INDEXES.find(
      (index) => index.name === 'ticket_orders_unique_payment_reference',
    );
    expect(spec?.options.unique).toBe(true);
    expect(spec?.options.partialFilterExpression).toEqual({
      'payment.reference': { $type: 'string' },
    });
  });
});

describe('Préflight vague 5', () => {
  it('devrait grouper un chemin imbriqué avec un alias MongoDB sans point', async () => {
    const spec = WAVE5_INDEXES.find(
      (index) => index.name === 'ticket_orders_unique_payment_reference',
    )!;
    const db = buildDb({ collections: ['ticket_orders'] });

    await countBlockingDuplicates(
      db as unknown as MinimalDb,
      spec,
      { exists: true, documentCount: 1, existingIndexes: [] },
    );

    expect(db._collections.get('ticket_orders')?.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { $group: { _id: { field0: '$payment.reference' }, count: { $sum: 1 } } },
      ]),
    );
  });

  it('devrait planifier la création de tous les index sur une base vierge', async () => {
    const db = buildDb({ collections: [] });
    const report = await runPreflight(db as unknown as MinimalDb, 'dev', WAVE5_INDEXES);

    expect(report.summary.toCreate).toBe(WAVE5_INDEXES.length);
    expect(report.summary.conflicts).toBe(0);
    expect(report.summary.blockingDuplicates).toBe(0);
    expect(report.environment.replicaSet.transactionsAvailable).toBe(true);
  });

  it('devrait détecter un index existant divergent comme conflit', async () => {
    const db = buildDb({
      collections: ['ticket_holds'],
      indexes: {
        ticket_holds: [
          {
            name: 'ticket_holds_unique_order_line',
            key: { orderId: 1, ticketTypeId: 1 },
            unique: false,
          },
        ],
      },
    });
    const report = await runPreflight(db as unknown as MinimalDb, 'dev', WAVE5_INDEXES);

    expect(report.summary.conflicts).toBe(1);
    expect(
      report.indexPlan.find((plan) => plan.name === 'ticket_holds_unique_order_line')?.action,
    ).toBe('conflict');
  });

  it('devrait signaler un index déjà conforme comme déjà présent', async () => {
    const spec = WAVE5_INDEXES.find((index) => index.name === 'ticket_orders_by_event');
    const db = buildDb({
      collections: ['ticket_orders'],
      indexes: {
        ticket_orders: [{ name: spec!.name, key: spec!.keys }],
      },
    });
    const report = await runPreflight(db as unknown as MinimalDb, 'dev', WAVE5_INDEXES);

    expect(
      report.indexPlan.find((plan) => plan.name === 'ticket_orders_by_event')?.action,
    ).toBe('already-present');
  });
});

describe('Apply et rollback vague 5', () => {
  it('devrait créer puis vérifier tous les index déclarés', async () => {
    const db = buildDb({ collections: [] });
    const report = await runApply(db as unknown as MinimalDb, WAVE5_INDEXES);

    expect(report.created).toHaveLength(WAVE5_INDEXES.length);
    expect(report.verificationPassed).toBe(true);
    expect(report.verificationErrors).toEqual([]);
  });

  it('devrait être rejouable sans recréer les index', async () => {
    const db = buildDb({ collections: [] });
    await runApply(db as unknown as MinimalDb, WAVE5_INDEXES);
    const second = await runApply(db as unknown as MinimalDb, WAVE5_INDEXES);

    expect(second.created).toEqual([]);
    expect(second.alreadyPresent).toHaveLength(WAVE5_INDEXES.length);
  });

  it('devrait supprimer uniquement les index de cette vague', async () => {
    const db = buildDb({ collections: [] });
    await runApply(db as unknown as MinimalDb, WAVE5_INDEXES);
    db.collection('ticket_orders').createIndex({ autre: 1 }, { name: 'index_hors_vague' });

    const report = await runRollback(db as unknown as MinimalDb, WAVE5_INDEXES);

    expect(report.dropped).toHaveLength(WAVE5_INDEXES.length);
    expect(report.errors).toEqual([]);
    expect(
      db._collections.get('ticket_orders')?._indexes.map((index) => index.name),
    ).toEqual(['index_hors_vague']);
  });

  it('devrait produire des specs conformes à la vérification', () => {
    for (const spec of WAVE5_INDEXES) {
      expect(
        isMatchingSpec(
          {
            name: spec.name,
            key: spec.keys,
            unique: spec.options.unique,
            sparse: spec.options.sparse,
            partialFilterExpression: spec.options.partialFilterExpression,
            expireAfterSeconds: spec.options.expireAfterSeconds,
          },
          spec,
        ),
      ).toBe(true);
    }
  });
});

describe('Backfill reserved — additif et non destructif', () => {
  it('ne devrait cibler que les documents où le champ est absent', () => {
    expect(RESERVED_BACKFILL.filter).toEqual({ reserved: { $exists: false } });
    expect(RESERVED_BACKFILL.update).toEqual({ $set: { reserved: 0 } });
  });

  it('devrait compter les candidats sans écrire', async () => {
    const db = buildDb({ collections: ['tickettypes'], missingFieldCount: 7 });
    await expect(countBackfillCandidates(db)).resolves.toBe(7);
    expect(db._collections.get('tickettypes')?.updateMany).not.toHaveBeenCalled();
  });

  it('devrait retourner zéro candidat lorsque la collection n\'existe pas', async () => {
    const db = buildDb({ collections: [] });
    await expect(countBackfillCandidates(db)).resolves.toBe(0);
  });

  it('devrait mettre à jour uniquement les documents concernés', async () => {
    const db = buildDb({ collections: ['tickettypes'], missingFieldCount: 3 });
    const report = await runReservedBackfill(db);

    expect(report).toEqual({
      collection: 'tickettypes',
      field: 'reserved',
      documentsMissingField: 3,
      modified: 3,
    });
    expect(db._collections.get('tickettypes')?.updateMany).toHaveBeenCalledWith(
      RESERVED_BACKFILL.filter,
      RESERVED_BACKFILL.update,
    );
  });

  it('ne devrait rien écrire lorsque tous les documents ont déjà le champ', async () => {
    const db = buildDb({ collections: ['tickettypes'], missingFieldCount: 0 });
    const report = await runReservedBackfill(db);

    expect(report.modified).toBe(0);
    expect(db._collections.get('tickettypes')?.updateMany).not.toHaveBeenCalled();
  });
});
