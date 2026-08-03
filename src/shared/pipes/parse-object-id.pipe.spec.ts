import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ParseObjectIdPipe } from './parse-object-id.pipe';

describe('ParseObjectIdPipe (F-033)', () => {
  const pipe = new ParseObjectIdPipe();

  it('devrait accepter un ObjectId hexadécimal de 24 caractères', () => {
    const id = new Types.ObjectId().toString();
    expect(pipe.transform(id)).toBe(id);
  });

  it.each([
    ['chaîne quelconque', 'pas-un-objectid'],
    ['trop court', '123'],
    ['chaîne vide', ''],
    ['12 caractères (faux positif de isValid)', 'abcdefghijkl'],
    ['25 caractères', '0123456789abcdef012345678'],
    ['caractères non hexadécimaux', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
  ])('devrait rejeter %s', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });

  it.each([
    ['objet', { $ne: null }],
    ['tableau', ['abc']],
    ['nombre', 42],
    ['null', null],
    ['undefined', undefined],
  ])('devrait rejeter une valeur non-string — %s', (_label, value) => {
    expect(() => pipe.transform(value as never)).toThrow(BadRequestException);
  });

  it('ne devrait pas divulguer de détail interne dans le message', () => {
    try {
      pipe.transform('pas-un-objectid');
    } catch (error) {
      expect((error as BadRequestException).message).toBe('INVALID_OBJECT_ID');
    }
  });
});
