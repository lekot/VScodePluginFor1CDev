import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { DesignerParser } from '../../src/parsers/designerParser';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';
import { MetadataParser } from '../../src/parsers/metadataParser';
import * as typeContentsCache from '../../src/utils/typeContentsCache';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function node(id: string): TreeNode {
  return { id, name: id, type: MetadataType.Catalog, properties: {} };
}

const cacheApi = typeContentsCache as unknown as {
  computeTypeContentsSignature: typeof typeContentsCache.computeTypeContentsSignature;
  getCacheFilePath: typeof typeContentsCache.getCacheFilePath;
  invalidateTypeContentsCache: typeof typeContentsCache.invalidateTypeContentsCache;
  clearTypeContentsCache: typeof typeContentsCache.clearTypeContentsCache;
  loadTypeContentsFromCache: typeof typeContentsCache.loadTypeContentsFromCache;
  saveTypeContentsToCache: typeof typeContentsCache.saveTypeContentsToCache;
};

async function makeFixture(label: string): Promise<{ configPath: string; storagePath: string }> {
  const configPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), `1cviewer-epoch-${label}-cfg-`));
  const storagePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), `1cviewer-epoch-${label}-store-`));
  await fs.promises.mkdir(path.join(configPath, 'Catalogs'), { recursive: true });
  await fs.promises.writeFile(path.join(configPath, 'Catalogs', 'Seed.xml'), '<MetaDataObject/>', 'utf-8');
  return { configPath, storagePath };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

suite('MetadataParser cache epochs (#252)', () => {
  test('does not write late contents or index parses after config invalidation', async () => {
    const originalContents = DesignerParser.parseTypeContents;
    const originalIndex = DesignerParser.parseTypeIndex;

    for (const kind of ['contents', 'index'] as const) {
      const fixture = await makeFixture(kind);
      const started = deferred<void>();
      const releaseParse = deferred<TreeNode[]>();
      let parseCount = 0;
      let staleRequest: Promise<TreeNode[]> | undefined;
      let freshRequest: Promise<TreeNode[]> | undefined;

      try {
        MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
        const parserImplementation = async () => {
          parseCount += 1;
          if (parseCount === 1) {
            started.resolve();
            return await releaseParse.promise;
          }
          return [node('Catalogs.Fresh')];
        };
        if (kind === 'contents') {
          (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = parserImplementation;
        } else {
          (DesignerParser.parseTypeIndex as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = parserImplementation;
        }

        const parse = (configPath: string) => kind === 'contents'
          ? MetadataParser.parseTypeContents(configPath, 'Catalogs', { format: ConfigFormat.Designer })
          : MetadataParser.parseTypeIndex(configPath, 'Catalogs', { format: ConfigFormat.Designer });
        staleRequest = parse(fixture.configPath);
        await started.promise;

        await MetadataParser.invalidateTypeContentsCache(fixture.configPath);
        freshRequest = parse(fixture.configPath);
        releaseParse.resolve([node('Catalogs.Stale')]);
        const [staleResult, freshResult] = await Promise.all([staleRequest, freshRequest]);

        assert.strictEqual(staleResult[0].id, 'Catalogs.Stale', 'the original caller must receive its parse result');
        assert.strictEqual(freshResult[0].id, 'Catalogs.Fresh');
        const cacheFile = cacheApi.getCacheFilePath(fixture.storagePath, fixture.configPath, 'Catalogs', kind);
        assert.strictEqual(await fileExists(cacheFile), true, `${kind} fresh parse should still populate disk cache`);
        const signature = await cacheApi.computeTypeContentsSignature(path.join(fixture.configPath, 'Catalogs'), ConfigFormat.Designer);
        assert.ok(signature);
        const cached = await cacheApi.loadTypeContentsFromCache(fixture.storagePath, fixture.configPath, 'Catalogs', signature, kind);
        assert.strictEqual(cached?.[0].id, 'Catalogs.Fresh', `${kind} late old work must not replace the fresh cache entry`);
      } finally {
        releaseParse.resolve([node('Catalogs.Cleanup')]);
        await Promise.allSettled([staleRequest, freshRequest].filter((request): request is Promise<TreeNode[]> => request !== undefined));
        MetadataParser.setTypeContentsCacheStoragePath(null);
        if (kind === 'contents') {
          (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
        } else {
          (DesignerParser.parseTypeIndex as unknown as typeof DesignerParser.parseTypeIndex) = originalIndex;
        }
        await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
        await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
      }
    }
  });

  test('a new storage generation parses while the previous generation is still pending', async () => {
    const fixture = await makeFixture('pending-generation');
    const originalContents = DesignerParser.parseTypeContents;
    const originalSignature = cacheApi.computeTypeContentsSignature;
    const originalLoad = cacheApi.loadTypeContentsFromCache;
    const originalSave = cacheApi.saveTypeContentsToCache;
    const oldParseStarted = deferred<void>();
    const releaseOldParse = deferred<TreeNode[]>();
    let parseCount = 0;
    let oldRequest: Promise<TreeNode[]> | undefined;
    let newRequest: Promise<TreeNode[]> | undefined;
    let newCompleted = false;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      cacheApi.computeTypeContentsSignature = async () => 'epoch-test-signature';
      cacheApi.loadTypeContentsFromCache = async () => null;
      cacheApi.saveTypeContentsToCache = async () => {};
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => {
        parseCount += 1;
        if (parseCount === 1) {
          oldParseStarted.resolve();
          return await releaseOldParse.promise;
        }
        return [node('Catalogs.NewGeneration')];
      };

      oldRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await oldParseStarted.promise;
      await MetadataParser.invalidateTypeContentsCache(fixture.configPath);

      newRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer }).then((result) => {
        newCompleted = true;
        return result;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(newCompleted, true, 'the new generation must finish without waiting for the older parse');
      assert.strictEqual(parseCount, 2, 'the new generation must start its own parse while the previous one is pending');

      releaseOldParse.resolve([node('Catalogs.OldGeneration')]);
      const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
      assert.strictEqual(oldResult[0].id, 'Catalogs.OldGeneration');
      assert.strictEqual(newResult[0].id, 'Catalogs.NewGeneration');
    } finally {
      releaseOldParse.resolve([node('Catalogs.Cleanup')]);
      await Promise.allSettled([oldRequest, newRequest].filter((request): request is Promise<TreeNode[]> => request !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      cacheApi.computeTypeContentsSignature = originalSignature;
      cacheApi.loadTypeContentsFromCache = originalLoad;
      cacheApi.saveTypeContentsToCache = originalSave;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });

  test('captures the generation before delayed format detection', async () => {
    const fixture = await makeFixture('delayed-format');
    const originalDetect = FormatDetector.detect;
    const originalContents = DesignerParser.parseTypeContents;
    const detectStarted = deferred<void>();
    const releaseDetect = deferred<ConfigFormat>();
    let request: Promise<TreeNode[]> | undefined;
    let freshRequest: Promise<TreeNode[]> | undefined;
    let parseCount = 0;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      (FormatDetector.detect as unknown as (configPath: string) => Promise<ConfigFormat>) = async () => {
        detectStarted.resolve();
        return await releaseDetect.promise;
      };
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => [
        node(`Catalogs.Parse${++parseCount}`),
      ];

      request = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs');
      await detectStarted.promise;
      await MetadataParser.invalidateTypeContentsCache(fixture.configPath);
      freshRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      const freshResult = await freshRequest;
      assert.strictEqual(freshResult[0].id, 'Catalogs.Parse1');

      releaseDetect.resolve(ConfigFormat.Designer);
      const result = await request;

      assert.strictEqual(result[0].id, 'Catalogs.Parse2', 'delayed old request must parse under its captured generation');
      const cacheFile = cacheApi.getCacheFilePath(fixture.storagePath, fixture.configPath, 'Catalogs');
      assert.strictEqual(await fileExists(cacheFile), true, 'fresh generation should retain its disk entry');
      const signature = await cacheApi.computeTypeContentsSignature(path.join(fixture.configPath, 'Catalogs'), ConfigFormat.Designer);
      assert.ok(signature);
      const cached = await cacheApi.loadTypeContentsFromCache(fixture.storagePath, fixture.configPath, 'Catalogs', signature);
      assert.strictEqual(cached?.[0].id, 'Catalogs.Parse1', 'delayed old request must not replace the fresh cache entry');
    } finally {
      releaseDetect.resolve(ConfigFormat.Designer);
      await Promise.allSettled([request, freshRequest].filter((pending): pending is Promise<TreeNode[]> => pending !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });

  test('invalidating without storage still separates in-flight generations', async () => {
    const fixture = await makeFixture('null-storage');
    const originalContents = DesignerParser.parseTypeContents;
    const oldParseStarted = deferred<void>();
    const releaseOldParse = deferred<TreeNode[]>();
    let parseCount = 0;
    let oldRequest: Promise<TreeNode[]> | undefined;
    let newRequest: Promise<TreeNode[]> | undefined;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => {
        parseCount += 1;
        if (parseCount === 1) {
          oldParseStarted.resolve();
          return await releaseOldParse.promise;
        }
        return [node('Catalogs.NewGeneration')];
      };

      oldRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await oldParseStarted.promise;
      await MetadataParser.invalidateTypeContentsCache(fixture.configPath);

      newRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });

      releaseOldParse.resolve([node('Catalogs.OldGeneration')]);
      const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
      assert.strictEqual(oldResult[0].id, 'Catalogs.OldGeneration');
      assert.strictEqual(newResult[0].id, 'Catalogs.NewGeneration', 'a request after null-storage invalidation must not join old work');
      assert.strictEqual(parseCount, 2);
    } finally {
      releaseOldParse.resolve([node('Catalogs.Cleanup')]);
      await Promise.allSettled([oldRequest, newRequest].filter((request): request is Promise<TreeNode[]> => request !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });

  test('invalidation fences only its root', async () => {
    const first = await makeFixture('root-one');
    const second = await makeFixture('root-two');
    const originalContents = DesignerParser.parseTypeContents;
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<TreeNode[]>();
    const releaseSecond = deferred<TreeNode[]>();
    let firstRequest: Promise<TreeNode[]> | undefined;
    let secondRequest: Promise<TreeNode[]> | undefined;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(first.storagePath);
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async (configPath) => {
        if (configPath === first.configPath) {
          firstStarted.resolve();
          return await releaseFirst.promise;
        }
        secondStarted.resolve();
        return await releaseSecond.promise;
      };

      firstRequest = MetadataParser.parseTypeContents(first.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      secondRequest = MetadataParser.parseTypeContents(second.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await Promise.all([firstStarted.promise, secondStarted.promise]);
      await MetadataParser.invalidateTypeContentsCache(first.configPath);
      releaseFirst.resolve([node('Catalogs.FirstStale')]);
      releaseSecond.resolve([node('Catalogs.SecondStillCurrent')]);
      await Promise.all([firstRequest, secondRequest]);

      const firstCache = cacheApi.getCacheFilePath(first.storagePath, first.configPath, 'Catalogs');
      const secondCache = cacheApi.getCacheFilePath(first.storagePath, second.configPath, 'Catalogs');
      assert.strictEqual(await fileExists(firstCache), false, 'invalidated root must not publish its late cache write');
      assert.strictEqual(await fileExists(secondCache), true, 'unrelated root must retain its current generation');
    } finally {
      releaseFirst.resolve([node('Catalogs.CleanupFirst')]);
      releaseSecond.resolve([node('Catalogs.CleanupSecond')]);
      await Promise.allSettled([firstRequest, secondRequest].filter((request): request is Promise<TreeNode[]> => request !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(first.configPath, { recursive: true, force: true });
      await fs.promises.rm(first.storagePath, { recursive: true, force: true });
      await fs.promises.rm(second.configPath, { recursive: true, force: true });
      await fs.promises.rm(second.storagePath, { recursive: true, force: true });
    }
  });

  test('new loads wait behind an in-progress disk invalidation', async () => {
    const fixture = await makeFixture('disk-barrier');
    const originalInvalidate = cacheApi.invalidateTypeContentsCache;
    const originalLoad = cacheApi.loadTypeContentsFromCache;
    const originalSignature = cacheApi.computeTypeContentsSignature;
    const originalContents = DesignerParser.parseTypeContents;
    const invalidationStarted = deferred<void>();
    const releaseInvalidation = deferred<void>();
    const signatureStarted = deferred<void>();
    const releaseSignature = deferred<string | null>();
    const events: string[] = [];
    let loadCount = 0;
    let request: Promise<TreeNode[]> | undefined;
    let invalidation: Promise<void> | undefined;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      const signature = await originalSignature(path.join(fixture.configPath, 'Catalogs'), ConfigFormat.Designer);
      assert.ok(signature);
      await cacheApi.saveTypeContentsToCache(fixture.storagePath, fixture.configPath, 'Catalogs', signature, [node('Catalogs.OldDiskEntry')]);

      cacheApi.invalidateTypeContentsCache = async (...args) => {
        events.push('invalidate:start');
        invalidationStarted.resolve();
        await releaseInvalidation.promise;
        await originalInvalidate(...args);
        events.push('invalidate:end');
      };
      cacheApi.loadTypeContentsFromCache = async (...args) => {
        events.push('load');
        loadCount += 1;
        return await originalLoad(...args);
      };
      cacheApi.computeTypeContentsSignature = async () => {
        signatureStarted.resolve();
        return await releaseSignature.promise;
      };
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => [
        node('Catalogs.AfterInvalidation'),
      ];

      invalidation = MetadataParser.invalidateTypeContentsCache(fixture.configPath);
      await invalidationStarted.promise;
      request = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await signatureStarted.promise;
      releaseSignature.resolve(signature);
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(loadCount, 0, 'disk load must remain queued while deletion is blocked');
      assert.deepStrictEqual(events, ['invalidate:start']);

      releaseInvalidation.resolve();
      const [result] = await Promise.all([request, invalidation]);
      assert.strictEqual(result[0].id, 'Catalogs.AfterInvalidation');
      assert.ok(events.indexOf('invalidate:end') >= 0);
      assert.ok(events.indexOf('load') > events.indexOf('invalidate:end'), 'load must run only after invalidation removes the old file');
      assert.strictEqual(loadCount, 1);
    } finally {
      releaseInvalidation.resolve();
      releaseSignature.resolve(null);
      await Promise.allSettled([...(request ? [request] : []), ...(invalidation ? [invalidation] : [])]);
      MetadataParser.setTypeContentsCacheStoragePath(null);
      cacheApi.invalidateTypeContentsCache = originalInvalidate;
      cacheApi.loadTypeContentsFromCache = originalLoad;
      cacheApi.computeTypeContentsSignature = originalSignature;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });

  test('clear fences late writes without changing storage', async () => {
    const fixture = await makeFixture('clear-epoch');
    const originalContents = DesignerParser.parseTypeContents;
    const started = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    let request: Promise<TreeNode[]> | undefined;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => {
        started.resolve();
        return await releaseParse.promise;
      };

      request = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await started.promise;
      await MetadataParser.clearTypeContentsCache();
      releaseParse.resolve([node('Catalogs.BeforeClear')]);
      assert.strictEqual((await request)[0].id, 'Catalogs.BeforeClear');

      assert.strictEqual(await fileExists(cacheApi.getCacheFilePath(fixture.storagePath, fixture.configPath, 'Catalogs')), false);
    } finally {
      releaseParse.resolve([node('Catalogs.Cleanup')]);
      await Promise.allSettled([request].filter((pending): pending is Promise<TreeNode[]> => pending !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });

  test('storage changes fence late writes without clearing storage', async () => {
    const fixture = await makeFixture('storage-switch');
    const nextStorage = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-epoch-next-store-'));
    const originalContents = DesignerParser.parseTypeContents;
    const started = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    let request: Promise<TreeNode[]> | undefined;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => {
        started.resolve();
        return await releaseParse.promise;
      };

      request = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await started.promise;
      MetadataParser.setTypeContentsCacheStoragePath(nextStorage);
      releaseParse.resolve([node('Catalogs.BeforeStorageSwitch')]);
      assert.strictEqual((await request)[0].id, 'Catalogs.BeforeStorageSwitch');

      assert.strictEqual(await fileExists(cacheApi.getCacheFilePath(fixture.storagePath, fixture.configPath, 'Catalogs')), false);
      assert.strictEqual(await fileExists(cacheApi.getCacheFilePath(nextStorage, fixture.configPath, 'Catalogs')), false);
    } finally {
      releaseParse.resolve([node('Catalogs.Cleanup')]);
      await Promise.allSettled([request].filter((pending): pending is Promise<TreeNode[]> => pending !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
      await fs.promises.rm(nextStorage, { recursive: true, force: true });
    }
  });

  test('an active save finishes before invalidation, then a fresh entry survives', async () => {
    const fixture = await makeFixture('save-barrier');
    const originalInvalidate = cacheApi.invalidateTypeContentsCache;
    const originalLoad = cacheApi.loadTypeContentsFromCache;
    const originalWriteFile = fs.promises.writeFile;
    const originalContents = DesignerParser.parseTypeContents;
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const events: string[] = [];
    const cacheFile = cacheApi.getCacheFilePath(fixture.storagePath, fixture.configPath, 'Catalogs');
    let oldRequest: Promise<TreeNode[]> | undefined;
    let newRequest: Promise<TreeNode[]> | undefined;
    let invalidation: Promise<void> | undefined;
    let parseCount = 0;
    let gatedWrite = false;
    const mutableFsPromises = fs.promises as unknown as { writeFile: (...args: unknown[]) => Promise<void> };
    const forwardWriteFile = originalWriteFile as unknown as (...args: unknown[]) => Promise<void>;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      cacheApi.invalidateTypeContentsCache = async (...args) => {
        await originalInvalidate(...args);
        events.push('invalidate:end');
      };
      cacheApi.loadTypeContentsFromCache = async (...args) => {
        events.push('load');
        return await originalLoad(...args);
      };
      mutableFsPromises.writeFile = async (...args) => {
        const isCacheWrite = path.resolve(String(args[0])) === path.resolve(cacheFile);
        if (isCacheWrite && !gatedWrite) {
          gatedWrite = true;
          events.push('write:start');
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        const result = await forwardWriteFile(...args);
        if (isCacheWrite) {
          events.push('write:end');
        }
        return result;
      };
      (DesignerParser.parseTypeContents as unknown as (configPath: string, typeName: string) => Promise<TreeNode[]>) = async () => {
        parseCount += 1;
        return [node(parseCount === 1 ? 'Catalogs.OldSave' : 'Catalogs.FreshSave')];
      };

      oldRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await writeStarted.promise;
      events.length = 0;

      invalidation = MetadataParser.invalidateTypeContentsCache(fixture.configPath);
      newRequest = MetadataParser.parseTypeContents(fixture.configPath, 'Catalogs', { format: ConfigFormat.Designer });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(events.length, 0, 'invalidation and the next load must wait behind an already-started save');

      releaseWrite.resolve();
      const [oldResult, newResult] = await Promise.all([oldRequest, newRequest, invalidation]).then(([oldValue, newValue]) => [oldValue, newValue]);
      assert.strictEqual(oldResult[0].id, 'Catalogs.OldSave');
      assert.strictEqual(newResult[0].id, 'Catalogs.FreshSave', 'new generation must parse after old entry is removed');
      assert.ok(events.indexOf('write:end') >= 0);
      assert.ok(events.indexOf('invalidate:end') > events.indexOf('write:end'));
      assert.ok(events.indexOf('load') > events.indexOf('invalidate:end'));
      assert.strictEqual(parseCount, 2);

      const signature = await cacheApi.computeTypeContentsSignature(path.join(fixture.configPath, 'Catalogs'), ConfigFormat.Designer);
      assert.ok(signature);
      const cached = await originalLoad(fixture.storagePath, fixture.configPath, 'Catalogs', signature);
      assert.strictEqual(cached?.[0].id, 'Catalogs.FreshSave', 'the fresh cache file must survive the old write and unlink');
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled([...(oldRequest ? [oldRequest] : []), ...(newRequest ? [newRequest] : []), ...(invalidation ? [invalidation] : [])]);
      MetadataParser.setTypeContentsCacheStoragePath(null);
      cacheApi.invalidateTypeContentsCache = originalInvalidate;
      cacheApi.loadTypeContentsFromCache = originalLoad;
      mutableFsPromises.writeFile = forwardWriteFile;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalContents;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });

  test('a failed disk operation does not reject later cache work in the queue', async () => {
    const fixture = await makeFixture('queue-recovery');
    const originalClear = cacheApi.clearTypeContentsCache;
    const originalInvalidate = cacheApi.invalidateTypeContentsCache;
    const clearStarted = deferred<void>();
    const releaseClear = deferred<void>();
    let invalidationRuns = 0;
    let clearResult: Promise<void> | undefined;
    let invalidateResult: Promise<void> | undefined;

    try {
      MetadataParser.setTypeContentsCacheStoragePath(fixture.storagePath);
      cacheApi.clearTypeContentsCache = async () => {
        clearStarted.resolve();
        await releaseClear.promise;
        throw new Error('disk clear failed');
      };
      cacheApi.invalidateTypeContentsCache = async () => {
        invalidationRuns += 1;
      };

      clearResult = MetadataParser.clearTypeContentsCache();
      await clearStarted.promise;
      invalidateResult = MetadataParser.invalidateTypeContentsCache(fixture.configPath);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(invalidationRuns, 0, 'the next cache operation must wait behind the failing operation');

      releaseClear.resolve();
      const [clear, invalidate] = await Promise.allSettled([clearResult, invalidateResult]);

      assert.strictEqual(clear.status, 'rejected');
      assert.strictEqual(invalidate.status, 'fulfilled');
      assert.strictEqual(invalidationRuns, 1, 'a rejected operation must not poison the FIFO tail');
    } finally {
      releaseClear.resolve();
      await Promise.allSettled([clearResult, invalidateResult].filter((pending): pending is Promise<void> => pending !== undefined));
      MetadataParser.setTypeContentsCacheStoragePath(null);
      cacheApi.clearTypeContentsCache = originalClear;
      cacheApi.invalidateTypeContentsCache = originalInvalidate;
      await fs.promises.rm(fixture.configPath, { recursive: true, force: true });
      await fs.promises.rm(fixture.storagePath, { recursive: true, force: true });
    }
  });
});
