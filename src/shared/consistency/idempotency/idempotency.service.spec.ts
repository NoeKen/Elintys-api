import { ClientSession } from 'mongoose';
import {
  IdempotencyService,
  computeFingerprint,
  hashIdempotencyKey,
} from './idempotency.service';
import { IdempotentOperationStatus } from './idempotent-operation.schema';
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedWithDifferentPayloadError,
  OperationAlreadyProcessingError,
} from '../errors/consistency.errors';
import { TransactionService } from '../transactions/transaction.service';

type FakeDoc = {
  scope: string;
  actorId: string;
  keyHash: string;
  fingerprint: string;
  ownerToken: string;
  status: IdempotentOperationStatus;
  result: unknown;
  errorCode: string | null;
  lockedAt: Date;
  leaseExpiresAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
};

type FakeFilter = Partial<FakeDoc> & {
  $or?: Array<{
    status: IdempotentOperationStatus;
    leaseExpiresAt?: { $lte: Date };
  }>;
};

type FakeUpdate = {
  $setOnInsert?: Partial<FakeDoc>;
  $set?: Partial<FakeDoc>;
};

class FakeIdempotencyModel {
  private readonly store = new Map<string, FakeDoc>();

  findOne(filter: FakeFilter) {
    return this.chain(this.store.get(this.storageKey(filter)) ?? null);
  }

  findOneAndUpdate(
    filter: FakeFilter,
    update: FakeUpdate,
    options: { upsert?: boolean; new?: boolean } = {},
  ) {
    const storageKey = this.storageKey(filter);
    let doc = this.store.get(storageKey);

    if (!doc && options.upsert) {
      doc = {
        scope: filter.scope ?? '',
        actorId: filter.actorId ?? '',
        keyHash: filter.keyHash ?? '',
        fingerprint: '',
        ownerToken: '',
        status: IdempotentOperationStatus.PROCESSING,
        result: null,
        errorCode: null,
        lockedAt: new Date(),
        leaseExpiresAt: new Date(),
        completedAt: null,
        expiresAt: null,
        ...update.$setOnInsert,
      };
      this.store.set(storageKey, doc);
    } else if (doc && this.matches(doc, filter) && update.$set) {
      Object.assign(doc, update.$set);
    } else if (!doc || !this.matches(doc, filter)) {
      doc = undefined;
    }

    return this.chain(doc ?? null);
  }

  updateOne(filter: FakeFilter, update: FakeUpdate) {
    const doc = this.store.get(this.storageKey(filter));
    const matched = doc && this.matches(doc, filter);
    if (matched && update.$set) Object.assign(doc, update.$set);
    return Promise.resolve({ matchedCount: matched ? 1 : 0, modifiedCount: matched ? 1 : 0 });
  }

  seed(doc: FakeDoc): void {
    this.store.set(this.storageKey(doc), doc);
  }

  get(scope: string, actorId: string, rawKey: string): FakeDoc | undefined {
    return this.store.get(`${scope}::${actorId}::${hashIdempotencyKey(rawKey)}`);
  }

  values(): FakeDoc[] {
    return [...this.store.values()];
  }

  private storageKey(value: Partial<Pick<FakeDoc, 'scope' | 'actorId' | 'keyHash'>>): string {
    return `${value.scope ?? ''}::${value.actorId ?? ''}::${value.keyHash ?? ''}`;
  }

  private matches(doc: FakeDoc, filter: FakeFilter): boolean {
    const scalarKeys: Array<keyof FakeDoc> = [
      'scope', 'actorId', 'keyHash', 'fingerprint', 'ownerToken', 'status',
    ];
    if (scalarKeys.some((key) => filter[key] !== undefined && filter[key] !== doc[key])) {
      return false;
    }
    if (!filter.$or) return true;
    return filter.$or.some((branch) => {
      if (doc.status !== branch.status) return false;
      return !branch.leaseExpiresAt || doc.leaseExpiresAt <= branch.leaseExpiresAt.$lte;
    });
  }

  private chain(doc: FakeDoc | null) {
    return { lean: <T>() => Promise.resolve(doc as T | null) };
  }
}

const session = {} as ClientSession;
const transactions = {
  run: jest.fn(async (_scope: string, work: (value: ClientSession) => Promise<unknown>) => work(session)),
} as unknown as TransactionService;

const SCOPE = 'ticket-purchase';
const ACTOR = 'user-abc123';
const KEY = 'idem-key-001';
const PAYLOAD = { ticketTypeId: 'tt-xyz', quantity: 2 };

function makeService(model: FakeIdempotencyModel): IdempotencyService {
  return new IdempotencyService(model as never, transactions);
}

function seededDoc(
  status: IdempotentOperationStatus,
  overrides: Partial<FakeDoc> = {},
): FakeDoc {
  return {
    scope: SCOPE,
    actorId: ACTOR,
    keyHash: hashIdempotencyKey(KEY),
    fingerprint: computeFingerprint(PAYLOAD),
    ownerToken: 'previous-owner',
    status,
    result: null,
    errorCode: null,
    lockedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe('IdempotencyService', () => {
  let model: FakeIdempotencyModel;
  let service: IdempotencyService;

  beforeEach(() => {
    jest.clearAllMocks();
    model = new FakeIdempotencyModel();
    service = makeService(model);
  });

  it('exécute la première opération dans une transaction et la marque SUCCEEDED', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'purchase-1' });
    await expect(service.execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD, operation,
    })).resolves.toEqual({ id: 'purchase-1' });

    expect(operation).toHaveBeenCalledWith(session);
    expect(model.get(SCOPE, ACTOR, KEY)?.status).toBe(IdempotentOperationStatus.SUCCEEDED);
    expect(model.get(SCOPE, ACTOR, KEY)?.expiresAt).toBeInstanceOf(Date);
  });

  it('rejoue un succès sans réexécuter le callback', async () => {
    await service.execute({
      scope: SCOPE,
      actorId: ACTOR,
      idempotencyKey: KEY,
      payload: PAYLOAD,
      operation: jest.fn().mockResolvedValue({ id: 'purchase-1' }),
    });
    const operation = jest.fn();
    await expect(makeService(model).execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD, operation,
    })).resolves.toEqual({ id: 'purchase-1' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuse la même clé avec un payload différent, y compris pendant PROCESSING', async () => {
    model.seed(seededDoc(IdempotentOperationStatus.PROCESSING));
    await expect(service.execute({
      scope: SCOPE,
      actorId: ACTOR,
      idempotencyKey: KEY,
      payload: { ...PAYLOAD, quantity: 9 },
      operation: jest.fn(),
    })).rejects.toThrow(IdempotencyKeyReusedWithDifferentPayloadError);
  });

  it('rend deux appels simultanés avec la même clé déterministes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = service.execute({
      scope: SCOPE,
      actorId: ACTOR,
      idempotencyKey: KEY,
      payload: PAYLOAD,
      operation: async () => {
        await gate;
        return 'first';
      },
    });
    await Promise.resolve();
    await expect(makeService(model).execute({
      scope: SCOPE,
      actorId: ACTOR,
      idempotencyKey: KEY,
      payload: PAYLOAD,
      operation: jest.fn().mockResolvedValue('second'),
    })).rejects.toThrow(OperationAlreadyProcessingError);
    release?.();
    await expect(first).resolves.toBe('first');
  });

  it('traduit une collision E11000 d’upsert en état concurrent durable', async () => {
    model.seed(seededDoc(IdempotentOperationStatus.PROCESSING));
    jest.spyOn(model, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.reject({ code: 11000 }),
    } as never);

    await expect(service.execute({
      scope: SCOPE,
      actorId: ACTOR,
      idempotencyKey: KEY,
      payload: PAYLOAD,
      operation: jest.fn(),
    })).rejects.toThrow(OperationAlreadyProcessingError);
  });

  it('isole deux clés et deux instances logiques via le store partagé', async () => {
    const [first, second] = await Promise.all([
      service.execute({
        scope: SCOPE, actorId: ACTOR, idempotencyKey: 'key-a', payload: PAYLOAD,
        operation: jest.fn().mockResolvedValue('a'),
      }),
      makeService(model).execute({
        scope: SCOPE, actorId: ACTOR, idempotencyKey: 'key-b', payload: PAYLOAD,
        operation: jest.fn().mockResolvedValue('b'),
      }),
    ]);
    expect([first, second]).toEqual(['a', 'b']);
  });

  it('marque FAILED après rollback puis autorise un retry atomique', async () => {
    await expect(service.execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD,
      operation: jest.fn().mockRejectedValue(new Error('temporary')),
    })).rejects.toThrow('temporary');
    expect(model.get(SCOPE, ACTOR, KEY)?.status).toBe(IdempotentOperationStatus.FAILED);

    await expect(makeService(model).execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD,
      operation: jest.fn().mockResolvedValue('retried'),
    })).resolves.toBe('retried');
    expect(model.get(SCOPE, ACTOR, KEY)?.status).toBe(IdempotentOperationStatus.SUCCEEDED);
  });

  it("préserve l'erreur métier si le marquage FAILED est indisponible", async () => {
    const businessError = new Error('business-failure');
    jest
      .spyOn(service as unknown as { markFailedIfOwned: () => Promise<void> }, 'markFailedIfOwned')
      .mockRejectedValueOnce(new Error('bookkeeping-failure'));

    await expect(service.execute({
      scope: SCOPE,
      actorId: ACTOR,
      idempotencyKey: KEY,
      payload: PAYLOAD,
      operation: jest.fn().mockRejectedValue(businessError),
    })).rejects.toBe(businessError);
  });

  it('reprend un PROCESSING orphelin après expiration du lease', async () => {
    model.seed(seededDoc(IdempotentOperationStatus.PROCESSING, {
      leaseExpiresAt: new Date(Date.now() - 1),
    }));
    await expect(service.execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD,
      operation: jest.fn().mockResolvedValue('recovered'),
    })).resolves.toBe('recovered');
  });

  it('après redémarrage, refuse un lease PROCESSING encore actif', async () => {
    model.seed(seededDoc(IdempotentOperationStatus.PROCESSING));
    await expect(makeService(model).execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD,
      operation: jest.fn(),
    })).rejects.toThrow(OperationAlreadyProcessingError);
  });

  it('ne persiste jamais la clé brute', async () => {
    await service.execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD,
      operation: jest.fn().mockResolvedValue('ok'),
    });
    expect(JSON.stringify(model.values())).not.toContain(KEY);
    expect(model.values()[0]?.keyHash).toBe(hashIdempotencyKey(KEY));
  });

  it('refuse une clé vide', async () => {
    await expect(service.execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: ' ', payload: PAYLOAD,
      operation: jest.fn(),
    })).rejects.toThrow(IdempotencyKeyRequiredError);
  });

  it('fait échouer et rollback un résultat rejouable trop volumineux', async () => {
    await expect(service.execute({
      scope: SCOPE, actorId: ACTOR, idempotencyKey: KEY, payload: PAYLOAD,
      operation: jest.fn().mockResolvedValue({ value: 'x'.repeat(70 * 1024) }),
    })).rejects.toThrow('exceeds 64 KiB');
    expect(model.get(SCOPE, ACTOR, KEY)?.status).toBe(IdempotentOperationStatus.FAILED);
  });
});

describe('idempotency hashing', () => {
  it('canonicalise récursivement les objets mais conserve l’ordre des tableaux', () => {
    expect(computeFingerprint({ nested: { b: 2, a: 1 }, items: [2, 1] }))
      .toBe(computeFingerprint({ items: [2, 1], nested: { a: 1, b: 2 } }));
    expect(computeFingerprint({ items: [2, 1] }))
      .not.toBe(computeFingerprint({ items: [1, 2] }));
  });

  it('produit des hashes SHA-256 sans conserver la valeur brute', () => {
    expect(hashIdempotencyKey(KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIdempotencyKey(KEY)).not.toContain(KEY);
  });
});
