import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { fileObjectAdapter } from '../../../src/compareMerge/adapters/fileObjectAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { MISSING_TARGET_HASH } from '../../../src/compareMerge/merge/mergePreview';

suite('File object merge adapter', () => {
  test('exposes missing form XML artifact on matched metadata object as selectable copy', async () => {
    const input = makeInput();
    const result = await fileObjectAdapter.compare(input);

    const form = result.nodes.find((node) => node.label === 'Form.xml');

    assert.ok(form);
    assert.strictEqual(form.status, 'rightOnly');
    assert.strictEqual(form.mergeable, true);
    assert.strictEqual(result.candidateFactories.has(form.id), true);

    const candidateResult = await result.candidateFactories.get(form.id)!();
    assert.strictEqual(candidateResult.ok, true);
    assert.strictEqual(candidateResult.candidate.kind, 'fileCopy');
    assert.strictEqual(candidateResult.candidate.expectedOldHash, MISSING_TARGET_HASH);
    assert.strictEqual(
      candidateResult.candidate.fileOperation?.targetPath,
      pathToFileURL(path.normalize('/left/Catalogs/Products/Forms/Main/Ext/Form.xml')).toString()
    );
  });
});

function makeInput(): AdapterCompareInput {
  const leftRoot = path.normalize('/left');
  const rightRoot = path.normalize('/right');
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-31T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Left',
        rootUri: 'file:///left',
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'file',
        displayName: 'Right',
        rootUri: 'file:///right',
        writable: false,
      },
    ],
  });
  session.registerSnapshot({
    snapshotId: 'snapshot-right',
    sourceId: 'right-source',
    snapshotRoot: 'file:///right',
    origin: 'file:///right',
    createdAt: '2026-05-31T10:00:00.000Z',
    retentionUntil: '2026-05-31T11:00:00.000Z',
    sourceRevision: 'test:right',
    readOnly: true,
    cleanupPolicy: 'manual',
    contentHash: 'sha256:right',
  });

  const leftObject = {
    objectId: 'left-products',
    qualifiedName: 'Catalog.Products',
    metadataType: 'Catalog',
    uuid: 'catalog-products',
    descriptorPath: path.join(leftRoot, 'Catalogs', 'Products.xml'),
    containerPath: path.join(leftRoot, 'Catalogs', 'Products'),
  };
  const rightObject = {
    ...leftObject,
    objectId: 'right-products',
    descriptorPath: path.join(rightRoot, 'Catalogs', 'Products.xml'),
    containerPath: path.join(rightRoot, 'Catalogs', 'Products'),
  };
  const rightFormPath = path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml');

  return {
    strategy: 'right',
    leftInventory: {
      rootPath: leftRoot,
      objects: [leftObject],
      artifactsByObjectId: new Map([[leftObject.objectId, []]]),
    },
    rightInventory: {
      rootPath: rightRoot,
      objects: [rightObject],
      artifactsByObjectId: new Map([
        [
          rightObject.objectId,
          [
            {
              artifactId: 'right-form',
              kind: 'formXml',
              filePath: rightFormPath,
              relativePath: path.relative(rightRoot, rightFormPath),
              contentHash: 'sha256:right-form',
              mergeMode: 'xmlPatch',
            },
          ],
        ],
      ]),
    },
    match: {
      left: leftObject,
      right: rightObject,
    },
    session,
    snapshots: { left: '', right: '' },
  };
}
