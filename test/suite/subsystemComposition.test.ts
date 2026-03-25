/**
 * B.3 — subsystem composition ref merge + Content node shape (foundation before UI / XML write).
 */
import * as assert from 'assert';
import {
  buildSubsystemCompositionContentNode,
  extractSubsystemCompositionRefs,
  reconcileSubsystemCompositionRefs,
} from '../../src/parsers/xmlChildObjects';

suite('subsystem composition (B.3 helpers)', () => {
  test('reconcileSubsystemCompositionRefs adds valid refs and preserves order', () => {
    const { refs, rejected } = reconcileSubsystemCompositionRefs(['Catalog.Existing'], {
      add: ['Document.NewOne', 'Catalog.Existing'],
      remove: [],
    });
    assert.deepStrictEqual(rejected, []);
    assert.deepStrictEqual(refs, ['Catalog.Existing', 'Document.NewOne']);
  });

  test('reconcileSubsystemCompositionRefs rejects invalid add and still applies valid', () => {
    const { refs, rejected } = reconcileSubsystemCompositionRefs([], {
      add: ['bad', 'Catalog.Ok'],
      remove: [],
    });
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].ref, 'bad');
    assert.ok(rejected[0].reason.length > 0);
    assert.deepStrictEqual(refs, ['Catalog.Ok']);
  });

  test('reconcileSubsystemCompositionRefs remove is idempotent for missing', () => {
    const { refs } = reconcileSubsystemCompositionRefs(['Catalog.A'], {
      add: [],
      remove: ['Document.Gone', 'Catalog.A'],
    });
    assert.deepStrictEqual(refs, []);
  });

  test('buildSubsystemCompositionContentNode round-trips through extractSubsystemCompositionRefs', () => {
    const refs = ['Catalog.Items', 'Document.Order'];
    const node = buildSubsystemCompositionContentNode(refs);
    assert.deepStrictEqual(extractSubsystemCompositionRefs(node), refs);
  });

  test('buildSubsystemCompositionContentNode empty yields empty extract', () => {
    assert.deepStrictEqual(extractSubsystemCompositionRefs(buildSubsystemCompositionContentNode([])), []);
  });
});
