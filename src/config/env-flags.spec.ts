import { isOptInFlagEnabled, isOptOutFlagEnabled } from './env-flags';

describe('env-flags', () => {
  it.each([
    ['true', true],
    ['false', false],
    [undefined, false],
    ['', false],
    ['TRUE', false],
    [' true', false],
  ])('isOptInFlagEnabled(%p) devrait valoir %p', (raw, expected) => {
    expect(isOptInFlagEnabled(raw)).toBe(expected);
  });

  it.each([
    ['false', false],
    ['true', true],
    [undefined, true],
    ['', true],
    ['FALSE', true],
    [' false', true],
  ])('isOptOutFlagEnabled(%p) devrait valoir %p', (raw, expected) => {
    expect(isOptOutFlagEnabled(raw)).toBe(expected);
  });
});
