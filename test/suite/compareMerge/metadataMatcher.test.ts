import * as assert from 'assert';

import { matchMetadataIdentities } from '../../../src/compareMerge/metadata/metadataMatcher';
import type { CompareSide, MetadataIdentity } from '../../../src/compareMerge/domain/compareContracts';

suite('MetadataMatcher', () => {
  test('matches same uuid and name as a strong uuid match', () => {
    const result = matchMetadataIdentities({
      left: [identity('left', 'Catalog.Products', 'uuid-products')],
      right: [identity('right', 'Catalog.Products', 'uuid-products')],
    });

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].confidence, 'strong');
    assert.strictEqual(result.matches[0].matchKind, 'uuid');
    assert.strictEqual(result.conflicts.length, 0);
    assert.strictEqual(result.diagnostics.length, 0);
  });

  test('reports same qualified name with different uuid as conflict and keeps comparable name match', () => {
    const result = matchMetadataIdentities({
      left: [identity('left', 'Catalog.Products', 'left-uuid')],
      right: [identity('right', 'Catalog.Products', 'right-uuid')],
    });

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].matchKind, 'qualifiedName');
    assert.strictEqual(result.matches[0].confidence, 'nameOnly');
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].kind, 'sameNameDifferentUuid');
    assert.strictEqual(result.conflicts[0].resolution, 'manual');
    assert.strictEqual(result.conflicts[0].blocking, true);
    assert.deepStrictEqual(result.unmatchedLeft, []);
    assert.deepStrictEqual(result.unmatchedRight, []);
  });

  test('reports same uuid with different qualified name as conflict and keeps strong uuid match', () => {
    const result = matchMetadataIdentities({
      left: [identity('left', 'Catalog.Products', 'same-uuid')],
      right: [identity('right', 'Catalog.Goods', 'same-uuid')],
    });

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].matchKind, 'uuid');
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].kind, 'sameUuidDifferentName');
    assert.strictEqual(result.conflicts[0].resolution, 'manual');
    assert.strictEqual(result.conflicts[0].blocking, false);
  });

  test('blocks occupied old name when uuid match is renamed and replacement uses that name', () => {
    const leftProducts = identity('left', 'Catalog.Products', 'uuid-a');
    const rightGoods = identity('right', 'Catalog.Goods', 'uuid-a');
    const rightProducts = identity('right', 'Catalog.Products', 'uuid-b');

    const result = matchMetadataIdentities({
      left: [leftProducts],
      right: [rightGoods, rightProducts],
    });

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].left, leftProducts);
    assert.strictEqual(result.matches[0].right, rightGoods);
    assert.deepStrictEqual(
      result.conflicts.map((conflict) => conflict.kind).sort(),
      ['sameNameDifferentUuid', 'sameUuidDifferentName']
    );

    const sameNameConflict = result.conflicts.find(
      (conflict) => conflict.kind === 'sameNameDifferentUuid'
    );
    assert.ok(sameNameConflict);
    assert.strictEqual(sameNameConflict.blocking, true);
    assert.strictEqual(sameNameConflict.left, leftProducts);
    assert.strictEqual(sameNameConflict.right, rightProducts);
  });

  test('matches missing uuid identities by qualified name', () => {
    const result = matchMetadataIdentities({
      left: [identity('left', 'Document.SalesOrder')],
      right: [identity('right', 'Document.SalesOrder')],
    });

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].confidence, 'nameOnly');
    assert.strictEqual(result.matches[0].matchKind, 'qualifiedName');
    assert.strictEqual(result.conflicts.length, 0);
  });

  test('blocks auto match for duplicate uuid or qualified name within one side', () => {
    const result = matchMetadataIdentities({
      left: [
        identity('left', 'Catalog.Products', 'duplicate-uuid', 'left-1.xml'),
        identity('left', 'Catalog.ProductsArchive', 'duplicate-uuid', 'left-2.xml'),
        identity('left', 'Document.SalesOrder', undefined, 'left-3.xml'),
        identity('left', 'Document.SalesOrder', undefined, 'left-4.xml'),
      ],
      right: [
        identity('right', 'Catalog.Products', 'duplicate-uuid', 'right-1.xml'),
        identity('right', 'Document.SalesOrder', undefined, 'right-2.xml'),
      ],
    });

    assert.strictEqual(result.matches.length, 0);
    assert.strictEqual(result.conflicts.length, 2);
    assert.deepStrictEqual(
      result.conflicts.map((conflict) => conflict.kind).sort(),
      ['duplicateQualifiedName', 'duplicateUuid']
    );
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ['DUPLICATE_METADATA_QUALIFIED_NAME', 'DUPLICATE_METADATA_UUID']
    );
    assert.ok(result.conflicts.every((conflict) => conflict.blocking));
  });
});

function identity(
  side: CompareSide,
  qualifiedName: string,
  uuid?: string,
  filePath = `${side}-${qualifiedName}.xml`
): MetadataIdentity {
  const metadataType = qualifiedName.split('.')[0] ?? 'Unknown';
  return {
    sourceId: `${side}-source`,
    side,
    metadataType,
    qualifiedName,
    uuid,
    filePath,
    containerPath: `${side}-container`,
    objectPath: qualifiedName,
    nameSource: 'xmlPropertiesName',
    uuidSource: uuid ? 'xmlAttribute' : 'missing',
    confidence: uuid ? 'strong' : 'nameOnly',
  };
}
