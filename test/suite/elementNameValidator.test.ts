import * as assert from 'assert';
import { validateElementName } from '../../src/utils/elementNameValidator';

suite('elementNameValidator', () => {
  test('returns error for empty name', () => {
    assert.ok(validateElementName('', [])?.includes('пуст'));
    assert.ok(validateElementName('   ', [])?.includes('пуст'));
  });

  test('returns error for invalid characters', () => {
    assert.ok(validateElementName('Name With Space', [])?.includes('буквы'));
    assert.ok(validateElementName('name-with-dash', [])?.includes('буквы'));
    assert.ok(validateElementName('name.dotted', [])?.includes('буквы'));
  });

  test('returns null for valid name and no sibling conflict', () => {
    assert.strictEqual(validateElementName('ValidName', []), null);
    assert.strictEqual(validateElementName('Valid_Name_123', []), null);
    assert.strictEqual(validateElementName('Имя', []), null);
    assert.strictEqual(validateElementName('  Trimmed  ', []), null);
  });

  test('returns error when name duplicates sibling (case-insensitive)', () => {
    assert.ok(validateElementName('Existing', ['Existing'])?.includes('уже существует'));
    assert.ok(validateElementName('existing', ['Existing'])?.includes('уже существует'));
    assert.ok(validateElementName('EXISTING', ['Existing'])?.includes('уже существует'));
  });

  test('returns null when same spelling but different sibling set', () => {
    assert.strictEqual(validateElementName('Unique', ['Other']), null);
  });

  test('returns error for name starting with digit', () => {
    assert.ok(validateElementName('1Name', [])?.includes('цифры'));
    assert.ok(validateElementName('123Test', [])?.includes('цифры'));
  });

  test('returns error for name exceeding maximum length', () => {
    const longName = 'A'.repeat(81);
    assert.ok(validateElementName(longName, [])?.includes('80'));
  });

  test('returns null for name at maximum length', () => {
    const maxName = 'A'.repeat(80);
    assert.strictEqual(validateElementName(maxName, []), null);
  });

  test('returns error for reserved keywords', () => {
    assert.ok(validateElementName('Procedure', [])?.includes('зарезервированным'));
    assert.ok(validateElementName('Function', [])?.includes('зарезервированным'));
    assert.ok(validateElementName('Процедура', [])?.includes('зарезервированным'));
    assert.ok(validateElementName('Функция', [])?.includes('зарезервированным'));
    assert.ok(validateElementName('If', [])?.includes('зарезервированным'));
    assert.ok(validateElementName('Если', [])?.includes('зарезервированным'));
  });

  test('returns null for valid names that are not reserved', () => {
    assert.strictEqual(validateElementName('MyProcedure', []), null);
    assert.strictEqual(validateElementName('CustomFunction', []), null);
    assert.strictEqual(validateElementName('МояПроцедура', []), null);
  });
});
