import {
  INDEXES,
  REQUIRED_DB_NAME,
  REQUIRED_ELINTYS_ENV,
  assertEnvironmentGuards,
  collectInvalidDocuments,
  collectCollectionStatus,
  countBlockingDuplicates,
  detectReplicaSet,
  isMatchingSpec,
  parseMode,
  runApply,
  runPreflight,
  runRollback,
  type ExistingIndexInfo,
  type IndexSpec,
  type MinimalCollection,
  type MinimalDb,
} from './migrate-sprint3-wave4-indexes';

// ── Fakes ───────────────────────────────────────────────────────────────────

const asyncCursor = <T,>(items: T[]) => ({ toArray: async () => items });

const buildFakeCollection = (
  existingIndexes: ExistingIndexInfo[] = [],
  documentCount = 0,
  aggregateResult: unknown[] = [],
): MinimalCollection & {
  listIndexes: jest.Mock;
  createIndex: jest.Mock;
  dropIndex: jest.Mock;
  countDocuments: jest.Mock;
  aggregate: jest.Mock;
  _currentIndexes: ExistingIndexInfo[];
} => {
  const state = { _currentIndexes: [...existingIndexes] };
  const coll = {
    _currentIndexes: state._currentIndexes,
    listIndexes: jest.fn(() => asyncCursor(state._currentIndexes)),
    createIndex: jest.fn(async (keys: Record<string, unknown>, options: Record<string, unknown>) => {
      state._currentIndexes.push({
        name: options.name as string,
        keys,
        unique: options.unique as boolean | undefined,
        sparse: options.sparse as boolean | undefined,
        partialFilterExpression: options.partialFilterExpression,
        expireAfterSeconds: options.expireAfterSeconds as number | undefined,
      });
      return options.name as string;
    }),
    dropIndex: jest.fn(async (name: string) => {
      state._currentIndexes = state._currentIndexes.filter((i) => i.name !== name);
      coll._currentIndexes = state._currentIndexes;
    }),
    countDocuments: jest.fn(async () => documentCount),
    aggregate: jest.fn(() => asyncCursor(aggregateResult)),
  };
  return coll;
};

const buildFakeDb = (opts: {
  databaseName?: string;
  helloResponse?: Record<string, unknown> | Error;
  collections?: Record<
    string,
    { exists: boolean; collection?: ReturnType<typeof buildFakeCollection> }
  >;
}): MinimalDb & { admin: jest.Mock; collection: jest.Mock; listCollections: jest.Mock } => {
  const collectionsMap = opts.collections ?? {};
  return {
    databaseName: opts.databaseName ?? REQUIRED_DB_NAME,
    admin: jest.fn(() => ({
      command: jest.fn(async () => {
        if (opts.helloResponse instanceof Error) throw opts.helloResponse;
        return opts.helloResponse ?? {
          setName: 'rs0',
          isWritablePrimary: true,
          logicalSessionTimeoutMinutes: 30,
        };
      }),
    })),
    listCollections: jest.fn((filter?: Record<string, unknown>) => {
      const name = filter?.name as string | undefined;
      const found = name && collectionsMap[name]?.exists ? [{ name }] : [];
      return asyncCursor(found);
    }),
    collection: jest.fn((name: string) => {
      const entry = collectionsMap[name];
      return entry?.collection ?? buildFakeCollection();
    }),
  };
};

// ── parseMode ───────────────────────────────────────────────────────────────

describe('parseMode', () => {
  it('retourne dry-run par défaut', () => {
    expect(parseMode([])).toBe('dry-run');
    expect(parseMode(['--verbose'])).toBe('dry-run');
  });

  it('retourne apply si --apply', () => {
    expect(parseMode(['--apply'])).toBe('apply');
  });

  it('retourne rollback si --rollback', () => {
    expect(parseMode(['--rollback'])).toBe('rollback');
  });

  it('refuse la combinaison --apply + --rollback', () => {
    expect(() => parseMode(['--apply', '--rollback'])).toThrow(/CONFLICTING_FLAGS/);
  });
});

// ── assertEnvironmentGuards ─────────────────────────────────────────────────

describe('assertEnvironmentGuards', () => {
  it('passe si ELINTYS_ENV=dev et dbName=elintys-dev', () => {
    expect(() => assertEnvironmentGuards(REQUIRED_ELINTYS_ENV, REQUIRED_DB_NAME)).not.toThrow();
  });

  it('refuse si ELINTYS_ENV différent de dev', () => {
    expect(() => assertEnvironmentGuards('production', REQUIRED_DB_NAME))
      .toThrow(/ENV_GUARD_FAILED/);
    expect(() => assertEnvironmentGuards(undefined, REQUIRED_DB_NAME))
      .toThrow(/ENV_GUARD_FAILED/);
    expect(() => assertEnvironmentGuards('', REQUIRED_DB_NAME))
      .toThrow(/ENV_GUARD_FAILED/);
  });

  it('refuse si dbName différent de elintys-dev', () => {
    expect(() => assertEnvironmentGuards(REQUIRED_ELINTYS_ENV, 'elintys-prod'))
      .toThrow(/DB_GUARD_FAILED/);
    expect(() => assertEnvironmentGuards(REQUIRED_ELINTYS_ENV, undefined))
      .toThrow(/DB_GUARD_FAILED/);
    expect(() => assertEnvironmentGuards(REQUIRED_ELINTYS_ENV, 'elintys-staging'))
      .toThrow(/DB_GUARD_FAILED/);
  });
});

// ── INDEXES (contrat immutable) ─────────────────────────────────────────────

describe('INDEXES', () => {
  it('contient exactement les 6 indexes attendus et rien de plus', () => {
    const names = INDEXES.map((i) => i.name).sort();
    expect(names).toEqual([
      'event_reg_by_event',
      'event_reg_by_participant',
      'event_reg_unique_participant',
      'idempotent_ops_ttl',
      'idempotent_ops_unique',
      'stripe_finalization_unique_pi',
    ]);
  });

  it("NE contient PAS event_reg_unique_guest (champ retiré Wave 4)", () => {
    expect(INDEXES.find((i) => i.name === 'event_reg_unique_guest')).toBeUndefined();
  });

  it('event_reg_unique_participant : partial ACTIVE + participantId objectId', () => {
    const spec = INDEXES.find((i) => i.name === 'event_reg_unique_participant')!;
    expect(spec.options.unique).toBe(true);
    expect(spec.options.partialFilterExpression).toEqual({
      participantId: { $type: 'objectId' },
      status: 'active',
    });
  });

  it('idempotent_ops_ttl : expireAfterSeconds = 0 (basé sur expiresAt)', () => {
    const spec = INDEXES.find((i) => i.name === 'idempotent_ops_ttl')!;
    expect(spec.options.expireAfterSeconds).toBe(0);
    expect(spec.keys).toEqual({ expiresAt: 1 });
  });

  it('stripe_finalization_unique_pi : unique, permanent, sans partial ni TTL', () => {
    const spec = INDEXES.find((i) => i.name === 'stripe_finalization_unique_pi')!;
    expect(spec.options.unique).toBe(true);
    expect(spec.options.partialFilterExpression).toBeUndefined();
    expect(spec.options.expireAfterSeconds).toBeUndefined();
  });
});

// ── isMatchingSpec ──────────────────────────────────────────────────────────

describe('isMatchingSpec', () => {
  const spec: IndexSpec = {
    collection: 'x',
    name: 'idx',
    keys: { a: 1, b: 1 },
    options: { unique: true },
    description: '',
  };

  it('match strict sur keys + unique', () => {
    expect(
      isMatchingSpec({ name: 'idx', keys: { a: 1, b: 1 }, unique: true }, spec),
    ).toBe(true);
  });

  it('reconnaît le champ `key` réellement renvoyé par MongoDB listIndexes()', () => {
    expect(
      isMatchingSpec({ name: 'idx', key: { a: 1, b: 1 }, unique: true }, spec),
    ).toBe(true);
  });

  it('reject si keys divergent', () => {
    expect(isMatchingSpec({ name: 'idx', keys: { a: 1 }, unique: true }, spec)).toBe(false);
  });

  it('reject si unique divergent', () => {
    expect(isMatchingSpec({ name: 'idx', keys: { a: 1, b: 1 } }, spec)).toBe(false);
  });

  it('compare le partialFilterExpression', () => {
    const withPartial: IndexSpec = {
      ...spec,
      options: { unique: true, partialFilterExpression: { status: 'active' } },
    };
    expect(
      isMatchingSpec(
        { name: 'idx', keys: { a: 1, b: 1 }, unique: true, partialFilterExpression: { status: 'active' } },
        withPartial,
      ),
    ).toBe(true);
    expect(
      isMatchingSpec(
        { name: 'idx', keys: { a: 1, b: 1 }, unique: true, partialFilterExpression: { status: 'cancelled' } },
        withPartial,
      ),
    ).toBe(false);
  });
});

// ── detectReplicaSet ────────────────────────────────────────────────────────

describe('detectReplicaSet', () => {
  it('retourne isReplicaSet:true et setName si hello.setName présent', async () => {
    const db = buildFakeDb({
      helloResponse: {
        setName: 'rs0',
        ismaster: true,
        logicalSessionTimeoutMinutes: 30,
      },
    });
    const result = await detectReplicaSet(db);
    expect(result).toEqual({
      isReplicaSet: true,
      setName: 'rs0',
      sessionsAvailable: true,
      writablePrimary: true,
      transactionsAvailable: true,
    });
  });

  it('retourne isReplicaSet:false si setName absent (standalone)', async () => {
    const db = buildFakeDb({ helloResponse: { ismaster: true } });
    const result = await detectReplicaSet(db);
    expect(result).toEqual({
      isReplicaSet: false,
      setName: null,
      sessionsAvailable: false,
      writablePrimary: true,
      transactionsAvailable: false,
    });
  });

  it('retourne isReplicaSet:false si la commande hello échoue', async () => {
    const db = buildFakeDb({ helloResponse: new Error('unauthorized') });
    const result = await detectReplicaSet(db);
    expect(result).toEqual({
      isReplicaSet: false,
      setName: null,
      sessionsAvailable: false,
      writablePrimary: false,
      transactionsAvailable: false,
    });
  });
});

describe('collectInvalidDocuments', () => {
  it('ne rapporte que les collections contenant des documents invalides', async () => {
    const invalid = buildFakeCollection([], 2);
    const clean = buildFakeCollection([], 0);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: invalid },
        idempotent_operations: { exists: true, collection: clean },
        stripe_payment_finalizations: { exists: false },
      },
    });
    const reports = await collectInvalidDocuments(db, {
      event_registrations: { exists: true, documentCount: 2, existingIndexes: [] },
      idempotent_operations: { exists: true, documentCount: 0, existingIndexes: [] },
      stripe_payment_finalizations: { exists: false, documentCount: null, existingIndexes: [] },
    });
    expect(reports).toEqual([
      expect.objectContaining({ collection: 'event_registrations', invalidDocuments: 2 }),
    ]);
  });
});

// ── collectCollectionStatus ─────────────────────────────────────────────────

describe('collectCollectionStatus', () => {
  it("retourne exists:false si la collection n'existe pas", async () => {
    const db = buildFakeDb({ collections: {} });
    const status = await collectCollectionStatus(db, 'missing_coll');
    expect(status).toEqual({ exists: false, documentCount: null, existingIndexes: [] });
  });

  it('retourne les indexes et le count si la collection existe', async () => {
    const coll = buildFakeCollection(
      [{ name: '_id_', keys: { _id: 1 } }],
      42,
    );
    const db = buildFakeDb({ collections: { my_coll: { exists: true, collection: coll } } });
    const status = await collectCollectionStatus(db, 'my_coll');
    expect(status.exists).toBe(true);
    expect(status.documentCount).toBe(42);
    expect(status.existingIndexes).toHaveLength(1);
  });
});

// ── countBlockingDuplicates ─────────────────────────────────────────────────

describe('countBlockingDuplicates', () => {
  const uniqueSpec: IndexSpec = {
    collection: 'c',
    name: 'x_unique',
    keys: { a: 1, b: 1 },
    options: { unique: true },
    description: '',
  };
  const partialSpec: IndexSpec = {
    collection: 'c',
    name: 'x_partial',
    keys: { a: 1 },
    options: { unique: true, partialFilterExpression: { status: 'active' } },
    description: '',
  };
  const nonUniqueSpec: IndexSpec = {
    collection: 'c',
    name: 'x_idx',
    keys: { a: 1 },
    options: {},
    description: '',
  };

  it('retourne 0 pour un index non unique', async () => {
    const coll = buildFakeCollection();
    const db = buildFakeDb({ collections: { c: { exists: true, collection: coll } } });
    const status = await collectCollectionStatus(db, 'c');
    const count = await countBlockingDuplicates(db, nonUniqueSpec, status);
    expect(count).toBe(0);
    expect(coll.aggregate).not.toHaveBeenCalled();
  });

  it("retourne 0 si la collection n'existe pas", async () => {
    const db = buildFakeDb({ collections: {} });
    const status = await collectCollectionStatus(db, 'c');
    const count = await countBlockingDuplicates(db, uniqueSpec, status);
    expect(count).toBe(0);
  });

  it('remonte le nombre de groupes conflictuels rapporté par aggregate', async () => {
    const coll = buildFakeCollection([], 100, [{ conflictingGroups: 3 }]);
    const db = buildFakeDb({ collections: { c: { exists: true, collection: coll } } });
    const status = await collectCollectionStatus(db, 'c');
    const count = await countBlockingDuplicates(db, uniqueSpec, status);
    expect(count).toBe(3);
  });

  it('applique le partialFilterExpression via $match', async () => {
    const coll = buildFakeCollection([], 100, [{ conflictingGroups: 1 }]);
    const db = buildFakeDb({ collections: { c: { exists: true, collection: coll } } });
    const status = await collectCollectionStatus(db, 'c');
    await countBlockingDuplicates(db, partialSpec, status);
    const pipeline = (coll.aggregate as jest.Mock).mock.calls[0][0] as Record<string, unknown>[];
    expect(pipeline[0]).toEqual({ $match: { status: 'active' } });
  });

  it("retourne 0 si aggregate retourne un tableau vide", async () => {
    const coll = buildFakeCollection([], 100, []);
    const db = buildFakeDb({ collections: { c: { exists: true, collection: coll } } });
    const status = await collectCollectionStatus(db, 'c');
    const count = await countBlockingDuplicates(db, uniqueSpec, status);
    expect(count).toBe(0);
  });
});

// ── runPreflight ────────────────────────────────────────────────────────────

describe('runPreflight', () => {
  it("marque 'create' pour les indexes absents, 'already-present' pour les identiques", async () => {
    const eventRegColl = buildFakeCollection([
      { name: 'event_reg_by_event', keys: { eventId: 1, status: 1 } },
    ]);
    const idempoColl = buildFakeCollection();
    const stripeColl = buildFakeCollection();
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: idempoColl },
        stripe_payment_finalizations: { exists: true, collection: stripeColl },
      },
    });

    const report = await runPreflight(db, REQUIRED_ELINTYS_ENV, INDEXES);
    const plan = new Map(report.indexPlan.map((p) => [p.name, p.action]));

    expect(plan.get('event_reg_by_event')).toBe('already-present');
    expect(plan.get('event_reg_by_participant')).toBe('create');
    expect(plan.get('event_reg_unique_participant')).toBe('create');
    expect(plan.get('idempotent_ops_unique')).toBe('create');
    expect(plan.get('idempotent_ops_ttl')).toBe('create');
    expect(plan.get('stripe_finalization_unique_pi')).toBe('create');

    expect(report.summary.toCreate).toBe(5);
    expect(report.summary.alreadyPresent).toBe(1);
    expect(report.summary.conflicts).toBe(0);
  });

  it("marque 'conflict' si un index existe avec le même nom mais une spec divergente", async () => {
    const eventRegColl = buildFakeCollection([
      // Même nom mais keys différentes → conflit
      { name: 'event_reg_by_event', keys: { eventId: 1 } },
    ]);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    const report = await runPreflight(db, REQUIRED_ELINTYS_ENV, INDEXES);
    const conflictPlan = report.indexPlan.find((p) => p.name === 'event_reg_by_event');
    expect(conflictPlan?.action).toBe('conflict');
    expect(report.summary.conflicts).toBe(1);
  });

  it('reporte les doublons bloquant les indexes uniques', async () => {
    const stripeColl = buildFakeCollection([], 5, [{ conflictingGroups: 2 }]);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: buildFakeCollection() },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: stripeColl },
      },
    });

    const report = await runPreflight(db, REQUIRED_ELINTYS_ENV, INDEXES);
    const blocker = report.blockingDuplicates.find(
      (b) => b.indexName === 'stripe_finalization_unique_pi',
    );
    expect(blocker?.conflictingGroups).toBe(2);
    expect(report.summary.blockingDuplicates).toBeGreaterThan(0);
  });

  it("inclut l'environnement et le nom de la base dans le rapport", async () => {
    const db = buildFakeDb({
      databaseName: REQUIRED_DB_NAME,
      collections: {
        event_registrations: { exists: true, collection: buildFakeCollection() },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    const report = await runPreflight(db, REQUIRED_ELINTYS_ENV, INDEXES);
    expect(report.environment.elintysEnv).toBe(REQUIRED_ELINTYS_ENV);
    expect(report.environment.dbName).toBe(REQUIRED_DB_NAME);
    expect(report.environment.replicaSet.isReplicaSet).toBe(true);
    expect(report.environment.replicaSet.transactionsAvailable).toBe(true);
  });

  it("gère une collection absente sans erreur", async () => {
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: false },
        idempotent_operations: { exists: false },
        stripe_payment_finalizations: { exists: false },
      },
    });

    const report = await runPreflight(db, REQUIRED_ELINTYS_ENV, INDEXES);
    expect(report.collections.event_registrations.exists).toBe(false);
    // Tous les indexes → create (collection absente sera créée implicitement par createIndex)
    expect(report.summary.toCreate).toBe(INDEXES.length);
  });
});

// ── runApply ────────────────────────────────────────────────────────────────

describe('runApply', () => {
  const buildCleanDb = () => {
    const eventRegColl = buildFakeCollection();
    const idempoColl = buildFakeCollection();
    const stripeColl = buildFakeCollection();
    return {
      db: buildFakeDb({
        collections: {
          event_registrations: { exists: true, collection: eventRegColl },
          idempotent_operations: { exists: true, collection: idempoColl },
          stripe_payment_finalizations: { exists: true, collection: stripeColl },
        },
      }),
      eventRegColl,
      idempoColl,
      stripeColl,
    };
  };

  it('crée chaque index avec keys + options + name explicite', async () => {
    const { db, eventRegColl, idempoColl, stripeColl } = buildCleanDb();
    const report = await runApply(db, INDEXES);

    expect(report.created).toHaveLength(6);
    expect(report.alreadyPresent).toHaveLength(0);
    expect(report.verificationPassed).toBe(true);

    // Vérification : event_reg_unique_participant créé avec partial + unique
    const eventRegCalls = eventRegColl.createIndex.mock.calls.map(
      ([keys, opts]) => ({ keys, opts }),
    );
    const uniquePartial = eventRegCalls.find((c) => c.opts.name === 'event_reg_unique_participant');
    expect(uniquePartial?.keys).toEqual({ eventId: 1, participantId: 1 });
    expect(uniquePartial?.opts.unique).toBe(true);
    expect(uniquePartial?.opts.partialFilterExpression).toEqual({
      participantId: { $type: 'objectId' },
      status: 'active',
    });

    // Vérification : idempotent_ops_ttl créé avec expireAfterSeconds:0
    const ttl = idempoColl.createIndex.mock.calls.find(
      ([, opts]) => opts.name === 'idempotent_ops_ttl',
    );
    expect(ttl?.[1].expireAfterSeconds).toBe(0);

    // Vérification : stripe_finalization_unique_pi créé avec unique:true
    const stripeUnique = stripeColl.createIndex.mock.calls.find(
      ([, opts]) => opts.name === 'stripe_finalization_unique_pi',
    );
    expect(stripeUnique?.[1].unique).toBe(true);
  });

  it('est idempotent : skip un index déjà présent avec spec identique', async () => {
    const eventRegColl = buildFakeCollection([
      {
        name: 'event_reg_by_event',
        keys: { eventId: 1, status: 1 },
      },
    ]);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    const report = await runApply(db, INDEXES);
    expect(report.alreadyPresent).toContain('event_reg_by_event');
    // Le createIndex NE doit PAS être appelé pour event_reg_by_event
    const createCalls = eventRegColl.createIndex.mock.calls;
    expect(createCalls.some(([, opts]) => opts.name === 'event_reg_by_event')).toBe(false);
  });

  it('refuse si un index existe avec le même nom mais spec divergente', async () => {
    const eventRegColl = buildFakeCollection([
      { name: 'event_reg_by_event', keys: { eventId: -1 } }, // spec divergente
    ]);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    await expect(runApply(db, INDEXES)).rejects.toThrow(/APPLY_REFUSED/);
  });

  it("vérifie post-apply que chaque nom cible est présent", async () => {
    const { db } = buildCleanDb();
    const report = await runApply(db, INDEXES);
    expect(report.verificationPassed).toBe(true);
    expect(report.verificationErrors).toHaveLength(0);
  });
});

// ── runRollback ─────────────────────────────────────────────────────────────

describe('runRollback', () => {
  it('supprime UNIQUEMENT les indexes présents dans la liste', async () => {
    const eventRegColl = buildFakeCollection([
      { name: 'event_reg_by_event', keys: { eventId: 1, status: 1 } },
      { name: 'un_autre_index_non_ciblé', keys: { autre: 1 } },
    ]);
    const idempoColl = buildFakeCollection([
      { name: 'idempotent_ops_unique', keys: { scope: 1, actorId: 1, keyHash: 1 } },
    ]);
    const stripeColl = buildFakeCollection([
      { name: 'stripe_finalization_unique_pi', keys: { stripePaymentIntentId: 1 } },
    ]);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: idempoColl },
        stripe_payment_finalizations: { exists: true, collection: stripeColl },
      },
    });

    const report = await runRollback(db, INDEXES);
    expect(report.dropped).toEqual(
      expect.arrayContaining([
        'event_reg_by_event',
        'idempotent_ops_unique',
        'stripe_finalization_unique_pi',
      ]),
    );
    // Absent de la liste cible → ne doit PAS être supprimé
    const droppedNames = eventRegColl.dropIndex.mock.calls.map((c) => c[0]);
    expect(droppedNames).not.toContain('un_autre_index_non_ciblé');
  });

  it("liste dans notPresent les indexes de la migration non trouvés", async () => {
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: buildFakeCollection() },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    const report = await runRollback(db, INDEXES);
    expect(report.dropped).toHaveLength(0);
    expect(report.notPresent).toHaveLength(INDEXES.length);
  });

  it('capture les erreurs de dropIndex sans crasher le rollback global', async () => {
    const eventRegColl = buildFakeCollection([
      { name: 'event_reg_by_event', keys: { eventId: 1, status: 1 } },
      { name: 'event_reg_by_participant', keys: { participantId: 1, status: 1 } },
    ]);
    eventRegColl.dropIndex.mockImplementationOnce(async () => {
      throw new Error('IndexNotFound');
    });
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    const report = await runRollback(db, INDEXES);
    expect(report.errors).toEqual([
      expect.objectContaining({ indexName: 'event_reg_by_event' }),
    ]);
    expect(report.dropped).toContain('event_reg_by_participant');
  });

  it("n'appelle jamais dropIndex sur un nom hors INDEXES", async () => {
    const eventRegColl = buildFakeCollection([
      { name: 'event_reg_unique_guest', keys: { eventId: 1, guestEmail: 1 } }, // interdit
      { name: '_id_', keys: { _id: 1 } },
    ]);
    const db = buildFakeDb({
      collections: {
        event_registrations: { exists: true, collection: eventRegColl },
        idempotent_operations: { exists: true, collection: buildFakeCollection() },
        stripe_payment_finalizations: { exists: true, collection: buildFakeCollection() },
      },
    });

    await runRollback(db, INDEXES);
    const droppedNames = eventRegColl.dropIndex.mock.calls.map((c) => c[0]);
    expect(droppedNames).not.toContain('event_reg_unique_guest');
    expect(droppedNames).not.toContain('_id_');
  });
});
