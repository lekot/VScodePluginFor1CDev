import * as assert from 'assert';

import { compareOrdinalStrings } from '../../../src/compareMerge/ordinalStringOrder';

suite('Ordinal string ordering', () => {
  test('matches native default sort for identity and hash strings across Unicode cases', () => {
    const values = [
      '',
      'ASCII',
      'ASCII',
      'ascii',
      'A',
      'a',
      '-',
      '.',
      ':',
      '_',
      '{http://v8.1c.ru/8.3/MDClasses}Catalog',
      '{http://v8.1c.ru/8.3/xcf/readable}GeneratedType',
      'Catalog.Products',
      'Catalog/Products.xml',
      'ё',
      'е',
      'Ж',
      'ж',
      '\u0301',
      'e\u0301',
      'é',
      '\uE000',
      '\u{10000}',
      '\u{1F600}',
    ];

    assert.deepStrictEqual(
      [...values].sort(compareOrdinalStrings),
      [...values].sort(),
      'the explicit comparator must preserve default Array.sort() UTF-16 ordering exactly'
    );
  });
});
