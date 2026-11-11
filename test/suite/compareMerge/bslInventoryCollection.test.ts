import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import * as bslModuleIndexer from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { hashText } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';
import {
  buildBslModuleIndex,
  indexBslModuleSource,
} from '../../../src/compareMerge/bsl/bslModuleIndexer';
import {
  collectBslInventorySources,
  resolveBslInventoryIdentities,
} from '../../../src/compareMerge/bsl/bslInventoryCollection';
import type { ResolvedBslInventoryFile } from '../../../src/compareMerge/bsl/bslSourceRetention';

suite('BSL inventory collection', () => {
  test('reads every artifact, hashes and indexes last-wins duplicate paths across batch boundaries, retaining only selected sources', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-collection-'));
    const duplicatePath = path.join(root, 'Catalogs', 'Item63', 'Ext', 'ObjectModule.bsl');
    const unsupportedPath = path.join(root, 'Z-unsupported.bsl');
    const filePaths: string[] = [];
    let activeReads = 0;
    let peakReads = 0;
    let readCount = 0;
    const readsByPath = new Map<string, number>();

    try {
      for (let index = 0; index < 63; index += 1) {
        filePaths.push(await createBslFile(root, `Catalogs/Item${String(index).padStart(2, '0')}/Ext/ObjectModule.bsl`));
      }
      filePaths.push(await createBslFile(root, 'Catalogs/Item63/Ext/ObjectModule.bsl'));
      filePaths.push(duplicatePath);
      filePaths.push(await createBslFile(root, 'Z-unsupported.bsl'));

      const resolution = await resolveBslInventoryIdentities({
        sourceId: 'right-source',
        side: 'right',
        configRoot: root,
        filePaths,
      });
      assert.strictEqual(resolution.sourceCount, 66);
      assert.strictEqual(resolution.files.length, 65, 'index and hash use distinct paths, as the old Map did');

      const selected = new Set([filePaths[0], duplicatePath]);
      const rawRetainedSource = '\uFEFFProcedure RunItem00()\r\nEndProcedure\rProcedure Tail()\nEndProcedure';
      const collection = await collectBslInventorySources({
        resolution,
        retainedPaths: selected,
        concurrency: 3,
        readTextFile: async (filePath) => {
          activeReads += 1;
          readCount += 1;
          peakReads = Math.max(peakReads, activeReads);
          const occurrence = (readsByPath.get(filePath) ?? 0) + 1;
          readsByPath.set(filePath, occurrence);
          try {
            await Promise.resolve();
            if (filePath === duplicatePath) {
              return occurrence === 1
                ? 'Procedure FirstVersion()\nEndProcedure'
                : 'Procedure LastVersion()\nEndProcedure';
            }
            if (filePath === unsupportedPath) {
              return 'Unrecognized module source';
            }
            if (filePath === filePaths[0]) {
              return rawRetainedSource;
            }
            const objectName = path.basename(path.dirname(path.dirname(filePath)));
            return `Procedure Run${objectName}()\nEndProcedure`;
          } finally {
            activeReads -= 1;
          }
        },
      });

      assert.strictEqual(readCount, 66, 'duplicate inventory entries are still read');
      assert.ok(peakReads <= 3, `expected at most three concurrent reads, got ${peakReads}`);
      assert.strictEqual(collection.sourceCount, 66);
      assert.deepStrictEqual([...collection.sources.keys()].sort(), [...selected].sort());
      assert.strictEqual(collection.sources.get(filePaths[0]!), rawRetainedSource);
      assert.strictEqual(collection.sources.get(duplicatePath), 'Procedure LastVersion()\nEndProcedure');
      assert.strictEqual(collection.index.modules.length, 64);
      const duplicateModule = collection.index.modules.find((module) => module.identity.filePath === duplicatePath);
      assert.strictEqual(duplicateModule?.routines[0]?.name, 'LastVersion');
      assert.ok(collection.index.diagnostics.some((diagnostic) =>
        diagnostic.code === 'BSL_MODULE_UNSUPPORTED_PATH' && diagnostic.filePath === unsupportedPath));

      const expectedSources = new Map<string, string>();
      for (const filePath of [...filePaths].sort((left, right) => left.localeCompare(right))) {
        const objectName = path.basename(path.dirname(path.dirname(filePath)));
        expectedSources.set(
          filePath,
          filePath === duplicatePath
            ? 'Procedure LastVersion()\nEndProcedure'
            : filePath === unsupportedPath
              ? 'Unrecognized module source'
              : filePath === filePaths[0]
                ? rawRetainedSource
              : `Procedure Run${objectName}()\nEndProcedure`
        );
      }
      assert.strictEqual(collection.contentHash, hashSourcesLikeLegacyMap(expectedSources));
      const expectedIndex = await buildBslModuleIndex(
        [...expectedSources].map(([filePath, source]) => ({
          sourceId: 'right-source',
          side: 'right',
          filePath,
          configRoots: [root],
          source,
        }))
      );
      assert.deepStrictEqual(collection.index, expectedIndex);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('reads and hashes deferred sources without parsing them while retaining paired and unsupported results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-selective-analysis-'));
    const pairedPath = await createBslFile(root, 'Catalogs/Paired/Ext/ObjectModule.bsl');
    const deferredPath = await createBslFile(root, 'Catalogs/Unmatched/Ext/ObjectModule.bsl');
    const unsupportedPath = await createBslFile(root, 'Unsupported.bsl');
    const filePaths = [pairedPath, deferredPath, unsupportedPath, deferredPath];
    const resolution = await resolveBslInventoryIdentities({
      sourceId: 'right-source',
      side: 'right',
      configRoot: root,
      filePaths,
    });
    const pairedIdentity = resolution.files.find((file) => file.filePath === pairedPath)?.identity;
    assert.ok(pairedIdentity, 'paired module path should have a supported identity');
    const pairedSource = 'Procedure Shared()\n  Value = 1;\nEndProcedure';
    const deferredFirstSource = 'Procedure Temporary()\nEndProcedure';
    const deferredLastSource = 'Procedure Broken(\n';
    const unsupportedSource = 'Unrecognized module source';
    const expectedPaired = indexBslModuleSource({ identity: pairedIdentity!, source: pairedSource });
    const indexerModule = bslModuleIndexer as unknown as {
      indexBslModuleSource: typeof indexBslModuleSource;
    };
    const originalIndexBslModuleSource = indexerModule.indexBslModuleSource;
    const indexedPaths: string[] = [];
    const readsByPath = new Map<string, number>();
    const expectedSources = new Map([
      [pairedPath, pairedSource],
      [deferredPath, deferredLastSource],
      [unsupportedPath, unsupportedSource],
    ]);

    indexerModule.indexBslModuleSource = (input) => {
      indexedPaths.push(input.identity.filePath);
      return originalIndexBslModuleSource(input);
    };

    try {
      const collectionOptions = {
        resolution,
        retainedPaths: new Set([pairedPath, deferredPath]),
        analysisPaths: new Set([pairedPath]),
        concurrency: 3,
        readTextFile: async (filePath: string) => {
          const occurrence = (readsByPath.get(filePath) ?? 0) + 1;
          readsByPath.set(filePath, occurrence);
          if (filePath === pairedPath) {return pairedSource;}
          if (filePath === deferredPath) {
            return occurrence === 1 ? deferredFirstSource : deferredLastSource;
          }
          return unsupportedSource;
        },
      };
      const collection = await collectBslInventorySources(
        collectionOptions as Parameters<typeof collectBslInventorySources>[0]
      );
      const pairedModule = collection.index.modules.find((module) => module.identity.filePath === pairedPath);
      const deferredModule = collection.index.modules.find((module) => module.identity.filePath === deferredPath);

      assert.strictEqual(resolution.sourceCount, 4);
      assert.strictEqual([...readsByPath.values()].reduce((sum, count) => sum + count, 0), 4);
      assert.deepStrictEqual(indexedPaths, [pairedPath], 'only the paired module should invoke the parser');
      assert.ok(pairedModule);
      assert.deepStrictEqual(pairedModule!.identity, expectedPaired.identity);
      assert.deepStrictEqual(pairedModule!.routines, expectedPaired.routines);
      assert.deepStrictEqual(pairedModule!.diagnostics, expectedPaired.diagnostics);
      assert.ok(
        moduleAnalysisState(pairedModule) === undefined || moduleAnalysisState(pairedModule) === 'complete',
        'parsed entries may omit analysisState or declare complete analysis',
      );
      assert.ok(deferredModule);
      assert.deepStrictEqual(deferredModule!.routines, []);
      assert.deepStrictEqual(deferredModule!.diagnostics, []);
      assert.strictEqual(moduleAnalysisState(deferredModule), 'deferred');
      assert.deepStrictEqual(
        collection.index.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.filePath]),
        [['BSL_MODULE_UNSUPPORTED_PATH', unsupportedPath]],
      );
      assert.deepStrictEqual([...collection.sources.keys()].sort(), [pairedPath, deferredPath].sort());
      assert.strictEqual(collection.sources.get(pairedPath), pairedSource);
      assert.strictEqual(collection.sources.get(deferredPath), deferredLastSource);
      assert.strictEqual(collection.contentHash, hashSourcesLikeLegacyMap(expectedSources));
    } finally {
      indexerModule.indexBslModuleSource = originalIndexBslModuleSource;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('keeps read draining and cancellation active when every source is deferred', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-deferred-cancel-'));
    const filePaths: string[] = [];
    const cancellation = { isCancellationRequested: false };
    let started = 0;
    let active = 0;
    const releases: Array<() => void> = [];

    try {
      for (let index = 0; index < 4; index += 1) {
        filePaths.push(await createBslFile(root, `Catalogs/Deferred${index}/Ext/ObjectModule.bsl`));
      }
      const resolution = await resolveBslInventoryIdentities({
        sourceId: 'right-source', side: 'right', configRoot: root, filePaths,
      });
      const collectionOptions = {
        resolution,
        retainedPaths: new Set(filePaths),
        analysisPaths: new Set<string>(),
        concurrency: 2,
        cancellation,
        readTextFile: async () => {
          started += 1;
          active += 1;
          return new Promise<string>((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve('Procedure Deferred()\nEndProcedure');
            });
          });
        },
      };
      const task = collectBslInventorySources(
        collectionOptions as Parameters<typeof collectBslInventorySources>[0]
      );

      await waitFor(() => started === 2);
      cancellation.isCancellationRequested = true;
      releases.splice(0).forEach((release) => release());
      await assert.rejects(task, (error: unknown) =>
        (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED');
      assert.strictEqual(active, 0);
      assert.strictEqual(started, 2, 'deferred sources still flow through bounded reads before cancellation');
    } finally {
      releases.splice(0).forEach((release) => release());
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('yields during identity pre-resolution and observes cancellation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-prepass-'));
    const filePaths: string[] = [];
    const cancellation = { isCancellationRequested: false };
    let cancellationImmediate: NodeJS.Immediate | undefined;

    try {
      for (let index = 0; index < 65; index += 1) {
        filePaths.push(await createBslFile(root, `Catalogs/Item${String(index).padStart(2, '0')}/Ext/ObjectModule.bsl`));
      }
      cancellationImmediate = setImmediate(() => { cancellation.isCancellationRequested = true; });

      await assert.rejects(
        resolveBslInventoryIdentities({
          sourceId: 'right-source',
          side: 'right',
          configRoot: root,
          filePaths,
          cancellation,
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED'
      );
    } finally {
      if (cancellationImmediate) {clearImmediate(cancellationImmediate);}
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('deduplicates stable locale ties by exact path with Map insertion order across a batch boundary', async () => {
    const prefixPaths = Array.from({ length: 62 }, (_, index) =>
      `C:\\root\\A${String(index).padStart(3, '0')}.bsl`);
    const composedPath = 'C:\\root\\Catalogs\\Caf\u00e9.bsl';
    const decomposedPath = 'C:\\root\\Catalogs\\Cafe\u0301.bsl';
    assert.strictEqual(composedPath.localeCompare(decomposedPath), 0);

    const filePaths = [...prefixPaths, composedPath, decomposedPath, composedPath];
    const uniquePaths = [...new Set(filePaths)];
    const resolution = {
      filePaths,
      files: uniquePaths.map((filePath) => unsupportedFile(filePath)),
      sourceCount: filePaths.length,
    };
    const readsByPath = new Map<string, number>();
    const expectedSources = new Map<string, string>();

    for (const filePath of filePaths) {
      const occurrence = (readsByPath.get(filePath) ?? 0) + 1;
      readsByPath.set(filePath, occurrence);
      expectedSources.set(filePath, sourceForPath(filePath, occurrence));
    }
    readsByPath.clear();

    const collection = await collectBslInventorySources({
      resolution,
      retainedPaths: new Set(),
      concurrency: 4,
      readTextFile: async (filePath) => {
        const occurrence = (readsByPath.get(filePath) ?? 0) + 1;
        readsByPath.set(filePath, occurrence);
        return sourceForPath(filePath, occurrence);
      },
    });

    const expectedUniquePaths = [...expectedSources.keys()];
    assert.strictEqual(collection.index.diagnostics.length, expectedUniquePaths.length);
    assert.deepStrictEqual(collection.index.diagnostics.map((diagnostic) => diagnostic.filePath), expectedUniquePaths);
    assert.strictEqual(collection.contentHash, hashSourcesLikeLegacyMap(expectedSources));
  });

  test('drains active reads on cancellation and stops queuing work', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-cancel-drain-'));
    const filePaths: string[] = [];
    const cancellation = { isCancellationRequested: false };
    let started = 0;
    let active = 0;
    const releases: Array<() => void> = [];

    try {
      for (let index = 0; index < 4; index += 1) {
        filePaths.push(await createBslFile(root, `Catalogs/Item${index}/Ext/ObjectModule.bsl`));
      }
      const resolution = await resolveBslInventoryIdentities({
        sourceId: 'right-source', side: 'right', configRoot: root, filePaths,
      });
      const task = collectBslInventorySources({
        resolution,
        retainedPaths: new Set(filePaths),
        concurrency: 2,
        cancellation,
        readTextFile: async () => {
          started += 1;
          active += 1;
          return new Promise<string>((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve('Procedure Run()\nEndProcedure');
            });
          });
        },
      });

      await waitFor(() => started === 2);
      cancellation.isCancellationRequested = true;
      releases.splice(0).forEach((release) => release());
      await assert.rejects(task, (error: unknown) =>
        (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED');
      assert.strictEqual(active, 0);
      assert.strictEqual(started, 2, 'no later reads should start after cancellation');
    } finally {
      releases.splice(0).forEach((release) => release());
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('yields and observes cancellation while indexing a large inventory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-index-cancel-'));
    const filePaths: string[] = [];
    const cancellation = { isCancellationRequested: false };
    let timer: NodeJS.Timeout | undefined;
    let startedReads = 0;

    try {
      for (let index = 0; index < 65; index += 1) {
        filePaths.push(await createBslFile(root, `Catalogs/Item${String(index).padStart(2, '0')}/Ext/ObjectModule.bsl`));
      }
      const resolution = await resolveBslInventoryIdentities({
        sourceId: 'right-source', side: 'right', configRoot: root, filePaths,
      });
      const task = collectBslInventorySources({
        resolution,
        retainedPaths: new Set(),
        concurrency: 64,
        cancellation,
        readTextFile: async () => {
          startedReads += 1;
          if (!timer) {
            timer = setTimeout(() => { cancellation.isCancellationRequested = true; }, 0);
          }
          return 'Procedure Run()\nEndProcedure';
        },
      });

      await assert.rejects(task, (error: unknown) =>
        (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED');
      assert.strictEqual(startedReads, 64, 'the next read batch starts only after the indexer yields');
    } finally {
      if (timer) {clearTimeout(timer);}
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('drains active reads after a read failure and preserves the original error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-inventory-error-drain-'));
    const filePaths: string[] = [];
    let started = 0;
    let active = 0;
    let siblingFinished = false;
    const readError = new Error('read failed');

    try {
      for (let index = 0; index < 4; index += 1) {
        filePaths.push(await createBslFile(root, `Catalogs/Item${index}/Ext/ObjectModule.bsl`));
      }
      const resolution = await resolveBslInventoryIdentities({
        sourceId: 'right-source', side: 'right', configRoot: root, filePaths,
      });
      const firstPath = [...filePaths].sort((left, right) => left.localeCompare(right))[0];
      await assert.rejects(
        collectBslInventorySources({
          resolution,
          retainedPaths: new Set(filePaths),
          concurrency: 2,
          readTextFile: async (filePath) => {
            started += 1;
            active += 1;
            try {
              if (filePath === firstPath) {
                throw readError;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
              siblingFinished = true;
              return 'Procedure Run()\nEndProcedure';
            } finally {
              active -= 1;
            }
          },
        }),
        (error: unknown) => error === readError
      );
      assert.strictEqual(started, 2, 'failure stops new work while the active sibling drains');
      assert.strictEqual(siblingFinished, true);
      assert.strictEqual(active, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function createBslFile(root: string, relativePath: string): Promise<string> {
  const filePath = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '');
  return filePath;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.strictEqual(condition(), true, 'condition did not become true');
}

function hashSourcesLikeLegacyMap(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const [filePath, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path.normalize(filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(hashText(source));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function moduleAnalysisState(module: unknown): 'complete' | 'deferred' | undefined {
  return (module as { analysisState?: 'complete' | 'deferred' }).analysisState;
}

function unsupportedFile(filePath: string): ResolvedBslInventoryFile {
  return {
    filePath,
    diagnostic: {
      severity: 'warning',
      code: 'BSL_MODULE_UNSUPPORTED_PATH',
      blocking: false,
      message: 'Unsupported path.',
      sourceId: 'right-source',
      side: 'right',
      filePath,
    },
  };
}

function sourceForPath(filePath: string, occurrence: number): string {
  if (filePath.endsWith('Caf\u00e9.bsl')) {
    return occurrence === 1 ? 'Procedure FirstVersion()' : 'Procedure LastVersion()';
  }
  if (filePath.endsWith('Cafe\u0301.bsl')) {
    return 'Procedure NormalizationTie()';
  }
  return `Unsupported ${path.basename(filePath)}`;
}
