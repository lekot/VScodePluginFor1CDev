import * as assert from 'assert';
import { convertStringBooleans } from '../../src/utils/xmlPropertyUtils';

suite('xmlPropertyUtils', () => {
  test('converts only exact "true"/"false" strings', () => {
    const input = {
      yes: 'true',
      no: 'false',
      upper: 'TRUE',
      mixed: 'False',
      text: 'not-bool',
      num: 123,
      flag: true,
      none: null,
    } as Record<string, unknown>;

    const result = convertStringBooleans(input);

    assert.deepStrictEqual(result, {
      yes: true,
      no: false,
      upper: 'TRUE',
      mixed: 'False',
      text: 'not-bool',
      num: 123,
      flag: true,
      none: null,
    });
  });

  test('returns empty object for empty input object', () => {
    const result = convertStringBooleans({});
    assert.deepStrictEqual(result, {});
  });

  test('does not mutate original object', () => {
    const input: Record<string, unknown> = { x: 'true', y: 'false' };
    const original = { ...input };

    const result = convertStringBooleans(input);

    assert.deepStrictEqual(input, original);
    assert.notStrictEqual(result, input);
  });
});
