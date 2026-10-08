import * as assert from 'assert';

import { compareCodeUnits } from '../../src/utils/compareCodeUnits';

suite('compareCodeUnits', () => {
  test('matches default sort order for mixed-case Latin and Cyrillic strings', () => {
    const values = ['я', 'z', 'Б', 'a', 'Я', 'A', 'б', 'Z'];

    assert.deepStrictEqual([...values].sort(compareCodeUnits), ['A', 'Z', 'a', 'z', 'Б', 'Я', 'б', 'я']);
    assert.deepStrictEqual([...values].sort(compareCodeUnits), [...values].sort());
  });

  test('returns zero for identical strings', () => {
    assert.strictEqual(compareCodeUnits('Одинаково', 'Одинаково'), 0);
  });
});
