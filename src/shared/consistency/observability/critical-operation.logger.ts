import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';

export interface CriticalOperationLogEntry {
  operationType: 'idempotency' | 'transaction';
  scope?: string;
  actorId?: string;
  status: 'started' | 'succeeded' | 'failed' | 'replay' | 'conflict' | 'retry';
  durationMs?: number;
  replay?: boolean;
  transactionOutcome?: 'committed' | 'rolledback';
  keyHashPrefix?: string;
  fingerprintPrefix?: string;
  errorCode?: string;
}

/**
 * Logger structuré pour les opérations critiques.
 *
 * Règles de sécurité :
 * - Jamais la clé d'idempotence complète (peut contenir un token ou un secret)
 * - Jamais le fingerprint complet
 * - Jamais l'actorId en clair si c'est un stripePaymentIntentId
 * - Toujours uniquement un préfixe de hash, jamais un préfixe de valeur brute
 */
export class CriticalOperationLogger {
  private readonly logger: Logger;

  constructor(context = 'CriticalOperations') {
    this.logger = new Logger(context);
  }

  logStarted(scope: string, actorId: string, keyHash: string, fingerprint: string): void {
    this.emit({
      operationType: 'idempotency',
      scope,
      actorId: this.hashIdentifier(actorId),
      status: 'started',
      keyHashPrefix: this.prefix(keyHash),
      fingerprintPrefix: this.prefix(fingerprint),
    });
  }

  logSucceeded(scope: string, actorId: string, keyHash: string, durationMs: number): void {
    this.emit({
      operationType: 'idempotency',
      scope,
      actorId: this.hashIdentifier(actorId),
      status: 'succeeded',
      durationMs,
      keyHashPrefix: this.prefix(keyHash),
    });
  }

  logFailed(scope: string, actorId: string, keyHash: string, durationMs: number, errorCode: string): void {
    this.emit({
      operationType: 'idempotency',
      scope,
      actorId: this.hashIdentifier(actorId),
      status: 'failed',
      durationMs,
      keyHashPrefix: this.prefix(keyHash),
      errorCode,
    });
  }

  logReplay(scope: string, actorId: string, keyHash: string): void {
    this.emit({
      operationType: 'idempotency',
      scope,
      actorId: this.hashIdentifier(actorId),
      status: 'replay',
      replay: true,
      keyHashPrefix: this.prefix(keyHash),
    });
  }

  logConflict(scope: string, actorId: string, keyHash: string, reason: 'already_processing' | 'different_payload'): void {
    this.emit({
      operationType: 'idempotency',
      scope,
      actorId: this.hashIdentifier(actorId),
      status: 'conflict',
      keyHashPrefix: this.prefix(keyHash),
      errorCode: reason === 'already_processing'
        ? 'OPERATION_ALREADY_PROCESSING'
        : 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    });
  }

  logRetry(scope: string, actorId: string, keyHash: string): void {
    this.emit({
      operationType: 'idempotency',
      scope,
      actorId: this.hashIdentifier(actorId),
      status: 'retry',
      keyHashPrefix: this.prefix(keyHash),
    });
  }

  logTransactionStarted(scope: string): void {
    this.emit({ operationType: 'transaction', scope, status: 'started' });
  }

  logTransactionCommitted(scope: string, durationMs: number): void {
    this.emit({ operationType: 'transaction', scope, status: 'succeeded', durationMs, transactionOutcome: 'committed' });
  }

  logTransactionRolledBack(scope: string, durationMs: number, errorCode: string): void {
    this.emit({ operationType: 'transaction', scope, status: 'failed', durationMs, transactionOutcome: 'rolledback', errorCode });
  }

  private emit(entry: CriticalOperationLogEntry): void {
    const { status, errorCode } = entry;
    const msg = JSON.stringify(entry);
    if (status === 'failed' || errorCode) {
      this.logger.warn(msg);
    } else {
      this.logger.log(msg);
    }
  }

  private prefix(value: string, length = 8): string {
    return value.slice(0, length);
  }

  /** Tous les identifiants sont hashés : les logs ne sont pas une seconde base utilisateur. */
  private hashIdentifier(actorId: string): string {
    return createHash('sha256').update(actorId).digest('hex').slice(0, 12);
  }
}
