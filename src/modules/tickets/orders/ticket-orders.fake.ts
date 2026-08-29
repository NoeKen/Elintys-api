import { ClientSession, Types } from 'mongoose';
import {
  IdempotencyExecuteParams,
  computeFingerprint,
} from '../../../shared/consistency/idempotency/idempotency.service';
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedWithDifferentPayloadError,
  OperationAlreadyProcessingError,
} from '../../../shared/consistency/errors/consistency.errors';

/**
 * Harnais de test du domaine Ticketing.
 *
 * Reproduit UNIQUEMENT les propriétés dont dépend la correction du domaine :
 *   - mise à jour conditionnelle atomique d'un document (filtre + écriture
 *     indivisibles, opérations concurrentes sérialisées) ;
 *   - sémantique d'idempotence de `shared/consistency` (rejeu du résultat,
 *     refus d'une même clé avec un payload différent) ;
 *   - rollback : une transaction qui lève annule toutes ses écritures.
 *
 * Ce harnais ne remplace pas la vérification sur MongoDB réel
 * (`src/scripts/verify-wave5-concurrency.ts`).
 */

type Doc = Record<string, unknown>;

export interface FakeUpdateResult {
  modifiedCount: number;
}

/** Journal d'écriture permettant d'annuler les effets d'une transaction. */
interface WriteLogEntry {
  collection: FakeCollection;
  id: string;
  before: Doc | undefined;
}

export class FakeTransactionContext {
  readonly writes: WriteLogEntry[] = [];
}

/**
 * La session PORTE son contexte transactionnel.
 *
 * C'est ce qui permet à deux transactions concurrentes d'être réellement
 * indépendantes : le rollback de l'une ne peut pas annuler les écritures de
 * l'autre, exactement comme avec des sessions MongoDB distinctes.
 */
interface FakeSession {
  __context: FakeTransactionContext;
}

function contextOf(session: ClientSession | undefined): FakeTransactionContext | undefined {
  return (session as unknown as FakeSession | undefined)?.__context;
}

export class FakeCollection {
  readonly documents = new Map<string, Doc>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly name: string,
    seed: Doc[] = [],
  ) {
    for (const document of seed) {
      this.documents.set(String(document._id), clone(document));
    }
  }

  all(): Doc[] {
    return [...this.documents.values()].map(clone);
  }

  get(id: Types.ObjectId | string): Doc | undefined {
    const found = this.documents.get(String(id));
    return found ? clone(found) : undefined;
  }

  create(documents: Doc[], options?: { session?: ClientSession }): Promise<Doc[]> {
    return this.critical(() =>
      documents.map((document) => {
        const _id = (document._id as Types.ObjectId | undefined) ?? new Types.ObjectId();
        const stored = clone({ ...document, _id, createdAt: new Date() });
        this.record(options?.session, String(_id), undefined);
        this.documents.set(String(_id), stored);
        return clone(stored);
      }),
    );
  }

  updateOne(filter: Doc, update: Doc, options?: { session?: ClientSession }): Promise<FakeUpdateResult> {
    return this.critical(() => {
      const match = this.matchOne(filter);
      if (!match) return { modifiedCount: 0 };
      this.record(options?.session, String(match._id), clone(match));
      applyUpdate(match, update);
      return { modifiedCount: 1 };
    });
  }

  findOneAndUpdate(
    filter: Doc,
    update: Doc,
    options?: { new?: boolean; session?: ClientSession },
  ): Promise<Doc | null> {
    return this.critical(() => {
      const match = this.matchOne(filter);
      if (!match) return null;
      this.record(options?.session, String(match._id), clone(match));
      applyUpdate(match, update);
      return clone(match);
    });
  }

  private record(session: ClientSession | undefined, id: string, before: Doc | undefined): void {
    contextOf(session)?.writes.push({ collection: this, id, before });
  }

  countDocuments(filter: Doc = {}): Promise<number> {
    return Promise.resolve(this.matchAll(filter).length);
  }

  findById(id: string | Types.ObjectId): FakeQuery {
    return new FakeQuery(() => {
      const found = this.documents.get(String(id));
      return found ? [clone(found)] : [];
    }, true);
  }

  find(filter: Doc = {}): FakeQuery {
    return new FakeQuery(() => this.matchAll(filter).map(clone), false);
  }

  findOne(filter: Doc = {}): FakeQuery {
    return new FakeQuery(() => {
      const match = this.matchOne(filter);
      return match ? [clone(match)] : [];
    }, true);
  }

  restore(id: string, before: Doc | undefined): void {
    if (before === undefined) this.documents.delete(id);
    else this.documents.set(id, before);
  }

  private matchOne(filter: Doc): Doc | undefined {
    return [...this.documents.values()].find((document) => matches(document, filter));
  }

  private matchAll(filter: Doc): Doc[] {
    return [...this.documents.values()].filter((document) => matches(document, filter));
  }

  /** Section critique strictement sérialisée, comme le serveur MongoDB. */
  private critical<T>(work: () => T): Promise<T> {
    const result = this.tail.then(() => work());
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Requête chaînable minimale : `.session().sort().skip().limit().lean().select()`. */
export class FakeQuery {
  private sortSpec: Doc | null = null;
  private skipCount = 0;
  private limitCount: number | null = null;

  constructor(
    private readonly load: () => Doc[],
    private readonly single: boolean,
  ) {}

  session(): this {
    return this;
  }

  sort(spec: Doc): this {
    this.sortSpec = spec;
    return this;
  }

  skip(count: number): this {
    this.skipCount = count;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  lean(): this {
    return this;
  }

  select(): Promise<Doc | Doc[] | null> {
    return this.resolve();
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?: ((value: Doc | Doc[] | null) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.resolve().then(onFulfilled, onRejected);
  }

  private resolve(): Promise<Doc | Doc[] | null> {
    let rows = this.load();
    if (this.sortSpec) {
      const [[field, direction]] = Object.entries(this.sortSpec);
      rows = [...rows].sort((left, right) =>
        compare(left[field], right[field]) * (Number(direction) < 0 ? -1 : 1),
      );
    }
    rows = rows.slice(this.skipCount);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return Promise.resolve(this.single ? (rows[0] ?? null) : rows);
  }
}

/**
 * Registre de collections + gestion de la transaction.
 *
 * `runTransaction` journalise chaque écriture et restaure l'état précédent si
 * le callback lève : c'est le comportement dont dépendent les tests de rollback.
 */
export class FakeMongo {
  private readonly collections = new Map<string, FakeCollection>();

  collection(name: string, seed: Doc[] = []): FakeCollection {
    const existing = this.collections.get(name);
    if (existing) return existing;
    const created = new FakeCollection(name, seed);
    this.collections.set(name, created);
    return created;
  }

  async runTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const context = new FakeTransactionContext();
    const session = { __context: context } as unknown as ClientSession;
    try {
      return await work(session);
    } catch (error) {
      for (const entry of [...context.writes].reverse()) {
        entry.collection.restore(entry.id, entry.before);
      }
      throw error;
    }
  }
}

/** TransactionService de test : commit implicite, rollback sur exception. */
export function buildFakeTransactionService(mongo: FakeMongo): {
  run: <T>(scope: string, work: (session: ClientSession) => Promise<T>) => Promise<T>;
} {
  return { run: (_scope, work) => mongo.runTransaction(work) };
}

/**
 * IdempotencyService de test reproduisant les trois règles contractuelles :
 *   même clé + même payload  → même résultat, opération exécutée une seule fois
 *   même clé + payload autre → erreur stable
 *   clé différente           → nouvelle tentative légitime
 */
export class FakeIdempotencyService {
  private readonly entries = new Map<
    string,
    { fingerprint: string; status: 'PROCESSING' | 'SUCCEEDED'; result?: unknown }
  >();

  constructor(private readonly mongo: FakeMongo) {}

  async execute<T>(params: IdempotencyExecuteParams<T>): Promise<T> {
    if (!params.idempotencyKey?.trim()) throw new IdempotencyKeyRequiredError();
    const id = `${params.scope}|${params.actorId}|${params.idempotencyKey}`;
    const fingerprint = computeFingerprint(params.payload);
    const existing = this.entries.get(id);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyKeyReusedWithDifferentPayloadError();
      }
      if (existing.status === 'SUCCEEDED') return existing.result as T;
      throw new OperationAlreadyProcessingError(params.scope);
    }

    this.entries.set(id, { fingerprint, status: 'PROCESSING' });
    try {
      const result = await this.mongo.runTransaction((session) => params.operation(session));
      this.entries.set(id, {
        fingerprint,
        status: 'SUCCEEDED',
        result: params.toReplayResult ? params.toReplayResult(result) : result,
      });
      return result;
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
  }
}

// ── Utilitaires de correspondance ───────────────────────────────────────────

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof Types.ObjectId) return value as unknown as T;
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  const copy: Doc = {};
  for (const [key, nested] of Object.entries(value as Doc)) copy[key] = clone(nested);
  return copy as unknown as T;
}

function readPath(document: Doc, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Doc)[segment];
  }, document);
}

function writePath(document: Doc, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Doc = document;
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
    cursor = cursor[segment] as Doc;
  }
  cursor[segments[segments.length - 1]] = value;
}

export function matches(document: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([path, condition]) => {
    if (path === '$expr') return Boolean(evaluateAggregation(condition, document));
    const actual = readPath(document, path);
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Types.ObjectId) && !(condition instanceof Date)) {
      return Object.entries(condition as Doc).every(([operator, operand]) => {
        switch (operator) {
          case '$in':
            return (operand as unknown[]).some((value) => equals(actual, value));
          case '$lte':
            return compare(actual, operand) <= 0;
          case '$gte':
            return compare(actual, operand) >= 0;
          case '$ne':
            return !equals(actual, operand);
          case '$type':
            return actual !== undefined && actual !== null;
          default:
            throw new Error(`FAKE_UNSUPPORTED_OPERATOR:${operator}`);
        }
      });
    }
    return equals(actual, condition);
  });
}

function applyUpdate(document: Doc, update: Doc): void {
  for (const [path, value] of Object.entries((update.$set as Doc) ?? {})) {
    writePath(document, path, clone(value));
  }
  for (const [path, delta] of Object.entries((update.$inc as Record<string, number>) ?? {})) {
    writePath(document, path, Number(readPath(document, path) ?? 0) + delta);
  }
}

function equals(left: unknown, right: unknown): boolean {
  // MongoDB : `{ champ: null }` sélectionne aussi les documents où le champ est absent.
  if (right === null) return left === null || left === undefined;
  if (left instanceof Types.ObjectId || right instanceof Types.ObjectId) {
    if (left === null || left === undefined || right === null || right === undefined) {
      return left === right || (left ?? null) === (right ?? null);
    }
    return String(left) === String(right);
  }
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function compare(left: unknown, right: unknown): number {
  const toValue = (value: unknown): number | string => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' || typeof value === 'string') return value;
    return String(value);
  };
  const a = toValue(left);
  const b = toValue(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Évaluateur des expressions d'agrégation utilisées par le domaine Ticketing. */
export function evaluateAggregation(node: unknown, document: Doc): unknown {
  if (typeof node === 'string' && node.startsWith('$')) {
    return readPath(document, node.slice(1));
  }
  if (node === null || typeof node !== 'object') return node;
  const [operator, operand] = Object.entries(node as Doc)[0];
  const operands = (Array.isArray(operand) ? operand : [operand]).map((item) =>
    evaluateAggregation(item, document),
  );
  switch (operator) {
    case '$add':
      return operands.reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
    case '$lte':
      return Number(operands[0]) <= Number(operands[1]);
    case '$gte':
      return Number(operands[0]) >= Number(operands[1]);
    case '$ifNull':
      return operands[0] ?? operands[1];
    default:
      throw new Error(`FAKE_UNSUPPORTED_EXPRESSION:${operator}`);
  }
}
