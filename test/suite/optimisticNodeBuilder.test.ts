import * as assert from 'assert';
import { optimisticAppendCreatedNode } from '../../src/helpers/optimisticNodeBuilder';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataType, TreeNode } from '../../src/models/treeNode';

suite('optimisticNodeBuilder', () => {
  test('appends optimistic child and refreshes provider once', async () => {
    const target: TreeNode = {
      id: 'Catalogs',
      name: 'Catalogs',
      type: MetadataType.Catalog,
      properties: {},
      children: [],
    };

    let refreshCalls = 0;
    let invalidationCalls = 0;
    const state = {
      treeDataProvider: {
        resolveNodeForUi: () => target,
        invalidatePendingTypeLoad: () => {
          invalidationCalls += 1;
        },
        refresh: () => {
          refreshCalls += 1;
        },
      },
    } as any;

    await optimisticAppendCreatedNode(state, target, 'Products', {
      configPath: 'C:/cfg',
      format: ConfigFormat.Designer,
    });

    assert.strictEqual(target.children?.length, 1);
    assert.strictEqual(target.children?.[0].name, 'Products');
    assert.strictEqual(invalidationCalls, 1);
    assert.strictEqual(refreshCalls, 1);
  });

  test('does not append duplicate name', async () => {
    const target: TreeNode = {
      id: 'Catalogs',
      name: 'Catalogs',
      type: MetadataType.Catalog,
      properties: {},
      children: [
        {
          id: 'Catalogs.Products',
          name: 'Products',
          type: MetadataType.Catalog,
          properties: {},
        },
      ],
    };

    let refreshCalls = 0;
    const state = {
      treeDataProvider: {
        resolveNodeForUi: () => target,
        invalidatePendingTypeLoad: () => {
          throw new Error('duplicate append must not retire a type load');
        },
        refresh: () => {
          refreshCalls += 1;
        },
      },
    } as any;

    await optimisticAppendCreatedNode(state, target, 'Products', {
      configPath: 'C:/cfg',
      format: ConfigFormat.Designer,
    });

    assert.strictEqual(target.children?.length, 1);
    assert.strictEqual(refreshCalls, 0);
  });
});
