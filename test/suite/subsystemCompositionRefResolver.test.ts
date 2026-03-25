import * as assert from 'assert';
import { expectedTreeNodeIdForCompositionRef } from '../../src/services/subsystemCompositionRefResolver';

suite('subsystemCompositionRefResolver', () => {
  test('expectedTreeNodeIdForCompositionRef maps Catalog to Catalogs', () => {
    assert.strictEqual(expectedTreeNodeIdForCompositionRef('Catalog.Items'), 'Catalogs.Items');
  });

  test('expectedTreeNodeIdForCompositionRef maps Subsystem to Subsystems', () => {
    assert.strictEqual(expectedTreeNodeIdForCompositionRef('Subsystem.Admin'), 'Subsystems.Admin');
  });

  test('expectedTreeNodeIdForCompositionRef returns null for invalid syntax', () => {
    assert.strictEqual(expectedTreeNodeIdForCompositionRef('bad'), null);
    assert.strictEqual(expectedTreeNodeIdForCompositionRef('A.B.C'), null);
  });

  test('expectedTreeNodeIdForCompositionRef returns null for unknown metadata type', () => {
    assert.strictEqual(expectedTreeNodeIdForCompositionRef('NotAType.Foo'), null);
  });
});
