import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import {
  clearTypeContentsCache,
  computeTypeContentsSignature,
  invalidateTypeContentsCache,
  loadTypeContentsFromCache,
  saveTypeContentsToCache,
} from '../../src/utils/typeContentsCache';

suite('typeContentsCache', () => {
  async function makeTempDir(prefix: string): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  test('computeTypeContentsSignature returns null for missing type folder', async () => {
    const missing = path.join(os.tmpdir(), `1cviewer-missing-${Date.now()}`);
    assert.strictEqual(await computeTypeContentsSignature(missing, ConfigFormat.Designer), null);
  });

  test('save and load round-trips children and restores nested parent links', async () => {
    const configPath = await makeTempDir('1cviewer-type-cache-cfg-');
    const storagePath = await makeTempDir('1cviewer-type-cache-store-');
    const typePath = path.join(configPath, 'Catalogs');
    await fs.promises.mkdir(typePath, { recursive: true });
    await fs.promises.writeFile(path.join(typePath, 'Goods.xml'), '<MetaDataObject/>', 'utf-8');

    const signature = await computeTypeContentsSignature(typePath, ConfigFormat.Designer);
    assert.ok(signature);

    const child: TreeNode = {
      id: 'Catalogs.Goods',
      name: 'Goods',
      type: MetadataType.Catalog,
      properties: { _lazy: true },
      children: [
        {
          id: 'Catalogs.Goods.Ext',
          name: 'Ext',
          type: MetadataType.Extension,
          properties: {},
        },
      ],
    };
    child.children![0].parent = child;

    await saveTypeContentsToCache(storagePath, configPath, 'Catalogs', signature, [child]);
    const loaded = await loadTypeContentsFromCache(storagePath, configPath, 'Catalogs', signature);

    assert.ok(loaded);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'Catalogs.Goods');
    assert.strictEqual(loaded[0].parent, undefined);
    assert.strictEqual(loaded[0].children?.[0].parent, loaded[0]);

    await fs.promises.rm(configPath, { recursive: true, force: true });
    await fs.promises.rm(storagePath, { recursive: true, force: true });
  });

  test('load returns null for stale signature and invalidate removes config entries', async () => {
    const configPath = await makeTempDir('1cviewer-type-cache-cfg-');
    const storagePath = await makeTempDir('1cviewer-type-cache-store-');
    const typePath = path.join(configPath, 'Documents');
    await fs.promises.mkdir(typePath, { recursive: true });
    await fs.promises.writeFile(path.join(typePath, 'Order.xml'), '<MetaDataObject/>', 'utf-8');

    const signature = await computeTypeContentsSignature(typePath, ConfigFormat.Designer);
    assert.ok(signature);
    await saveTypeContentsToCache(storagePath, configPath, 'Documents', signature, [
      { id: 'Documents.Order', name: 'Order', type: MetadataType.Document, properties: {} },
    ]);

    assert.strictEqual(await loadTypeContentsFromCache(storagePath, configPath, 'Documents', 'stale'), null);
    await invalidateTypeContentsCache(storagePath, configPath);
    assert.strictEqual(await loadTypeContentsFromCache(storagePath, configPath, 'Documents', signature), null);

    await fs.promises.rm(configPath, { recursive: true, force: true });
    await fs.promises.rm(storagePath, { recursive: true, force: true });
  });

  test('clearTypeContentsCache removes all cache entries', async () => {
    const configPath = await makeTempDir('1cviewer-type-cache-cfg-');
    const storagePath = await makeTempDir('1cviewer-type-cache-store-');
    const typePath = path.join(configPath, 'Enums');
    await fs.promises.mkdir(typePath, { recursive: true });
    await fs.promises.writeFile(path.join(typePath, 'Status.xml'), '<MetaDataObject/>', 'utf-8');

    const signature = await computeTypeContentsSignature(typePath, ConfigFormat.Designer);
    assert.ok(signature);
    await saveTypeContentsToCache(storagePath, configPath, 'Enums', signature, [
      { id: 'Enums.Status', name: 'Status', type: MetadataType.Enum, properties: {} },
    ]);
    assert.ok(await loadTypeContentsFromCache(storagePath, configPath, 'Enums', signature));

    await clearTypeContentsCache(storagePath);
    assert.strictEqual(await loadTypeContentsFromCache(storagePath, configPath, 'Enums', signature), null);

    await fs.promises.rm(configPath, { recursive: true, force: true });
    await fs.promises.rm(storagePath, { recursive: true, force: true });
  });
});
