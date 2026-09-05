import { WAVE6_INDEXES } from './migrate-sprint3-wave6-indexes';
import { isMatchingSpec, runApply, runPreflight, runRollback, type ExistingIndexInfo, type MinimalDb } from './migrate-sprint3-wave4-indexes';

const asyncCursor = <T,>(items: T[]) => ({ toArray: () => Promise.resolve(items) });

function buildDb(collections: string[] = []): MinimalDb & { _indexes: Map<string, ExistingIndexInfo[]> } {
  const store = new Map<string, ExistingIndexInfo[]>();
  const known = new Set(collections);
  const db = {
    databaseName: 'elintys-dev',
    _indexes: store,
    admin: () => ({
      command: () =>
        Promise.resolve({ setName: 'rs0', logicalSessionTimeoutMinutes: 30, isWritablePrimary: true }),
    }),
    listCollections: (filter?: Record<string, unknown>) =>
      asyncCursor([...known].filter((n) => !filter?.name || filter.name === n).map((name) => ({ name }))),
    collection: (name: string) => {
      if (!store.has(name)) store.set(name, []);
      return {
        listIndexes: () => asyncCursor(store.get(name)!),
        createIndex: (keys: Record<string, unknown>, opts: Record<string, unknown>) => {
          store.get(name)!.push({
            name: opts.name as string,
            key: keys,
            unique: opts.unique as boolean | undefined,
            sparse: opts.sparse as boolean | undefined,
            partialFilterExpression: opts.partialFilterExpression,
            expireAfterSeconds: opts.expireAfterSeconds as number | undefined,
          });
          return Promise.resolve(opts.name as string);
        },
        dropIndex: (indexName: string) => {
          store.set(name, store.get(name)!.filter((i) => i.name !== indexName));
          return Promise.resolve(undefined);
        },
        countDocuments: () => Promise.resolve(0),
        aggregate: () => asyncCursor([]),
      };
    },
  };
  return db as unknown as MinimalDb & { _indexes: Map<string, ExistingIndexInfo[]> };
}

afterEach(() => jest.clearAllMocks());

describe('WAVE6_INDEXES — déclaration', () => {
  it('devrait ne cibler que les deux collections de la vague', () => {
    expect([...new Set(WAVE6_INDEXES.map((i) => i.collection))].sort()).toEqual([
      'paypal_webhook_events',
      'ticket_orders',
    ]);
  });

  it('devrait porter des noms uniques', () => {
    const names = WAVE6_INDEXES.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('devrait contraindre la référence de règlement en unique partiel', () => {
    const spec = WAVE6_INDEXES.find((i) => i.name === 'ticket_orders_unique_settlement_reference');
    expect(spec?.options.unique).toBe(true);
    expect(spec?.options.partialFilterExpression).toEqual({
      'payment.settlementReference': { $type: 'string' },
    });
  });

  it('devrait déduplicquer les événements PayPal par un index unique', () => {
    const spec = WAVE6_INDEXES.find((i) => i.name === 'paypal_webhook_events_unique_event');
    expect(spec?.keys).toEqual({ eventId: 1 });
    expect(spec?.options.unique).toBe(true);
  });

  it('ne devrait porter de TTL que sur le journal de déduplication', () => {
    const ttl = WAVE6_INDEXES.filter((i) => i.options.expireAfterSeconds !== undefined);
    expect(ttl).toHaveLength(1);
    expect(ttl[0].collection).toBe('paypal_webhook_events');
  });

  it('ne devrait porter aucun TTL sur ticket_orders — la capacité exige une compensation métier', () => {
    for (const spec of WAVE6_INDEXES.filter((i) => i.collection === 'ticket_orders')) {
      expect(spec.options.expireAfterSeconds).toBeUndefined();
    }
  });
});

describe('Migration vague 6', () => {
  it('devrait planifier la création de tous les index sur une base vierge', async () => {
    const report = await runPreflight(buildDb(), 'dev', WAVE6_INDEXES);
    expect(report.summary.toCreate).toBe(WAVE6_INDEXES.length);
    expect(report.summary.conflicts).toBe(0);
    expect(report.summary.blockingDuplicates).toBe(0);
  });

  it('devrait créer puis vérifier les index', async () => {
    const db = buildDb();
    const report = await runApply(db, WAVE6_INDEXES);
    expect(report.created).toHaveLength(WAVE6_INDEXES.length);
    expect(report.verificationPassed).toBe(true);
  });

  it('devrait être rejouable sans recréer', async () => {
    const db = buildDb();
    await runApply(db, WAVE6_INDEXES);
    const second = await runApply(db, WAVE6_INDEXES);
    expect(second.created).toEqual([]);
    expect(second.alreadyPresent).toHaveLength(WAVE6_INDEXES.length);
  });

  it('devrait supprimer uniquement les index de cette vague', async () => {
    const db = buildDb();
    await runApply(db, WAVE6_INDEXES);
    db.collection('ticket_orders').createIndex({ autre: 1 }, { name: 'hors_vague' });
    const report = await runRollback(db, WAVE6_INDEXES);
    expect(report.dropped).toHaveLength(WAVE6_INDEXES.length);
    expect(db._indexes.get('ticket_orders')?.map((i) => i.name)).toEqual(['hors_vague']);
  });

  it('devrait produire des specs conformes à la vérification post-apply', () => {
    for (const spec of WAVE6_INDEXES) {
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
