import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import {
  clearTypeContentsCache,
  computeTypeContentsSignature,
  getConfigCachePrefix,
  getCacheFilePath,
  invalidateTypeContentsCache,
  loadTypeContentsFromCache,
  normalizePathForSignature,
  saveTypeContentsToCache,
} from '../../src/utils/typeContentsCache';
import { MetadataParser } from '../../src/parsers/metadataParser';

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

  test('loadTypeContentsFromCache matches case-insensitively and slash-independently for configPath', async () => {
    const configPath = await makeTempDir('1cviewer-type-cache-cfg-');
    const storagePath = await makeTempDir('1cviewer-type-cache-store-');
    const typePath = path.join(configPath, 'Catalogs');
    await fs.promises.mkdir(typePath, { recursive: true });
    await fs.promises.writeFile(path.join(typePath, 'Item.xml'), '<MetaDataObject/>', 'utf-8');

    const signature = await computeTypeContentsSignature(typePath, ConfigFormat.Designer);
    assert.ok(signature);

    const lowerConfigPath = configPath.toLowerCase().replace(/\\/g, '/');
    const upperConfigPath = configPath.toUpperCase().replace(/\//g, '\\');

    await saveTypeContentsToCache(storagePath, lowerConfigPath, 'Catalogs', signature, [
      { id: 'Catalogs.Item', name: 'Item', type: MetadataType.Catalog, properties: {} },
    ]);

    const loaded = await loadTypeContentsFromCache(storagePath, upperConfigPath, 'Catalogs', signature);
    assert.ok(loaded, 'Cache must hit even when configPath differs by drive letter case or slashes');
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'Catalogs.Item');

    await fs.promises.rm(configPath, { recursive: true, force: true });
    await fs.promises.rm(storagePath, { recursive: true, force: true });
  });

  test('index and contents cache kinds are isolated and do not collide', async () => {
    const configPath = await makeTempDir('1cviewer-type-cache-cfg-');
    const storagePath = await makeTempDir('1cviewer-type-cache-store-');
    const typePath = path.join(configPath, 'Catalogs');
    await fs.promises.mkdir(typePath, { recursive: true });
    await fs.promises.writeFile(path.join(typePath, 'Item.xml'), '<MetaDataObject/>', 'utf-8');

    const signature = await computeTypeContentsSignature(typePath, ConfigFormat.Designer);
    assert.ok(signature);

    const indexItems = [{ id: 'Catalogs.Item', name: 'Item', type: MetadataType.Catalog, properties: { _lazy: true } }];
    const contentItems = [
      {
        id: 'Catalogs.Item',
        name: 'Item',
        type: MetadataType.Catalog,
        properties: {},
        children: [{ id: 'Catalogs.Item.Attributes', name: 'Attributes', type: MetadataType.Attribute, properties: {} }],
      },
    ];

    await saveTypeContentsToCache(storagePath, configPath, 'Catalogs', signature, indexItems, 'index');
    await saveTypeContentsToCache(storagePath, configPath, 'Catalogs', signature, contentItems, 'contents');

    const loadedIndex = await loadTypeContentsFromCache(storagePath, configPath, 'Catalogs', signature, 'index');
    const loadedContents = await loadTypeContentsFromCache(storagePath, configPath, 'Catalogs', signature, 'contents');

    assert.ok(loadedIndex);
    assert.strictEqual(loadedIndex[0].properties._lazy, true);
    assert.strictEqual(loadedIndex[0].children, undefined);

    assert.ok(loadedContents);
    assert.strictEqual(loadedContents[0].children?.length, 1);

    await invalidateTypeContentsCache(storagePath, configPath);
    assert.strictEqual(await loadTypeContentsFromCache(storagePath, configPath, 'Catalogs', signature, 'index'), null);
    assert.strictEqual(await loadTypeContentsFromCache(storagePath, configPath, 'Catalogs', signature, 'contents'), null);

    await fs.promises.rm(configPath, { recursive: true, force: true });
    await fs.promises.rm(storagePath, { recursive: true, force: true });
  });

  test('POSIX platform preserves case for cache path and signature (#198, #207)', () => {
    const pathUpper = '/workspace/Config';
    const pathLower = '/workspace/config';

    const normUpper = normalizePathForSignature(pathUpper, 'linux');
    const normLower = normalizePathForSignature(pathLower, 'linux');
    assert.notStrictEqual(normUpper, normLower, 'POSIX normalized paths must differ in case');

    const prefixUpper = getConfigCachePrefix(pathUpper, 'linux');
    const prefixLower = getConfigCachePrefix(pathLower, 'linux');
    assert.notStrictEqual(prefixUpper, prefixLower, 'POSIX cache prefixes must differ');

    const fileUpper = getCacheFilePath('/storage', pathUpper, 'Catalogs', 'contents', 'linux');
    const fileLower = getCacheFilePath('/storage', pathLower, 'Catalogs', 'contents', 'linux');
    assert.notStrictEqual(fileUpper, fileLower, 'POSIX cache file paths must differ');
  });

  test('Windows platform folds case for cache path and signature (#198, #207)', () => {
    const pathUpper = 'C:\\workspace\\Config';
    const pathLower = 'c:\\workspace\\config';

    const normUpper = normalizePathForSignature(pathUpper, 'win32');
    const normLower = normalizePathForSignature(pathLower, 'win32');
    assert.strictEqual(normUpper, normLower, 'Windows normalized paths must fold casing');

    const prefixUpper = getConfigCachePrefix(pathUpper, 'win32');
    const prefixLower = getConfigCachePrefix(pathLower, 'win32');
    assert.strictEqual(prefixUpper, prefixLower, 'Windows cache prefixes must match');

    const fileUpper = getCacheFilePath('C:\\storage', pathUpper, 'Catalogs', 'contents', 'win32');
    const fileLower = getCacheFilePath('C:\\storage', pathLower, 'Catalogs', 'contents', 'win32');
    assert.strictEqual(fileUpper, fileLower, 'Windows cache file paths must match');
  });

  test('POSIX disk cache separation prevents cross-root pollution (#198, #207)', async () => {
    const storagePath = await makeTempDir('1cviewer-posix-store-');
    const configUpper = '/workspace/Config';
    const configLower = '/workspace/config';
    const signatureUpper = 'sig-upper-123';
    const signatureLower = 'sig-lower-456';

    const upperNodes: TreeNode[] = [
      { id: 'Catalogs.GoodsUpper', name: 'GoodsUpper', type: MetadataType.Catalog, properties: {} },
    ];
    const lowerNodes: TreeNode[] = [
      { id: 'Catalogs.GoodsLower', name: 'GoodsLower', type: MetadataType.Catalog, properties: {} },
    ];

    await saveTypeContentsToCache(storagePath, configUpper, 'Catalogs', signatureUpper, upperNodes, 'contents', 'linux');
    await saveTypeContentsToCache(storagePath, configLower, 'Catalogs', signatureLower, lowerNodes, 'contents', 'linux');

    // Verify upper load
    const loadedUpper = await loadTypeContentsFromCache(storagePath, configUpper, 'Catalogs', signatureUpper, 'contents', 'linux');
    assert.ok(loadedUpper);
    assert.strictEqual(loadedUpper[0].name, 'GoodsUpper');

    // Verify lower load
    const loadedLower = await loadTypeContentsFromCache(storagePath, configLower, 'Catalogs', signatureLower, 'contents', 'linux');
    assert.ok(loadedLower);
    assert.strictEqual(loadedLower[0].name, 'GoodsLower');

    // Cross load with mismatching root path fails
    const crossLoad = await loadTypeContentsFromCache(storagePath, configLower, 'Catalogs', signatureUpper, 'contents', 'linux');
    assert.strictEqual(crossLoad, null, 'Loading upper cache from lower path must fail on POSIX');

    await fs.promises.rm(storagePath, { recursive: true, force: true });
  });

  test('MetadataParser disk cache roundtrip with actual parsing', async () => {
    const configDir = await makeTempDir('1cviewer-cfg-');
    const storageDir = await makeTempDir('1cviewer-meta-store-');
    const catalogsDir = path.join(configDir, 'Catalogs');
    await fs.promises.mkdir(catalogsDir, { recursive: true });

    // Minimal Designer Configuration.xml
    await fs.promises.writeFile(
      path.join(configDir, 'Configuration.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration name="TestConfig"/></MetaDataObject>',
      'utf-8'
    );
    // Minimal Catalog XML
    await fs.promises.writeFile(
      path.join(catalogsDir, 'CatalogItem.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog name="CatalogItem"><Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Товар</v8:content></v8:item></Synonym></Catalog></MetaDataObject>',
      'utf-8'
    );

    MetadataParser.setTypeContentsCacheStoragePath(storageDir);

    try {
      // First parse: uncached, populates disk cache
      const parsed1 = await MetadataParser.parseTypeContents(configDir, 'Catalogs', { format: ConfigFormat.Designer });
      assert.strictEqual(parsed1.length, 1);
      assert.strictEqual(parsed1[0].name, 'CatalogItem');

      // Second parse: loads from disk cache
      const parsed2 = await MetadataParser.parseTypeContents(configDir, 'Catalogs', { format: ConfigFormat.Designer });
      assert.strictEqual(parsed2.length, 1);
      assert.strictEqual(parsed2[0].name, 'CatalogItem');
    } finally {
      MetadataParser.setTypeContentsCacheStoragePath(null);
      await fs.promises.rm(configDir, { recursive: true, force: true });
      await fs.promises.rm(storageDir, { recursive: true, force: true });
    }
  });
});
