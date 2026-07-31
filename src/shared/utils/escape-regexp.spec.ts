import { escapeRegExp } from './escape-regexp';

describe('escapeRegExp', () => {
  it('neutralise les métacaractères avant une recherche MongoDB', () => {
    expect(escapeRegExp('Montréal.*(test)')).toBe(
      'Montréal\\.\\*\\(test\\)',
    );
  });
});
