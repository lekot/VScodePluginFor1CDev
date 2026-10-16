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
import * as crypto from 'crypto';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { DesignerParser } from '../../src/parsers/designerParser';
import { EdtParser } from '../../src/parsers/edtParser';

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

  test('invalidates cache when Configuration.xml has same size and same mtime but different content (#245)', async () => {
    const contentA = '<Configuration>v1_alpha</Configuration>';
    const contentB = '<Configuration>v1_bravo</Configuration>';
    assert.strictEqual(contentA.length, contentB.length, 'Precondition: test contents must have identical byte length');

    await fs.promises.writeFile(configXmlPath, contentA, 'utf8');
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);
    const statBefore = await fs.promises.stat(configXmlPath);

    // Overwrite with contentB (identical length), restore exact same timestamp
    await fs.promises.writeFile(configXmlPath, contentB, 'utf8');
    await fs.promises.utimes(configXmlPath, statBefore.atime, statBefore.mtime);

    const statAfter = await fs.promises.stat(configXmlPath);
    assert.strictEqual(statAfter.size, statBefore.size, 'Precondition: sizes must match');

    // Ensure cache entry timestamp matches file timestamp precisely so mtime check passes
    const cacheDir = path.join(globalStoragePath, '1cviewer-tree-cache');
    const files = await fs.promises.readdir(cacheDir);
    const cacheFile = path.join(cacheDir, files[0]);
    const raw = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
    raw.timestamp = statAfter.mtimeMs;
    await fs.promises.writeFile(cacheFile, JSON.stringify(raw), 'utf8');

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache must be invalidated when content hash differs, even with same size and mtime');
  });

  test('rejects legacy cache entry when contentHash is missing (fail-closed) (#245)', async () => {
    await saveTreeToCache(globalStoragePath, configPath, sampleRoot);

    const cacheDir = path.join(globalStoragePath, '1cviewer-tree-cache');
    const files = await fs.promises.readdir(cacheDir);
    const cacheFile = path.join(cacheDir, files[0]);
    const raw = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
    delete raw.contentHash;
    await fs.promises.writeFile(cacheFile, JSON.stringify(raw), 'utf8');

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Legacy cache without contentHash must be rejected');
  });

  test('does not write stale cache if Configuration.xml was modified between parse and save (#245)', async () => {
    const contentA = '<Configuration>v1_alpha</Configuration>';
    const contentB = '<Configuration>v1_bravo</Configuration>';
    assert.strictEqual(contentA.length, contentB.length, 'Precondition: identical length');

    await fs.promises.writeFile(configXmlPath, contentA, 'utf8');
    const treeA = await MetadataParser.parseStructureOnly(configPath);
    const statBefore = await fs.promises.stat(configXmlPath);

    // File mutates on disk between parse and save (same size, same timestamp)
    await fs.promises.writeFile(configXmlPath, contentB, 'utf8');
    await fs.promises.utimes(configXmlPath, statBefore.atime, statBefore.mtime);

    // Save treeA after mutation occurred
    await saveTreeToCache(globalStoragePath, configPath, treeA);

    // Loading from cache must NOT return treeA for file content B!
    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache must not be saved when Configuration.xml mutated between parse and save');
  });

  test('skips cache write when explicit expectedContentHash does not match file on disk', async () => {
    await fs.promises.writeFile(configXmlPath, '<Configuration>v1</Configuration>', 'utf8');
    const tree = await MetadataParser.parseStructureOnly(configPath);

    await saveTreeToCache(globalStoragePath, configPath, tree, '0000000000000000000000000000000000000000000000000000000000000000');

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.strictEqual(loaded, null, 'Cache must not be saved when expectedContentHash does not match');
  });

  test('writes cache when explicit expectedContentHash matches file on disk', async () => {
    await fs.promises.writeFile(configXmlPath, '<Configuration>v1</Configuration>', 'utf8');
    const tree = await MetadataParser.parseStructureOnly(configPath);
    const expectedHash = tree.properties?.contentHash as string;
    assert.ok(expectedHash, 'Parsed tree must have contentHash');

    await saveTreeToCache(globalStoragePath, configPath, tree, expectedHash);

    const loaded = await loadTreeFromCache(globalStoragePath, configPath);
    assert.ok(loaded, 'Cache must be saved when expectedContentHash matches');
  });

  test('DesignerParser.parseStructureOnly performs a single file read ensuring contentHash matches parsed XML properties', async () => {
    const configXml = path.join(configPath, 'Configuration.xml');
    const contentA = '<MetaDataObject><Configuration><Properties><NamePrefix>PrefixA_</NamePrefix></Properties></Configuration></MetaDataObject>';
    const contentB = '<MetaDataObject><Configuration><Properties><NamePrefix>PrefixB_</NamePrefix></Properties></Configuration></MetaDataObject>';
    await fs.promises.writeFile(configXml, contentA, 'utf8');

    let readCount = 0;
    const origReadFile = fs.promises.readFile;
    (fs.promises as any).readFile = async (p: fs.PathLike, opts: any) => {
      const res = await origReadFile(p, opts);
      if (p.toString().endsWith('Configuration.xml')) {
        readCount++;
        if (readCount === 1) {
          // Mutate file immediately after the first read
          await fs.promises.writeFile(configXml, contentB, 'utf8');
        }
      }
      return res;
    };

    try {
      const tree = await DesignerParser.parseStructureOnly(configPath);
      assert.strictEqual(readCount, 1, 'Configuration.xml must be read exactly once to prevent split-brain digest');
      const expectedHash = crypto.createHash('sha256').update(Buffer.from(contentA, 'utf8')).digest('hex');
      assert.strictEqual(tree.properties?.contentHash, expectedHash);
      assert.strictEqual(tree.properties?.namePrefix, 'PrefixA_', 'Parsed properties must match the bytes hashed');
    } finally {
      fs.promises.readFile = origReadFile;
    }
  });

  test('EdtParser.parseStructureOnly performs a single file read ensuring contentHash matches parsed XML properties', async () => {
    const srcDir = path.join(configPath, 'src', 'Configuration');
    await fs.promises.mkdir(srcDir, { recursive: true });
    const configMdoPath = path.join(srcDir, 'Configuration.mdo');
    const contentA = '<mdclass:Configuration><namePrefix>PrefixEdtA_</namePrefix></mdclass:Configuration>';
    const contentB = '<mdclass:Configuration><namePrefix>PrefixEdtB_</namePrefix></mdclass:Configuration>';
    await fs.promises.writeFile(configMdoPath, contentA, 'utf8');

    let readCount = 0;
    const origReadFile = fs.promises.readFile;
    (fs.promises as any).readFile = async (p: fs.PathLike, opts: any) => {
      const res = await origReadFile(p, opts);
      if (p.toString().endsWith('Configuration.mdo')) {
        readCount++;
        if (readCount === 1) {
          // Mutate file immediately after the first read
          await fs.promises.writeFile(configMdoPath, contentB, 'utf8');
        }
      }
      return res;
    };

    try {
      const tree = await EdtParser.parseStructureOnly(configPath);
      assert.strictEqual(readCount, 1, 'Configuration.mdo must be read exactly once to prevent split-brain digest');
      const expectedHash = crypto.createHash('sha256').update(Buffer.from(contentA, 'utf8')).digest('hex');
      assert.strictEqual(tree.properties?.contentHash, expectedHash);
      assert.strictEqual(tree.properties?.namePrefix, 'PrefixEdtA_', 'Parsed properties must match the bytes hashed');
    } finally {
      fs.promises.readFile = origReadFile;
    }
  });
});
