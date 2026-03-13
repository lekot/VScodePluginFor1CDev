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
});
