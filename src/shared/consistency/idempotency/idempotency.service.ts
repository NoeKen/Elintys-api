import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import {
  IdempotentOperation,
  IdempotentOperationDocument,
  IdempotentOperationStatus,
} from './idempotent-operation.schema';
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedWithDifferentPayloadError,
  OperationAlreadyProcessingError,
} from '../errors/consistency.errors';
import { CriticalOperationLogger } from '../observability/critical-operation.logger';
import { TransactionService } from '../transactions/transaction.service';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REPLAY_RESULT_BYTES = 64 * 1024;

export interface IdempotencyExecuteParams<TResult> {
  /** Domaine métier — 'ticket-purchase' | 'stripe-webhook' | 'event-registration' | … */
  scope: string;
  /** Identité serveur de l'acteur ou de la ressource. */
  actorId: string;
  /** Clé d'idempotence brute. Elle est immédiatement hashée et n'est jamais persistée. */
  idempotencyKey: string;
  /** Valeurs métier stables utilisées uniquement pour calculer le fingerprint. */
  payload: Record<string, unknown>;
  /**
   * Mutation DB à exécuter. Toute opération Mongoose doit recevoir cette session.
   * Les effets externes (HTTP, email, Stripe API) sont interdits dans ce callback.
   */
  operation: (session: ClientSession) => Promise<TResult>;
  /** Projection JSON minimale rejouable. Par défaut, TResult est sérialisé directement. */
  toReplayResult?: (result: TResult) => unknown;
}

/**
 * Coordinateur d'idempotence persistant pour les mutations MongoDB critiques.
 *
 * L'effet métier et le passage à SUCCEEDED sont commités dans la même transaction.
 * Ainsi, un crash ne peut pas laisser un effet métier commité avec un état idempotent
 * encore PROCESSING. Un lease expiré est repris atomiquement par une autre instance.
 *
 * Cette primitive ne remplace pas les contraintes métier en base (index unique,
 * mise à jour conditionnelle du stock). Elle les orchestre avec un replay déterministe.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new CriticalOperationLogger('IdempotencyService');

  constructor(
    @InjectModel(IdempotentOperation.name)
    private readonly model: Model<IdempotentOperationDocument>,
    private readonly transactions: TransactionService,
  ) {}

  async execute<TResult>(params: IdempotencyExecuteParams<TResult>): Promise<TResult> {
    const { scope, actorId, idempotencyKey, payload, operation, toReplayResult } = params;
    this.validateIdentity(scope, actorId, idempotencyKey);

    const keyHash = hashIdempotencyKey(idempotencyKey);
    const fingerprint = computeFingerprint(payload);
    const ownerToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + DEFAULT_LEASE_MS);

    let observed: IdempotentOperation | null;
    try {
      observed = await this.model
        .findOneAndUpdate(
          { scope, actorId, keyHash },
          {
            $setOnInsert: {
              fingerprint,
              ownerToken,
              status: IdempotentOperationStatus.PROCESSING,
              result: null,
              errorCode: null,
              lockedAt: now,
              leaseExpiresAt,
              completedAt: null,
              expiresAt: null,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .lean<IdempotentOperation>();
    } catch (error: unknown) {
      if ((error as { code?: number } | null)?.code !== 11000) throw error;

      // Course d'upsert multi-instance : l'index unique choisit le gagnant.
      // Le perdant relit l'état durable et suit le chemin replay/conflit normal.
      observed = await this.model
        .findOne({ scope, actorId, keyHash })
        .lean<IdempotentOperation>();
      if (!observed) throw error;
    }

    if (!observed) {
      throw new OperationAlreadyProcessingError(scope);
    }

    if (observed.fingerprint !== fingerprint) {
      this.logger.logConflict(scope, actorId, keyHash, 'different_payload');
      throw new IdempotencyKeyReusedWithDifferentPayloadError();
    }

    if (observed.status === IdempotentOperationStatus.SUCCEEDED) {
      this.logger.logReplay(scope, actorId, keyHash);
      return observed.result as TResult;
    }

    let claimed = observed.ownerToken === ownerToken ? observed : null;

    if (!claimed) {
      claimed = await this.model
        .findOneAndUpdate(
          {
            scope,
            actorId,
            keyHash,
            fingerprint,
            $or: [
              { status: IdempotentOperationStatus.FAILED },
              {
                status: IdempotentOperationStatus.PROCESSING,
                leaseExpiresAt: { $lte: now },
              },
            ],
          },
          {
            $set: {
              status: IdempotentOperationStatus.PROCESSING,
              ownerToken,
              lockedAt: now,
              leaseExpiresAt,
              completedAt: null,
              expiresAt: null,
              result: null,
              errorCode: null,
            },
          },
          { new: true },
        )
        .lean<IdempotentOperation>();
    }

    if (!claimed) {
      this.logger.logConflict(scope, actorId, keyHash, 'already_processing');
      throw new OperationAlreadyProcessingError(scope);
    }

    const isRetry = observed.ownerToken !== ownerToken;
    if (isRetry) {
      this.logger.logRetry(scope, actorId, keyHash);
    } else {
      this.logger.logStarted(scope, actorId, keyHash, fingerprint);
    }

    const startedAt = Date.now();
    try {
      const result = await this.transactions.run(scope, async (session) => {
        const replayResult = await operation(session);
        const persistedResult = serializeReplayResult(
          toReplayResult ? toReplayResult(replayResult) : replayResult,
        );

        const completedAt = new Date();
        const finalized = await this.model.updateOne(
          {
            scope,
            actorId,
            keyHash,
            fingerprint,
            ownerToken,
            status: IdempotentOperationStatus.PROCESSING,
          },
          {
            $set: {
              status: IdempotentOperationStatus.SUCCEEDED,
              result: persistedResult,
              completedAt,
              expiresAt: new Date(completedAt.getTime() + DEFAULT_RETENTION_MS),
            },
          },
          { session },
        );

        if (finalized.modifiedCount !== 1) {
          throw new OperationAlreadyProcessingError(scope);
        }
        return replayResult;
      });

      this.logger.logSucceeded(scope, actorId, keyHash, Date.now() - startedAt);
      return result;
    } catch (error: unknown) {
      try {
        await this.markFailedIfOwned(scope, actorId, keyHash, fingerprint, ownerToken, error);
      } catch {
        // Preserve the business error. The expired lease remains recoverable if this
        // best-effort bookkeeping write is itself unavailable.
      }
      const errorCode = error instanceof Error ? error.constructor.name : 'UNKNOWN_ERROR';
      this.logger.logFailed(scope, actorId, keyHash, Date.now() - startedAt, errorCode);
      throw error;
    }
  }

  private async markFailedIfOwned(
    scope: string,
    actorId: string,
    keyHash: string,
    fingerprint: string,
    ownerToken: string,
    error: unknown,
  ): Promise<void> {
    const completedAt = new Date();
    const errorCode = error instanceof Error ? error.constructor.name : 'UNKNOWN_ERROR';
    await this.model.updateOne(
      {
        scope,
        actorId,
        keyHash,
        fingerprint,
        ownerToken,
        status: IdempotentOperationStatus.PROCESSING,
      },
      {
        $set: {
          status: IdempotentOperationStatus.FAILED,
          errorCode,
          completedAt,
          expiresAt: new Date(completedAt.getTime() + DEFAULT_RETENTION_MS),
        },
      },
    );
  }

  private validateIdentity(scope: string, actorId: string, key: string): void {
    if (!key || !key.trim()) throw new IdempotencyKeyRequiredError();
    if (!scope.trim() || !actorId.trim()) {
      throw new TypeError('Idempotency scope and actorId are required');
    }
  }
}

export function hashIdempotencyKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function computeFingerprint(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== 'object') return nested;
    if (seen.has(nested)) throw new TypeError('Idempotency payload must not be cyclic');
    seen.add(nested);
    if (Array.isArray(nested)) return nested;
    return Object.keys(nested as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((ordered, key) => {
        ordered[key] = (nested as Record<string, unknown>)[key];
        return ordered;
      }, {});
  });
}

function serializeReplayResult(result: unknown): unknown {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new TypeError('Idempotent operation result must be JSON serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REPLAY_RESULT_BYTES) {
    throw new TypeError('Idempotent operation replay result exceeds 64 KiB');
  }
  return JSON.parse(serialized) as unknown;
}
