import * as assert from 'assert';
import { ReferencesTable } from '../../src/debug/referencesTable';

suite('ReferencesTable', () => {

  test('add → get round-trip returns the same object', () => {
    const table = new ReferencesTable<{ x: number }>();
    const item = { x: 42 };
    const ref = table.add(item);
    assert.strictEqual(table.get(ref), item);
  });

  test('id starts at 1', () => {
    const table = new ReferencesTable<string>();
    const ref = table.add('first');
    assert.strictEqual(ref, 1);
  });

  test('id grows monotonically', () => {
    const table = new ReferencesTable<string>();
    const ref1 = table.add('a');
    const ref2 = table.add('b');
    const ref3 = table.add('c');
    assert.ok(ref1 < ref2, 'ref1 must be less than ref2');
    assert.ok(ref2 < ref3, 'ref2 must be less than ref3');
  });

  test('get on absent id returns undefined', () => {
    const table = new ReferencesTable<number>();
    assert.strictEqual(table.get(99), undefined);
    table.add(1);
    assert.strictEqual(table.get(2), undefined);
  });

  test('clear() with no predicate removes all entries', () => {
    const table = new ReferencesTable<number>();
    table.add(1);
    table.add(2);
    table.add(3);
    assert.strictEqual(table.size, 3);
    table.clear();
    assert.strictEqual(table.size, 0);
  });

  test('clear(predicate) removes only matching entries', () => {
    const table = new ReferencesTable<{ threadId: number }>();
    const ref1 = table.add({ threadId: 1 });
    const ref2 = table.add({ threadId: 2 });
    const ref3 = table.add({ threadId: 1 });
    table.clear(item => item.threadId === 1);
    assert.strictEqual(table.size, 1);
    assert.strictEqual(table.get(ref1), undefined);
    assert.notStrictEqual(table.get(ref2), undefined);
    assert.strictEqual(table.get(ref3), undefined);
  });

  test('clear does not reset the counter — new ids after clear do not collide with old ones', () => {
    const table = new ReferencesTable<string>();
    const ref1 = table.add('a');
    const ref2 = table.add('b');
    table.clear();
    const ref3 = table.add('c');
    const ref4 = table.add('d');
    assert.ok(ref3 > ref2, 'new id after clear must be greater than any previous id');
    assert.ok(ref4 > ref3);
    // Old ids must no longer be resolvable
    assert.strictEqual(table.get(ref1), undefined);
    assert.strictEqual(table.get(ref2), undefined);
    // New ids must resolve
    assert.strictEqual(table.get(ref3), 'c');
    assert.strictEqual(table.get(ref4), 'd');
  });

  test('size getter reflects current count', () => {
    const table = new ReferencesTable<boolean>();
    assert.strictEqual(table.size, 0);
    table.add(true);
    assert.strictEqual(table.size, 1);
    table.add(false);
    assert.strictEqual(table.size, 2);
    table.clear(x => x === true);
    assert.strictEqual(table.size, 1);
    table.clear();
    assert.strictEqual(table.size, 0);
  });

});
