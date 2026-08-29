import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { ErrorCodes } from '../../constants/error-codes';

export const ConsistencyErrorCodes = {
  IDEMPOTENCY_KEY_REQUIRED: ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: ErrorCodes.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
  OPERATION_ALREADY_PROCESSING: ErrorCodes.OPERATION_ALREADY_PROCESSING,
  INSUFFICIENT_CAPACITY: ErrorCodes.INSUFFICIENT_CAPACITY,
  REGISTRATION_ALREADY_EXISTS: ErrorCodes.REGISTRATION_ALREADY_EXISTS,
} as const;

export type ConsistencyErrorCode = (typeof ConsistencyErrorCodes)[keyof typeof ConsistencyErrorCodes];

export class IdempotencyKeyRequiredError extends BadRequestException {
  constructor() {
    super(ConsistencyErrorCodes.IDEMPOTENCY_KEY_REQUIRED);
  }
}

export class IdempotencyKeyReusedWithDifferentPayloadError extends ConflictException {
  constructor() {
    super(ConsistencyErrorCodes.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD);
  }
}

export class OperationAlreadyProcessingError extends ConflictException {
  constructor(public readonly scope: string) {
    super(ConsistencyErrorCodes.OPERATION_ALREADY_PROCESSING);
  }
}

export class InsufficientCapacityError extends BadRequestException {
  constructor(message: string = ConsistencyErrorCodes.INSUFFICIENT_CAPACITY) {
    super(message);
  }
}

export class RegistrationAlreadyExistsError extends ConflictException {
  constructor() {
    super(ConsistencyErrorCodes.REGISTRATION_ALREADY_EXISTS);
  }
}

/**
 * Traduit une erreur MongoDB E11000 en exception HTTP métier ciblée.
 *
 * Inspecte keyPattern/keyValue pour distinguer l'index en cause.
 * Ne traduit jamais aveuglément : si l'index n'est pas reconnu,
 * renvoie l'erreur originale (jamais un message trompeur).
 *
 * Ne logue jamais les valeurs d'index (peuvent contenir des données sensibles).
 */
export function translateMongoE11000(
  error: unknown,
  knownIndexes: Record<string, HttpException>,
  logUnknown?: (indexKeys: string) => void,
): Error {
  const mongoError = error as {
    code?: number;
    keyPattern?: Record<string, unknown>;
  };

  if (mongoError?.code !== 11000) {
    return error as Error;
  }

  const indexKeys = Object.keys(mongoError.keyPattern ?? {})
    .sort()
    .join(',');

  if (knownIndexes[indexKeys]) {
    return knownIndexes[indexKeys];
  }

  logUnknown?.(indexKeys);
  return error as Error;
}
