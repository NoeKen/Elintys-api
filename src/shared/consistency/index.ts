export { ConsistencyModule } from './consistency.module';
export {
  IdempotencyService,
  computeFingerprint,
  hashIdempotencyKey,
} from './idempotency/idempotency.service';
export type { IdempotencyExecuteParams } from './idempotency/idempotency.service';
export { IdempotentOperation, IdempotentOperationStatus } from './idempotency/idempotent-operation.schema';
export type { IdempotentOperationDocument } from './idempotency/idempotent-operation.schema';
export { TransactionService } from './transactions/transaction.service';
export {
  ConsistencyErrorCodes,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedWithDifferentPayloadError,
  OperationAlreadyProcessingError,
  InsufficientCapacityError,
  RegistrationAlreadyExistsError,
  translateMongoE11000,
} from './errors/consistency.errors';
export type { ConsistencyErrorCode } from './errors/consistency.errors';
export { CriticalOperationLogger } from './observability/critical-operation.logger';
export type { CriticalOperationLogEntry } from './observability/critical-operation.logger';
