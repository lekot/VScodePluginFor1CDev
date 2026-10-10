import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  loadTreeFromCache,
  saveTreeToCache,
  invalidateTreeCache,
} from '../../src/utils/diskCache';

suite('diskCache (#194)', () => {
  let tmpDir: string;
  let globalStoragePath: string;
  let configPath: string;
  let configXmlPath: string;
  let sampleRoot: TreeNode;

  setup(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cv-diskcache-test-'));
    globalStoragePath = path.join(tmpDir, 'storage');
    configPath = path.join(tmpDir, 'config');
    await fs.promises.mkdir(configPath, { recursive: true });
    configXmlPath = path.join(configPath, 'Configuration.xml');
    await fs.promises.writeFile(configXmlPath, '<Configuration>v1</Configuration>', 'utf8');

    sampleRoot = {
      id: 'cfg_1',
      name: 'TestConfiguration',
      type: MetadataType.Configuration,
      filePath: configXmlPath,
      properties: { bslLanguage: 'ru' },
      children: [],
    };
  });

  teardown(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('loads valid tree from cache when Configuration.xml is unmodified', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.ok(loaded);
    assert.strictEqual(loaded.name, 'TestConfiguration');
    assert.strictEqual(loaded.type, MetadataType.Configuration);
    assert.strictEqual(loaded.properties?.bslLanguage, 'ru');
  });

  test('invalidates cache when Configuration.xml has newer mtime', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    // Advance mtime by 10 seconds
    const futureTime = new Date(Date.now() + 10000);
    await fs.promises.utimes(configXmlPath, futureTime, futureTime);

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache must be invalidated when Configuration.xml is newer');
  });

  test('invalidates cache when Configuration.xml has older mtime (#194)', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    // Rewind mtime by 100 seconds (e.g. backup or archive restored)
    const pastTime = new Date(Date.now() - 100000);
    await fs.promises.utimes(configXmlPath, pastTime, pastTime);

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache must be invalidated when Configuration.xml has older timestamp than cache');
  });

  test('invalidates cache when Configuration.xml size changes even if mtime is unchanged (#194)', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    const statBefore = await fs.promises.stat(configXmlPath);

    // Overwrite with different content length, keeping exact same mtime
    await fs.promises.writeFile(configXmlPath, '<Configuration>much longer content replacing old version</Configuration>', 'utf8');
    await fs.promises.utimes(configXmlPath, statBefore.atime, statBefore.mtime);

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache must be invalidated when Configuration.xml size differs');
  });

  test('rejects cache entry when timestamp is missing (#194)', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    // Find the cache file and remove timestamp
    const cacheDir = path.join(globalStoragePath, '1cviewer-tree-cache');
    const files = await fs.promises.readdir(cacheDir);
    const cacheFile = path.join(cacheDir, files[0]);
    const raw = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
    delete raw.timestamp;
    await fs.promises.writeFile(cacheFile, JSON.stringify(raw), 'utf8');

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache without timestamp must not be accepted as fresh');
  });

  test('returns null when Configuration.xml does not exist', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    await fs.promises.unlink(configXmlPath);

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null);
  });

  test('invalidateTreeCache deletes the cache file', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    const loadedBefore = await loadTreeFromCache(globalStoragePath, configPath);
    assert.ok(loadedBefore);

    await invalidateTreeCache(globalStoragePath, configPath);
    const loadedAfter = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loadedAfter, null);
  });
});
