import { ConflictException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import {
  ConsistencyErrorCodes,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedWithDifferentPayloadError,
  OperationAlreadyProcessingError,
  InsufficientCapacityError,
  RegistrationAlreadyExistsError,
  translateMongoE11000,
} from './consistency.errors';

describe('ConsistencyErrors', () => {
  describe('IdempotencyKeyRequiredError', () => {
    it('devrait être une BadRequestException avec le bon code', () => {
      const err = new IdempotencyKeyRequiredError();
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(ConsistencyErrorCodes.IDEMPOTENCY_KEY_REQUIRED);
    });
  });

  describe('IdempotencyKeyReusedWithDifferentPayloadError', () => {
    it('devrait être une ConflictException avec le bon code', () => {
      const err = new IdempotencyKeyReusedWithDifferentPayloadError();
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(ConsistencyErrorCodes.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD);
    });
  });

  describe('OperationAlreadyProcessingError', () => {
    it('devrait être une ConflictException avec le scope mais sans actorId exposé', () => {
      const err = new OperationAlreadyProcessingError('ticket-purchase');
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(ConsistencyErrorCodes.OPERATION_ALREADY_PROCESSING);
      expect(err.scope).toBe('ticket-purchase');
      expect(err).not.toHaveProperty('actorId');
    });
  });

  describe('InsufficientCapacityError', () => {
    it('devrait utiliser le code par défaut', () => {
      const err = new InsufficientCapacityError();
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(ConsistencyErrorCodes.INSUFFICIENT_CAPACITY);
    });

    it('devrait accepter un message personnalisé', () => {
      const err = new InsufficientCapacityError('Seulement 2 billets disponibles');
      expect(err.message).toBe('Seulement 2 billets disponibles');
    });
  });

  describe('RegistrationAlreadyExistsError', () => {
    it('devrait être une ConflictException avec le bon code', () => {
      const err = new RegistrationAlreadyExistsError();
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(ConsistencyErrorCodes.REGISTRATION_ALREADY_EXISTS);
    });
  });

  describe('translateMongoE11000', () => {
    it('devrait retourner l\'erreur originale si code != 11000', () => {
      const original = new Error('some other error');
      const result = translateMongoE11000(original, {});
      expect(result).toBe(original);
    });

    it('devrait retourner l\'erreur originale si code est absent', () => {
      const original = new Error('no code');
      const result = translateMongoE11000(original, {});
      expect(result).toBe(original);
    });

    it('devrait traduire un E11000 avec index reconnu', () => {
      const e11000 = { code: 11000, keyPattern: { scope: 1, actorId: 1, idempotencyKey: 1 } };
      const expected = new ConflictException('DUPLICATE');
      const result = translateMongoE11000(e11000, {
        'actorId,idempotencyKey,scope': expected,
      });
      expect(result).toBe(expected);
    });

    it('devrait retourner l\'erreur originale si index inconnu et appeler logUnknown', () => {
      const e11000 = { code: 11000, keyPattern: { unknownField: 1 } };
      const logFn = jest.fn();
      const result = translateMongoE11000(e11000, {}, logFn);
      expect(result).toBe(e11000);
      expect(logFn).toHaveBeenCalledWith('unknownField');
    });

    it('devrait trier les clés avant de chercher dans knownIndexes', () => {
      const e11000 = { code: 11000, keyPattern: { b: 1, a: 1 } };
      const expected = new InternalServerErrorException('TEST');
      const result = translateMongoE11000(e11000, { 'a,b': expected });
      expect(result).toBe(expected);
    });
  });
});
