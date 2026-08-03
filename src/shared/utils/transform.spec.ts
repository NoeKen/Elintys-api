import type { TransformFnParams } from 'class-transformer';
import { trimValue, trimLowerValue } from './transform';

// Construit un TransformFnParams minimal (seul `value` est lu par les helpers).
function params(value: unknown): TransformFnParams {
  return { value } as unknown as TransformFnParams;
}

describe('transform helpers type-safe (F-017)', () => {
  describe('trimValue', () => {
    it('devrait couper les espaces des chaînes', () => {
      expect(trimValue(params('  hello  '))).toBe('hello');
    });

    it('devrait retourner une chaîne vide inchangée', () => {
      expect(trimValue(params('   '))).toBe('');
    });

    it.each([
      ['objet (opérateur Mongo)', { $ne: null }],
      ['tableau', ['a', 'b']],
      ['nombre', 42],
      ['booléen', true],
      ['null', null],
      ['undefined', undefined],
    ])('ne devrait PAS lever et laisser passer %s tel quel', (_label, value) => {
      expect(() => trimValue(params(value))).not.toThrow();
      expect(trimValue(params(value))).toBe(value);
    });
  });

  describe('trimLowerValue', () => {
    it('devrait couper et mettre en minuscules', () => {
      expect(trimLowerValue(params('  MARIE@Example.COM '))).toBe('marie@example.com');
    });

    it.each([
      ['objet (opérateur Mongo)', { $gt: '' }],
      ['tableau', [1, 2]],
      ['nombre', 7],
      ['null', null],
    ])('ne devrait PAS lever sur %s', (_label, value) => {
      expect(() => trimLowerValue(params(value))).not.toThrow();
      expect(trimLowerValue(params(value))).toBe(value);
    });
  });
});
