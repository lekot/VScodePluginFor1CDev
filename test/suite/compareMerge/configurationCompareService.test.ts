import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  buildConfigurationCompare as buildConfigurationCompareWithoutMutationRuntime,
  type ConfigurationCompareInput,
} from '../../../src/compareMerge/configurationCompareService';
import { toWebviewPayload } from '../../../src/compareMerge/configCompareProvider';
import type { CompareBuildProgress } from '../../../src/compareMerge/compareProgress';
import type { CompareDisplayNode } from '../../../src/compareMerge/projection/compareDisplayTree';
import { awaitAllSettled, createCompareProgressThrottle, mapLimit } from '../../../src/compareMerge/compareBuildPipeline';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const mutationCoordinators: Array<{ dispose(): Promise<void> }> = [];

suite('ConfigurationCompareService', () => {
  suiteTeardown(async () => {
    await Promise.all(mutationCoordinators.splice(0).map((coordinator) => coordinator.dispose()));
  });

  test('cancellation before compare stops before filesystem work', async () => {
    await assert.rejects(
      buildConfigurationCompare({
        leftRootPath: path.join(os.tmpdir(), 'missing-left'),
        rightRootPath: path.join(os.tmpdir(), 'missing-right'),
        backupRootPath: path.join(os.tmpdir(), 'missing-backup'),
        cancellation: { isCancellationRequested: true },
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED'
    );
  });

  test('throttles progress on a deterministic monotonic clock while keeping first and final results', () => {
    let now = 0;
    const shouldPublish = createCompareProgressThrottle(() => now);

    assert.strictEqual(shouldPublish(1, 100), true);
    assert.strictEqual(shouldPublish(2, 100), false);
    now = 99;
    assert.strictEqual(shouldPublish(50, 100), false);
    now = 100;
    assert.strictEqual(shouldPublish(51, 100), true);
    assert.strictEqual(shouldPublish(100, 100), true);
  });

  test('applies the minimum cooldown after publication completes', () => {
    let now = 0;
    const shouldPublish = createCompareProgressThrottle(() => now);

    assert.strictEqual(shouldPublish(1, 10), true);
    now = 5;
    shouldPublish.publicationFinished(0);
    now = 104;
    assert.strictEqual(shouldPublish(2, 10), false);
    now = 105;
    assert.strictEqual(shouldPublish(3, 10), true);
  });

  test('sets cooldown to publication end plus nine times its duration when longer', () => {
    let now = 0;
    const shouldPublish = createCompareProgressThrottle(() => now);

    assert.strictEqual(shouldPublish(1, 10), true);
    now = 20;
    shouldPublish.publicationFinished(0);
    now = 199;
    assert.strictEqual(shouldPublish(2, 10), false);
    now = 200;
    assert.strictEqual(shouldPublish(3, 10), true);
  });

  test('cools progress from publication completion when observers consume the interval', async () => {
    const originalNow = performance.now;
    const items = Array.from({ length: 1024 }, (_, index) => index);
    const publications: Array<{ completed: number; total: number; results: number[] }> = [];
    let now = 0;
    performance.now = () => now;

    try {
      const results = await mapLimit(
        items,
        4,
        async (item) => {
          await Promise.resolve();
          if (item % 7 === 0) {
            await Promise.resolve();
          }
          return item;
        },
        undefined,
        (completed, total, completedResults) => {
          publications.push({ completed, total, results: [...completedResults] });
          now += 1000;
        }
      );

      assert.deepStrictEqual(results, items);
      assert.deepStrictEqual(publications.map((publication) => publication.completed), [1, items.length]);
      assert.ok(publications.every((publication) => publication.results.length === publication.completed));
      assert.ok(publications.every((publication) =>
        publication.results.every((value, index, values) => index === 0 || values[index - 1]! < value)
      ));
      assert.ok(publications.every((publication) => publication.total === items.length));
    } finally {
      performance.now = originalNow;
    }
  });

  test('keeps observer exceptions advisory while still applying publication cooldown', async () => {
    const originalNow = performance.now;
    const items = Array.from({ length: 32 }, (_, index) => index);
    const publicationCounts: number[] = [];
    let now = 0;
    performance.now = () => now;

    try {
      const results = await mapLimit(items, 4, async (item) => item, undefined, (completed) => {
        publicationCounts.push(completed);
        now += 1000;
        throw new Error('advisory observer failure');
      });

      assert.deepStrictEqual(results, items);
      assert.deepStrictEqual(publicationCounts, [1, items.length]);
    } finally {
      performance.now = originalNow;
    }
  });

  test('does not read the progress clock when no observer is registered', async () => {
    const originalNow = performance.now;
    let clockReads = 0;
    performance.now = () => {
      clockReads += 1;
      return clockReads;
    };

    try {
      const items = Array.from({ length: 128 }, (_, index) => index);
      assert.deepStrictEqual(await mapLimit(items, 4, async (item) => item), items);
      assert.strictEqual(clockReads, 0);
    } finally {
      performance.now = originalNow;
    }
  });

  test('publishes read-only metadata presence before inventory and preserves it in later partial projections', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-early-metadata-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const progress: CompareBuildProgress[] = [];
    let result: Awaited<ReturnType<typeof buildConfigurationCompareWithoutMutationRuntime>> | undefined;

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'same-products', 'Products');
      await writeCatalogDescriptor(rightRoot, 'Products', 'same-products', 'Products');
      await writeCatalogDescriptor(leftRoot, 'Conflict', 'left-conflict', 'Conflict left');
      await writeCatalogDescriptor(rightRoot, 'Conflict', 'right-conflict', 'Conflict right');
      await writeCatalogDescriptor(leftRoot, 'LeftOnly', 'left-only', 'Left only');
      await writeCatalogDescriptor(rightRoot, 'RightOnly', 'right-only', 'Right only');

      result = await buildConfigurationCompareWithoutMutationRuntime({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategyResult = await result.workspace.setStrategy('full', {
        onProgress: (update) => progress.push(update),
      });
      assert.strictEqual(strategyResult.ok, true, JSON.stringify(strategyResult));

      const metadataIndex = progress.findIndex(
        (update) => update.phase === 'metadata' && update.projection !== undefined
      );
      const inventoryIndex = progress.findIndex((update) => update.phase === 'inventory');
      assert.ok(metadataIndex >= 0, 'expected a metadata projection before inventory starts');
      assert.ok(inventoryIndex > metadataIndex, 'metadata presence must be published before inventory');

      const metadataProjection = progress[metadataIndex]!.projection!;
      assertPartialMetadataProjection(metadataProjection);
      const metadataNodes = collectNodes(metadataProjection.root, () => true);
      assert.ok(metadataNodes.some((node) => node.kind === 'metadataObject' && node.label === 'Catalog.LeftOnly'));
      assert.ok(metadataNodes.some((node) => node.kind === 'metadataObject' && node.label === 'Catalog.RightOnly'));
      assert.ok(
        metadataNodes.some(
          (node) => node.kind === 'metadataConflict' && node.conflict?.kind === 'sameNameDifferentUuid'
        )
      );

      const bslProjection = progress.find(
        (update) => update.phase === 'bsl' && update.projection !== undefined
      )?.projection;
      assert.ok(bslProjection, 'expected a BSL partial projection');
      assertPartialMetadataProjection(bslProjection!);
      const comparingProjection = progress.find(
        (update) => update.phase === 'comparing' && update.projection !== undefined && (update.completed ?? 0) > 0
      )?.projection;
      assert.ok(comparingProjection, 'expected a partial adapter comparison projection');
      assertPartialMetadataProjection(comparingProjection!);

      const finalMetadataMatches = collectNodes(
        result.workspace.payload.root,
        (node) => node.kind === 'metadataMatch'
      );
      assert.ok(finalMetadataMatches.length > 0, 'complete metadata matches belong in the final projection');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('publishes cumulative read-only compare progress and scopes callbacks to each refresh', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-progress-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const progress: CompareBuildProgress[] = [];
    const refreshProgress: CompareBuildProgress[] = [];
    const partialMetadataObjectLabels: string[][] = [];
    let result: Awaited<ReturnType<typeof buildConfigurationCompareWithoutMutationRuntime>> | undefined;
    let mutatedSnapshotCount = 0;
    let mutatedPresentationCount = 0;

    try {
      for (let index = 0; index < 3; index += 1) {
        await writeCatalog(rightRoot, `Incoming${index}`, `incoming-${index}`);
      }

      result = await buildConfigurationCompareWithoutMutationRuntime({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        onProgress: (update) => {
          progress.push(update);
          if (update.phase === 'comparing' && update.projection && (update.completed ?? 0) > 0) {
            partialMetadataObjectLabels.push(
              collectNodes(update.projection.root, (node) => node.kind === 'metadataObject')
                .map((node) => node.label)
            );
          }
          if ((update.phase === 'comparing' || update.phase === 'projecting') && update.projection) {
            const firstObject = collectNodes(update.projection.root, (node) => node.kind === 'metadataObject')[0];
            if (firstObject) {
              firstObject.label = 'Tampered by progress consumer';
              const firstIdentity = firstObject.presentation?.identities?.[0];
              if (firstIdentity) {
                firstIdentity.qualifiedName = 'Tampered identity';
                mutatedPresentationCount += 1;
              }
              if (firstObject.presentation?.ownerAliases) {
                firstObject.presentation.ownerAliases[0] = 'Tampered alias';
              }
              mutatedSnapshotCount += 1;
            }
          }
        },
      });

      const partialUpdates = progress.filter(
        (update) => update.phase === 'comparing' && update.projection && (update.completed ?? 0) > 0
      );
      assert.ok(partialUpdates.length >= 2, 'expected a first partial result and a cumulative update');
      const firstProjection = partialUpdates[0].projection!;
      const finalCompareUpdate = partialUpdates.find((update) => update.completed === update.total)!;
      assert.ok(finalCompareUpdate);
      const firstObjectLabels = partialMetadataObjectLabels[0];
      const finalObjectLabels = collectNodes(result.projection.root, (node) => node.kind === 'metadataObject')
        .map((node) => node.label);
      assert.ok(firstObjectLabels.length > 0);
      assert.deepStrictEqual(
        firstObjectLabels,
        finalObjectLabels,
        'the first partial projection should already include all proven unmatched metadata rows'
      );
      assert.deepStrictEqual(
        partialMetadataObjectLabels[partialMetadataObjectLabels.length - 1],
        finalObjectLabels,
        'the cumulative partial should retain the proven unmatched metadata rows'
      );
      assert.ok(
        partialUpdates[0]!.completed! < finalCompareUpdate.completed!,
        'cumulative comparison progress should advance before its final update'
      );
      assert.ok(mutatedSnapshotCount >= 2);
      assert.ok(mutatedPresentationCount >= 1);
      assert.ok(!finalObjectLabels.includes('Tampered by progress consumer'));
      const canonicalMetadataObject = collectNodes(result.projection.root, (node) => node.kind === 'metadataObject')[0];
      assert.ok(canonicalMetadataObject);
      assert.ok(canonicalMetadataObject.presentation?.identities?.[0]);
      assert.strictEqual(
        canonicalMetadataObject.presentation.identities[0].qualifiedName,
        canonicalMetadataObject.label
      );
      assert.ok(canonicalMetadataObject.presentation.ownerAliases?.[0]?.includes(canonicalMetadataObject.label));
      assert.strictEqual(firstProjection.stats.mergeable, 0);
      assert.strictEqual(
        collectNodes(firstProjection.root, (node) => node.mergeable === true).length,
        0,
        'partial rows must not advertise executable merge candidates'
      );
      assert.strictEqual(result.projection.stats.mergeable, 3);
      assert.strictEqual(result.workspace.listMergeableNodeIds().length, 3);

      const initialCallbackCount = progress.length;
      const refreshed = await result.workspace.refresh({
        onProgress: (update) => refreshProgress.push(update),
      });
      assert.strictEqual(refreshed.ok, true);
      assert.ok(refreshProgress.length > 0);
      assert.strictEqual(progress.length, initialCallbackCount, 'refresh must not reuse the initial callback');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('yields to the event loop while processing immediately resolving bounded work', async () => {
    const itemCount = 1024;
    const items = Array.from({ length: itemCount }, (_, index) => index);
    const cancellation = { isCancellationRequested: false };
    let completed = 0;
    const cancellationImmediate = setImmediate(() => {
      cancellation.isCancellationRequested = true;
    });

    try {
      await assert.rejects(
        mapLimit(items, 4, async () => ++completed, cancellation),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED'
      );
      assert.ok(completed < itemCount, `expected cancellation before all ${itemCount} items completed`);
    } finally {
      clearImmediate(cancellationImmediate);
    }
  });

  test('waits for every parallel build side to settle before propagating a failure', async () => {
    const failure = new Error('left side failed');
    let releaseRight!: () => void;
    let rightSettled = false;
    const right = new Promise<string>((resolve) => {
      releaseRight = () => {
        rightSettled = true;
        resolve('right complete');
      };
    });
    const result = awaitAllSettled([Promise.reject(failure), right]);
    let rejected = false;
    void result.catch(() => { rejected = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(rejected, false);
    assert.strictEqual(rightSettled, false);
    releaseRight();
    await assert.rejects(result, (error: unknown) => error === failure);
    assert.strictEqual(rightSettled, true);
  });

  test('ignores progress callback exceptions', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-progress-callback-'));
    try {
      await fs.mkdir(path.join(tempRoot, 'left'), { recursive: true });
      await fs.mkdir(path.join(tempRoot, 'right'), { recursive: true });
      const result = await buildConfigurationCompareWithoutMutationRuntime({
        leftRootPath: path.join(tempRoot, 'left'),
        rightRootPath: path.join(tempRoot, 'right'),
        backupRootPath: path.join(tempRoot, 'backups'),
        onProgress: () => {
          throw new Error('UI callback failed');
        },
      });
      result.workspace.dispose();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('waits for in-flight compare reads to settle after cancellation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-cancel-drain-'));
    const rightRoot = path.join(tempRoot, 'right');
    let cancellationRequested = false;
    let cancellationObservedResolve!: () => void;
    const cancellationObserved = new Promise<void>((resolve) => {
      cancellationObservedResolve = resolve;
    });
    const cancellation = {
      get isCancellationRequested(): boolean {
        if (cancellationRequested) {
          cancellationObservedResolve();
          return true;
        }
        return false;
      },
    };
    let secondReadStartedResolve!: () => void;
    const secondReadStarted = new Promise<void>((resolve) => {
      secondReadStartedResolve = resolve;
    });
    let releaseSecondRead!: () => void;
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    let readCalls = 0;
    let settled = false;

    try {
      for (const name of ['First', 'Second']) {
        await writeCatalog(rightRoot, name, `cancel-${name}`);
        await writeFile(
          path.join(rightRoot, 'Catalogs', name, 'Ext', 'ObjectModule.bsl'),
          `Procedure ${name}()\nEndProcedure`
        );
      }

      const compare = buildConfigurationCompareWithoutMutationRuntime({
        leftRootPath: path.join(tempRoot, 'left'),
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        cancellation,
        limits: { bslReadConcurrency: 2 },
        io: {
          readTextFile: async (filePath) => {
            readCalls += 1;
            if (readCalls === 1) {
              const content = await fs.readFile(filePath, 'utf-8');
              cancellationRequested = true;
              return content;
            }
            if (readCalls === 2) {
              secondReadStartedResolve();
              await secondReadGate;
            }
            return fs.readFile(filePath, 'utf-8');
          },
        },
      }).finally(() => {
        settled = true;
      });

      await secondReadStarted;
      await cancellationObserved;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'compare must still own its in-flight read');
      releaseSecondRead();
      await assert.rejects(
        compare,
        (error: unknown) =>
          (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED'
      );
      assert.strictEqual(settled, true);
    } finally {
      releaseSecondRead?.();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('shows an explicit unsupported diagnostic for EDT roots instead of an empty Designer compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-edt-'));
    const leftRoot = path.join(tempRoot, 'edt-project');
    const rightRoot = path.join(tempRoot, 'edt-src-root');
    let result: Awaited<ReturnType<typeof buildConfigurationCompareWithoutMutationRuntime>> | undefined;
    try {
      await writeFile(path.join(leftRoot, 'src', 'Configuration', 'Configuration.mdo'), '<Configuration/>');
      await writeFile(path.join(rightRoot, 'Configuration', 'Configuration.mdo'), '<Configuration/>');
      result = await buildConfigurationCompareWithoutMutationRuntime({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });

      const diagnostics = collectNodes(result.projection.root, (node) =>
        node.kind === 'diagnostic' && node.label === 'CONFIG_COMPARE_EDT_UNSUPPORTED'
      );
      assert.strictEqual(diagnostics.length, 2);
      assert.strictEqual(result.session.state.messages.filter((message) => message.code === 'CONFIG_COMPARE_EDT_UNSUPPORTED').length, 2);
      assert.strictEqual(result.workspace.selectNodeIds([]).canCreatePreview, false);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('bounds BSL reads by configured concurrency', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-bounded-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    let activeReads = 0;
    let peakReads = 0;
    let bslReads = 0;

    try {
      for (let index = 0; index < 6; index += 1) {
        const name = `Item${index}`;
        await writeCatalog(leftRoot, name, `catalog-${index}`);
        await writeCatalog(rightRoot, name, `catalog-${index}`);
        await writeFile(
          path.join(leftRoot, 'Catalogs', name, 'Ext', 'ObjectModule.bsl'),
          `Procedure Run${index}()\nEndProcedure`
        );
        await writeFile(
          path.join(rightRoot, 'Catalogs', name, 'Ext', 'ObjectModule.bsl'),
          `Procedure Run${index}()\nEndProcedure`
        );
      }

      await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        limits: { bslReadConcurrency: 2 },
        io: {
          readTextFile: async (filePath) => {
            activeReads += 1;
            bslReads += path.extname(filePath).toLowerCase() === '.bsl' ? 1 : 0;
            peakReads = Math.max(peakReads, activeReads);
            await new Promise((resolve) => setTimeout(resolve, 5));
            try {
              return await fs.readFile(filePath, 'utf-8');
            } finally {
              activeReads -= 1;
            }
          },
        },
      });

      assert.strictEqual(bslReads, 12);
      assert.ok(peakReads <= 2, `Expected no more than 2 concurrent reads, got ${peakReads}`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('cancellation during bounded BSL reads aborts compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-cancel-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const cancellation = { isCancellationRequested: false };

    try {
      for (let index = 0; index < 4; index += 1) {
        const name = `Item${index}`;
        await writeCatalog(leftRoot, name, `catalog-${index}`);
        await writeCatalog(rightRoot, name, `catalog-${index}`);
        await writeFile(
          path.join(leftRoot, 'Catalogs', name, 'Ext', 'ObjectModule.bsl'),
          `Procedure Run${index}()\nEndProcedure`
        );
        await writeFile(
          path.join(rightRoot, 'Catalogs', name, 'Ext', 'ObjectModule.bsl'),
          `Procedure Run${index}()\nEndProcedure`
        );
      }

      let completedReads = 0;
      await assert.rejects(
        buildConfigurationCompare({
          leftRootPath: leftRoot,
          rightRootPath: rightRoot,
          backupRootPath: path.join(tempRoot, 'backups'),
          cancellation,
          limits: { bslReadConcurrency: 2 },
          io: {
            readTextFile: async (filePath) => {
              const content = await fs.readFile(filePath, 'utf-8');
              completedReads += 1;
              if (completedReads === 1) {
                cancellation.isCancellationRequested = true;
              }
              return content;
            },
          },
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'CONFIGURATION_COMPARE_CANCELLED'
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('default right strategy indexes only matching left descriptors for small incoming config', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(
        path.join(leftRoot, 'Catalogs', 'Unrelated.xml'),
        '<MetaDataObject><Catalog>'
      );

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      assert.strictEqual(result.projection.stats.total > 0, true);
      assert.strictEqual(
        collectNodes(result.projection.root, (node) => node.label.includes('Unrelated')).length,
        0
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('default right strategy handles flat right-only descriptor without object folder', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');

    try {
      await fs.mkdir(leftRoot, { recursive: true });
      await writeCatalog(rightRoot, 'Products', 'catalog-products');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const node = collectNodes(
        result.projection.root,
        (candidate) =>
          candidate.kind === 'metadataObject' &&
          candidate.label === 'Catalog.Products' &&
          candidate.mergeState?.targetFilePath === path.join(leftRoot, 'Catalogs', 'Products.xml')
      )[0];

      assert.ok(node);
      assert.strictEqual(node.status, 'rightOnly');
      assert.strictEqual(node.mergeable, true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('default right strategy preserves same-uuid different-name conflict with targeted indexing', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');

    try {
      await writeCatalog(leftRoot, 'OldName', 'catalog-shared');
      await writeCatalog(rightRoot, 'NewName', 'catalog-shared');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      const conflict = requireSingleNode(
        result.projection.root,
        (node) => node.kind === 'metadataConflict' && node.label.includes('catalog-shared')
      );

      assert.strictEqual(conflict.status, 'changed');
      assert.strictEqual(conflict.mergeable, false);
      assert.strictEqual(
        collectNodes(
          result.projection.root,
          (node) => node.kind === 'metadataObject' && node.label === 'Catalog.NewName'
        ).length,
        0
      );
      assert.strictEqual(
        collectNodes(
          result.projection.root,
          (node) => node.kind === 'fileArtifact' && node.label === 'NewName.xml'
        ).length,
        0
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('full strategy keeps same-uuid renamed metadata as a conflict without object copy candidates', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');

    try {
      await writeCatalog(leftRoot, 'OldName', 'catalog-shared');
      await writeCatalog(rightRoot, 'NewName', 'catalog-shared');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));

      const conflict = requireSingleNode(
        result.workspace.payload.root,
        (node) =>
          node.kind === 'metadataConflict' &&
          node.conflict?.kind === 'sameUuidDifferentName'
      );
      const objectCopyCandidates = collectNodes(
        result.workspace.payload.root,
        (node) =>
          node.kind === 'metadataObject' &&
          (node.status === 'leftOnly' || node.status === 'rightOnly') &&
          node.mergeable === true
      );

      assert.strictEqual(conflict.mergeable, false);
      assert.deepStrictEqual(objectCopyCandidates, []);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace previews and executes right-only BSL routine insert from built compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const leftSource = ['Procedure Shared()', '  Value = 1;', 'EndProcedure'].join('\n');
    const rightSource = [
      leftSource,
      '',
      'Procedure AddedOnRight()',
      '  Value = 2;',
      'EndProcedure',
    ].join('\n');
    const expectedMergedSource = [
      leftSource,
      'Procedure AddedOnRight()',
      '  Value = 2;',
      'EndProcedure',
    ].join('\n');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, leftSource);
      await writeFile(rightModulePath, rightSource);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:addedonright';

      assert.strictEqual(
        result.session.state.sources[0]?.rootUri,
        pathToFileURL(leftRoot).toString()
      );
      assert.strictEqual(
        result.session.state.sources[1]?.rootUri,
        pathToFileURL(rightRoot).toString()
      );

      const addedRoutine = requireNode(result.projection.root, nodeId);
      assert.strictEqual(addedRoutine.kind, 'bslRoutine');
      assert.strictEqual(addedRoutine.status, 'rightOnly');
      assert.strictEqual(addedRoutine.mergeable, true);
      assert.strictEqual(addedRoutine.mergeState?.state, 'ready');
      assert.ok(result.workspace, 'Expected build result to expose workspace for provider.');
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [nodeId]);

      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 1);
      assert.deepStrictEqual(preview.preview.items, [
        {
          nodeId,
          label: 'AddedOnRight',
          kind: 'bslRoutine',
          status: 'rightOnly',
        },
      ]);

      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), expectedMergedSource);
      assert.strictEqual(await readText(rightModulePath), rightSource);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace previews and executes left-only BSL routine delete from built compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const sharedRoutine = ['Procedure Shared()', '  Value = 1;', 'EndProcedure'].join('\n');
    const leftSource = [
      sharedRoutine,
      '',
      'Procedure RemovedOnLeft()',
      '  Value = 2;',
      'EndProcedure',
    ].join('\n');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, leftSource);
      await writeFile(rightModulePath, sharedRoutine);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:removedonleft';
      const deletedRoutine = requireNode(result.projection.root, nodeId);

      assert.strictEqual(deletedRoutine.kind, 'bslRoutine');
      assert.strictEqual(deletedRoutine.status, 'leftOnly');
      assert.strictEqual(deletedRoutine.mergeable, true);
      assert.strictEqual(deletedRoutine.mergeState?.state, 'ready');
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [nodeId]);

      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 1);
      assert.deepStrictEqual(preview.preview.items, [
        {
          nodeId,
          label: 'RemovedOnLeft',
          kind: 'bslRoutine',
          status: 'leftOnly',
          destructive: true,
        },
      ]);

      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), `${sharedRoutine}\n`);
      assert.strictEqual(await readText(rightModulePath), sharedRoutine);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('projects right-only BSL module as visible difference', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(
        rightModulePath,
        ['Procedure AddedOnRight()', '  Value = 2;', 'EndProcedure'].join('\n')
      );

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });

      assert.ok(result.projection.stats.different > 0);

      const rightOnlyMessages = collectNodes(
        result.projection.root,
        (node) => node.kind === 'diagnostic' && node.label === 'BSL_MODULE_RIGHT_ONLY'
      );
      assert.strictEqual(rightOnlyMessages.length, 1);
      const rightOnlyMessage = rightOnlyMessages[0]!;
      assert.strictEqual(rightOnlyMessage.status, 'rightOnly');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('does not duplicate matched BSL module diagnostics in projection', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, duplicateRoutineSource());
      await writeFile(rightModulePath, duplicateRoutineSource());

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const duplicateDiagnostics = collectNodes(
        result.projection.root,
        (node) => node.kind === 'diagnostic' && node.label === 'BSL_MODULE_DUPLICATE_ROUTINE'
      );

      assert.strictEqual(duplicateDiagnostics.length, 2);
      assert.strictEqual(
        new Set(duplicateDiagnostics.map((node) => node.id)).size,
        duplicateDiagnostics.length
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace preview succeeds for changed routine with automatic logical insert plan', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, logicalBaseRoutine());
      await writeFile(rightModulePath, logicalIncomingRoutine());

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:run';
      const changedRoutine = requireNode(result.projection.root, nodeId);

      assert.strictEqual(changedRoutine.mergeable, true);
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [nodeId]);

      const previewResult = await result.workspace.createPreviewForNodeIds([nodeId]);

      assert.strictEqual(previewResult.ok, true);
      assert.strictEqual(previewResult.preview.operationCount, 1);
      assert.deepStrictEqual(previewResult.preview.items, [
        {
          nodeId,
          label: 'Run',
          kind: 'bslRoutine',
          status: 'changed',
        },
      ]);
      assert.deepStrictEqual(previewResult.diagnostics, []);
      assert.strictEqual(JSON.stringify(previewResult.preview).includes(leftModulePath), false);
      assert.strictEqual(JSON.stringify(previewResult.preview).includes('expectedOldHash'), false);
      assert.strictEqual(JSON.stringify(previewResult.preview).includes('operations'), false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace executes built compare with file rootUri and random exclusive backup path', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const deterministicBackupPath = path.join(backupRoot, 'preview-1', 'operation-0.bak');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, logicalBaseRoutine());
      await writeFile(rightModulePath, logicalIncomingRoutine());
      await writeFile(deterministicBackupPath, 'do-not-overwrite');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:run';
      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, true);
      const approval = result.workspace.approvePreview(preview.preview.previewId);
      assert.strictEqual(approval.ok, true);

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), logicalIncomingRoutine());
      assert.strictEqual(await readText(deterministicBackupPath), 'do-not-overwrite');
      assert.strictEqual(execution.result.backupPaths.length, 1);
      const backupPath = execution.result.backupPaths[0]!;
      assert.notStrictEqual(backupPath, deterministicBackupPath);
      assert.strictEqual(
        path.dirname(backupPath),
        path.join(await fs.realpath(backupRoot), preview.preview.previewId)
      );
      assert.notStrictEqual(path.basename(backupPath), 'operation-0.bak');
      assert.strictEqual(await readText(backupPath), logicalBaseRoutine());
      assert.strictEqual(
        fileURLToPath(result.session.state.sources[0]!.rootUri),
        path.resolve(leftRoot)
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('single routine execution succeeds when module has another independent changed routine', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, `${logicalBaseRoutine()}\n\n${secondBaseRoutine()}`);
      await writeFile(rightModulePath, `${logicalIncomingRoutine()}\n\n${secondIncomingRoutine()}`);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [
        'bsl:routine:Catalog.Products.Object:other',
        'bsl:routine:Catalog.Products.Object:run',
      ]);

      const preview = await result.workspace.createPreviewForNodeIds([
        'bsl:routine:Catalog.Products.Object:run',
      ]);
      assert.strictEqual(preview.ok, true);
      result.workspace.approvePreview(preview.preview.previewId);

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(
        await readText(leftModulePath),
        `${logicalIncomingRoutine()}\n\n${secondBaseRoutine()}`
      );
      assert.strictEqual(
        await readText(rightModulePath),
        `${logicalIncomingRoutine()}\n\n${secondIncomingRoutine()}`
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('manual changed routine is visible but not advertised as executable', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, logicalBaseRoutine());
      await writeFile(rightModulePath, logicalManualRoutine());

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:run';
      const changedRoutine = requireNode(result.projection.root, nodeId);

      assert.strictEqual(changedRoutine.status, 'changed');
      assert.strictEqual(changedRoutine.mergeable, false);
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), []);
      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, false);
      assert.strictEqual(preview.diagnostics[0]?.code, 'CONFIG_COMPARE_UNKNOWN_SELECTION');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('projects mergeable XML adapter differences from configuration inventory', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Old goods');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'New goods');
      await writeFile(
        path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'Form.xml'),
        formXml('Old title')
      );
      await writeFile(
        path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'Form.xml'),
        formXml('New title')
      );
      await writeFile(
        path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'Predefined.xml'),
        predefinedXml('Old main')
      );
      await writeFile(
        path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'Predefined.xml'),
        predefinedXml('New main')
      );
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.txt'), 'old-logo');
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.txt'), 'new-logo');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      const synonym = requireNodeByLabel(
        result.projection.root,
        'Synonym',
        'Old goods',
        'New goods'
      );
      const title = requireNodeByLabel(result.projection.root, 'Title', 'Old title', 'New title');
      const presentation = requireNodeByLabel(
        result.projection.root,
        'Presentation',
        'Old main',
        'New main'
      );
      const logo = requireSingleNode(
        result.projection.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.txt'
      );

      assert.strictEqual(synonym.mergeable, true);
      assert.strictEqual(title.mergeable, true);
      assert.strictEqual(presentation.mergeable, true);
      assert.strictEqual(logo.mergeable, true);
      assert.ok(result.workspace.listMergeableNodeIds().includes(synonym.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(title.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(presentation.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(logo.id));

      const preview = await result.workspace.createPreviewForNodeIds([title.id]);
      const filePreview = await result.workspace.createPreviewForNodeIds([logo.id]);

      assert.strictEqual(preview.ok, true);
      assert.strictEqual(preview.preview.operationCount, 1);
      assert.deepStrictEqual(preview.preview.items, [
        {
          nodeId: title.id,
          label: 'Title',
          kind: 'xmlProperty',
          status: 'changed',
        },
      ]);
      assert.strictEqual(filePreview.ok, true);
      assert.strictEqual(filePreview.preview.operationCount, 1);
      assert.deepStrictEqual(filePreview.preview.items, [
        {
          nodeId: logo.id,
          label: 'logo.txt',
          kind: 'fileArtifact',
          status: 'changed',
        },
      ]);

      result.workspace.approvePreview(preview.preview.previewId);
      const xmlExecution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(xmlExecution.ok, true, JSON.stringify(xmlExecution));
      assert.strictEqual(
        await readText(path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'Form.xml')),
        formXml('New title')
      );

      const refreshedLogo = requireSingleNode(
        result.workspace.payload.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.txt'
      );
      const refreshedFilePreview = await result.workspace.createPreviewForNodeIds([
        refreshedLogo.id,
      ]);
      assert.strictEqual(refreshedFilePreview.ok, true);
      result.workspace.approvePreview(refreshedFilePreview.preview.previewId);
      const fileExecution = await result.workspace.executeApprovedPreview(
        refreshedFilePreview.preview.previewId
      );
      assert.strictEqual(fileExecution.ok, true, JSON.stringify(fileExecution));
      assert.strictEqual(
        await readText(path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.txt')),
        'new-logo'
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('shows actual XML property and BSL changes beneath the matched metadata owner', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-display-owner-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    let workspace: Awaited<ReturnType<typeof buildConfigurationCompare>>['workspace'] | undefined;

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Old goods');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'New goods');
      await writeFile(
        path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
        logicalBaseRoutine()
      );
      await writeFile(
        path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
        logicalIncomingRoutine()
      );

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      workspace = result.workspace;
      const payload = toWebviewPayload(
        result.workspace.payload,
        result.workspace.listMergeableNodeIds(),
        'Сравнение'
      );
      const displayNodes = collectDisplayNodes(payload.root);
      const catalogOwner = displayNodes.find((node) =>
        node.kind === 'metadataOwner' && node.qualifiedNames?.includes('Catalog.Products')
      );

      assert.ok(catalogOwner, 'the real metadata match should become a display owner');
      assert.strictEqual(catalogOwner.status, 'changed', 'descendant edits should aggregate into the owner status');
      assert.ok(
        collectDisplayNodes(catalogOwner).some((node) =>
          node.kind === 'xmlProperty' && node.status === 'changed'
        ),
        'the changed Synonym property should remain beneath the Catalog owner'
      );
      assert.ok(
        collectDisplayNodes(catalogOwner).some((node) =>
          node.kind === 'bslModule' &&
          node.key === 'bsl:module:Catalog.Products.Object' &&
          node.label === 'Модуль объекта'
        ),
        'the actual ObjectModule diff should remain beneath the Catalog owner with a distinct artifact label'
      );
      assert.ok(
        collectDisplayNodes(catalogOwner).some((node) =>
          node.kind === 'metadataXml' && node.label === 'Свойства'
        ),
        'the actual descriptor diff should remain beneath the Catalog owner with a distinct artifact label'
      );
      assert.ok(payload.executableNodeIds.includes('bsl:routine:Catalog.Products.Object:run'));
      assert.ok(!displayNodes.some((node) => node.label === 'Процедуры и функции'));
    } finally {
      workspace?.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('pairs multiple nested Form.xml artifacts by owner-relative path and executes each file once', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-multiple-forms-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const formPaths = ['Forms/Edit', 'Forms/ReadOnly'];

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');
      for (const relativeFormPath of formPaths) {
        await writeFile(
          path.join(leftRoot, 'Catalogs', 'Products', relativeFormPath, 'Ext', 'Form.xml'),
          formXml(`${relativeFormPath} left`)
        );
        await writeFile(
          path.join(rightRoot, 'Catalogs', 'Products', relativeFormPath, 'Ext', 'Form.xml'),
          formXml(`${relativeFormPath} right`)
        );
      }

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
      });
      const formTitles = collectNodes(
        result.projection.root,
        (node) => node.kind === 'xmlProperty' && node.label === 'Title'
      );

      assert.strictEqual(formTitles.length, 2);
      assert.strictEqual(new Set(formTitles.map((node) => node.id)).size, 2);
      assert.deepStrictEqual(
        formTitles.map((node) => path.relative(leftRoot, node.mergeState?.targetFilePath ?? '')).sort(),
        formPaths.map((relativeFormPath) =>
          path.join('Catalogs', 'Products', relativeFormPath, 'Ext', 'Form.xml')
        ).sort()
      );

      const preview = await result.workspace.createPreviewForNodeIds(formTitles.map((node) => node.id));
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 2);
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      for (const relativeFormPath of formPaths) {
        assert.strictEqual(
          await readText(path.join(leftRoot, 'Catalogs', 'Products', relativeFormPath, 'Ext', 'Form.xml')),
          formXml(`${relativeFormPath} right`)
        );
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('merges scalar descriptor properties across a same-name UUID conflict while preserving target identity', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const targetUuid = '11111111-1111-4111-8111-111111111111';
    const incomingUuid = '22222222-2222-4222-8222-222222222222';

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', targetUuid, 'Old goods');
      await writeCatalogDescriptor(rightRoot, 'Products', incomingUuid, 'New goods');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const defaultConflict = requireSingleNode(
        result.projection.root,
        (node) =>
          node.kind === 'metadataConflict' &&
          node.label === 'Catalog.Products' &&
          node.conflict?.kind === 'sameNameDifferentUuid'
      );
      const defaultSynonym = requireNodeByLabel(result.projection.root, 'Synonym', 'Old goods', 'New goods');
      assert.strictEqual(defaultConflict.mergeable, false);
      assert.strictEqual(defaultSynonym.mergeable, true, 'a scalar property can merge without changing the target UUID');
      assert.ok(result.workspace.listMergeableNodeIds().includes(defaultSynonym.id));

      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));

      const identityConflict = requireSingleNode(
        result.workspace.payload.root,
        (node) =>
          node.kind === 'metadataConflict' &&
          node.label === 'Catalog.Products' &&
          node.conflict?.kind === 'sameNameDifferentUuid'
      );
      const synonym = requireNodeByLabel(result.workspace.payload.root, 'Synonym', 'Old goods', 'New goods');
      assert.strictEqual(identityConflict.mergeable, false);
      assert.strictEqual(synonym.mergeable, true, 'full strategy may merge scalar properties under the visible identity conflict');
      assert.ok(result.workspace.listMergeableNodeIds().includes(synonym.id));
      const preview = await result.workspace.createPreviewForNodeIds([synonym.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      const targetDescriptor = await readText(path.join(leftRoot, 'Catalogs', 'Products', 'Products.xml'));
      assert.match(targetDescriptor, new RegExp(`<Catalog uuid="${targetUuid}">`, 'u'));
      assert.match(targetDescriptor, /<Synonym>New goods<\/Synonym>/u);
      assert.doesNotMatch(targetDescriptor, new RegExp(incomingUuid, 'u'));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('projects merge nodes for representative non-catalog metadata types', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');

    try {
      for (const fixture of representativeMetadataFixtures()) {
        await writeMetadataDescriptor(
          leftRoot,
          fixture.relativePath,
          fixture.metadataType,
          fixture.name,
          fixture.uuid,
          'Old'
        );
        await writeMetadataDescriptor(
          rightRoot,
          fixture.relativePath,
          fixture.metadataType,
          fixture.name,
          fixture.uuid,
          'New'
        );
      }
      await writeFile(
        path.join(leftRoot, 'CommonForms', 'Chooser', 'Ext', 'Form.xml'),
        formXml('Old common form title')
      );
      await writeFile(
        path.join(rightRoot, 'CommonForms', 'Chooser', 'Ext', 'Form.xml'),
        formXml('New common form title')
      );
      await writeFile(
        path.join(leftRoot, 'ChartsOfCharacteristicTypes', 'Properties', 'Ext', 'Predefined.xml'),
        predefinedXml('Old predefined')
      );
      await writeFile(
        path.join(rightRoot, 'ChartsOfCharacteristicTypes', 'Properties', 'Ext', 'Predefined.xml'),
        predefinedXml('New predefined')
      );

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      const expectedDescriptorNodes = [
        'Document.Order',
        'Enum.Status',
        'Role.Admin',
        'InformationRegister.Stock.Dimension.Warehouse',
        'Document.Order.TabularSection.Goods',
      ];
      for (const qualifiedName of expectedDescriptorNodes) {
        const synonym = requireNodeByLabel(
          result.projection.root,
          'Synonym',
          `${qualifiedName} Old`,
          `${qualifiedName} New`
        );
        assert.strictEqual(synonym.mergeable, true, qualifiedName);
      }

      const commonFormTitle = requireNodeByLabel(
        result.projection.root,
        'Title',
        'Old common form title',
        'New common form title'
      );
      const predefinedPresentation = requireNodeByLabel(
        result.projection.root,
        'Presentation',
        'Old predefined',
        'New predefined'
      );

      assert.strictEqual(commonFormTitle.mergeable, true);
      assert.strictEqual(predefinedPresentation.mergeable, true);
      assert.ok(result.workspace.listMergeableNodeIds().includes(commonFormTitle.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(predefinedPresentation.id));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace executes right-only binary artifact copy preserving bytes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftLogoPath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightLogoPath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightBytes = Buffer.from([0x00, 0xff, 0x41, 0x80, 0x0a]);

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');
      await writeFileBytes(rightLogoPath, rightBytes);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const logo = requireSingleNode(
        result.workspace.payload.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.bin'
      );

      const preview = await result.workspace.createPreviewForNodeIds([logo.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.deepStrictEqual(await fs.readFile(leftLogoPath), rightBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace executes left-only binary artifact delete backing up bytes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftLogoPath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const leftBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xfe]);

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');
      await writeFileBytes(leftLogoPath, leftBytes);
      await fs.rm(path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin'), {
        force: true,
      });

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const logo = requireSingleNode(
        result.workspace.payload.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.bin'
      );

      const preview = await result.workspace.createPreviewForNodeIds([logo.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      await assert.rejects(fs.stat(leftLogoPath));
      assert.strictEqual(execution.result.backupPaths.length, 1);
      assert.deepStrictEqual(await fs.readFile(execution.result.backupPaths[0]!), leftBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace executes right-only object folder copy with missing-target guard', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftCatalogPath = path.join(leftRoot, 'Catalogs', 'Products');
    const rightLogoPath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    try {
      await fs.mkdir(leftRoot, { recursive: true });
      await writeFileBytes(rightLogoPath, rightBytes);
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const products = requireSingleNode(
        result.projection.root,
        (node) =>
          node.kind === 'metadataObject' &&
          node.label === 'Catalog.Products' &&
          node.id.startsWith('fileObject:rightOnly:') &&
          node.status === 'rightOnly'
      );

      const preview = await result.workspace.createPreviewForNodeIds([products.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.deepStrictEqual(
        await fs.readFile(path.join(leftCatalogPath, 'Ext', 'logo.bin')),
        rightBytes
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('full strategy keeps unmatched object copy selectable without indexing its internals', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const rightLogoPath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await fs.mkdir(leftRoot, { recursive: true });
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');
      await writeFileBytes(rightLogoPath, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      await writeFile(rightModulePath, 'Procedure RightOnly()\nEndProcedure');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const productsNodes = collectNodes(
        result.workspace.payload.root,
        (node) =>
          node.kind === 'metadataObject' &&
          node.label === 'Catalog.Products' &&
          node.status === 'rightOnly'
      );
      const rightOnlyBslDiagnostics = collectNodes(
        result.workspace.payload.root,
        (node) => node.kind === 'diagnostic' && node.label === 'BSL_MODULE_RIGHT_ONLY'
      );

      assert.strictEqual(productsNodes.length, 1);
      assert.strictEqual(productsNodes[0]!.mergeable, true);
      assert.strictEqual(productsNodes[0]!.mergeState?.state, 'ready');
      assert.strictEqual(rightOnlyBslDiagnostics.length, 0);
      assert.ok(result.workspace.listMergeableNodeIds().includes(productsNodes[0]!.id));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('workspace executes left-only object folder delete with directory hash guard', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftCatalogPath = path.join(leftRoot, 'Catalogs', 'Products');
    const leftBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

    try {
      await writeFileBytes(path.join(leftCatalogPath, 'Ext', 'logo.bin'), leftBytes);
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await fs.mkdir(rightRoot, { recursive: true });

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const products = requireSingleNode(
        result.workspace.payload.root,
        (node) =>
          node.kind === 'metadataObject' &&
          node.label === 'Catalog.Products' &&
          node.id.startsWith('fileObject:leftOnly:') &&
          node.status === 'leftOnly'
      );

      const preview = await result.workspace.createPreviewForNodeIds([products.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      await assert.rejects(fs.stat(leftCatalogPath));
      assert.strictEqual(execution.result.backupPaths.length, 1);
      assert.deepStrictEqual(
        await fs.readFile(path.join(execution.result.backupPaths[0]!, 'Ext', 'logo.bin')),
        leftBytes
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('preview new hash is based on current target when unrelated text changed after compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const currentLeft = `// local header after compare\n${logicalBaseRoutine()}`;

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, `// original header\n${logicalBaseRoutine()}`);
      await writeFile(rightModulePath, `// original header\n${logicalIncomingRoutine()}`);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      await writeFile(leftModulePath, currentLeft);

      const preview = await result.workspace.createPreviewForNodeIds([
        'bsl:routine:Catalog.Products.Object:run',
      ]);
      assert.strictEqual(preview.ok, true);
      result.workspace.approvePreview(preview.preview.previewId);

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(
        await readText(leftModulePath),
        `// local header after compare\n${logicalIncomingRoutine()}`
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

async function buildConfigurationCompare(input: ConfigurationCompareInput) {
  if (input.cancellation?.isCancellationRequested || input.mutationEngine) {
    return buildConfigurationCompareWithoutMutationRuntime(input);
  }

  try {
    await fs.realpath(input.leftRootPath);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return buildConfigurationCompareWithoutMutationRuntime(input);
    }
    throw error;
  }

  const runtime = await createMergeMutationTestRuntime(input.leftRootPath);
  mutationCoordinators.push(runtime.coordinator);
  return buildConfigurationCompareWithoutMutationRuntime({
    ...input,
    mutationEngine: runtime.engine,
    configurationId: input.configurationId ?? runtime.configurationId,
  });
}

async function writeCatalog(root: string, name: string, uuid: string): Promise<void> {
  await writeFile(
    path.join(root, 'Catalogs', `${name}.xml`),
    `<MetaDataObject><Catalog uuid="${uuid}"><Properties><Name>${name}</Name></Properties></Catalog></MetaDataObject>`
  );
}

async function writeCatalogDescriptor(
  root: string,
  name: string,
  uuid: string,
  synonym: string
): Promise<void> {
  await writeFile(
    path.join(root, 'Catalogs', name, `${name}.xml`),
    [
      '<MetaDataObject>',
      `  <Catalog uuid="${uuid}">`,
      '    <Properties>',
      `      <Name>${name}</Name>`,
      `      <Synonym>${synonym}</Synonym>`,
      '    </Properties>',
      '  </Catalog>',
      '</MetaDataObject>',
    ].join('\n')
  );
}

async function writeMetadataDescriptor(
  root: string,
  relativePath: string,
  metadataType: string,
  name: string,
  uuid: string,
  synonymSuffix: string
): Promise<void> {
  const qualifiedName = qualifiedNameForFixture(relativePath);
  await writeFile(
    path.join(root, relativePath),
    [
      '<MetaDataObject>',
      `  <${metadataType} uuid="${uuid}">`,
      '    <Properties>',
      `      <Name>${name}</Name>`,
      `      <Synonym>${qualifiedName} ${synonymSuffix}</Synonym>`,
      '    </Properties>',
      `  </${metadataType}>`,
      '</MetaDataObject>',
    ].join('\n')
  );
}

function representativeMetadataFixtures(): Array<{
  relativePath: string;
  metadataType: string;
  name: string;
  uuid: string;
}> {
  return [
    {
      relativePath: path.join('Documents', 'Order', 'Order.xml'),
      metadataType: 'Document',
      name: 'Order',
      uuid: 'document-order',
    },
    {
      relativePath: path.join('Enums', 'Status', 'Status.xml'),
      metadataType: 'Enum',
      name: 'Status',
      uuid: 'enum-status',
    },
    {
      relativePath: path.join('Roles', 'Admin', 'Admin.xml'),
      metadataType: 'Role',
      name: 'Admin',
      uuid: 'role-admin',
    },
    {
      relativePath: path.join('CommonForms', 'Chooser', 'Chooser.xml'),
      metadataType: 'CommonForm',
      name: 'Chooser',
      uuid: 'common-form-chooser',
    },
    {
      relativePath: path.join('InformationRegisters', 'Stock', 'Dimensions', 'Warehouse.xml'),
      metadataType: 'Dimension',
      name: 'Warehouse',
      uuid: 'dimension-warehouse',
    },
    {
      relativePath: path.join('Documents', 'Order', 'TabularSections', 'Goods.xml'),
      metadataType: 'TabularSection',
      name: 'Goods',
      uuid: 'tabular-section-goods',
    },
    {
      relativePath: path.join('ChartsOfCharacteristicTypes', 'Properties', 'Properties.xml'),
      metadataType: 'ChartOfCharacteristicTypes',
      name: 'Properties',
      uuid: 'cct-properties',
    },
  ];
}

function qualifiedNameForFixture(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === 'Documents/Order/Order.xml') {
    return 'Document.Order';
  }
  if (normalized === 'Enums/Status/Status.xml') {
    return 'Enum.Status';
  }
  if (normalized === 'Roles/Admin/Admin.xml') {
    return 'Role.Admin';
  }
  if (normalized === 'CommonForms/Chooser/Chooser.xml') {
    return 'CommonForm.Chooser';
  }
  if (normalized === 'InformationRegisters/Stock/Dimensions/Warehouse.xml') {
    return 'InformationRegister.Stock.Dimension.Warehouse';
  }
  if (normalized === 'Documents/Order/TabularSections/Goods.xml') {
    return 'Document.Order.TabularSection.Goods';
  }
  if (normalized === 'ChartsOfCharacteristicTypes/Properties/Properties.xml') {
    return 'ChartOfCharacteristicTypes.Properties';
  }
  throw new Error(`Unknown fixture path ${relativePath}`);
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeFileBytes(filePath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function requireNode(root: CompareTreeNode, id: string): CompareTreeNode {
  const found = findNode(root, id);
  assert.ok(found, `Expected node ${id} to exist.`);
  return found;
}

function findNode(node: CompareTreeNode, id: string): CompareTreeNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collectNodes(
  root: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode[] {
  const found: CompareTreeNode[] = [];
  visit(root, (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });
  return found;
}

function assertPartialMetadataProjection(
  projection: NonNullable<CompareBuildProgress['projection']>
): void {
  const nodes = collectNodes(projection.root, () => true);
  assert.strictEqual(projection.stats.mergeable, 0);
  assert.ok(nodes.every((node) => node.mergeable !== true));
  assert.strictEqual(
    nodes.filter((node) => node.kind === 'metadataMatch').length,
    0,
    'equal or matched metadata rows must wait for the complete inventory-backed projection'
  );
}

function collectDisplayNodes(root: CompareDisplayNode): CompareDisplayNode[] {
  return [root, ...root.children.flatMap((child) => collectDisplayNodes(child))];
}

function requireNodeByLabel(
  root: CompareTreeNode,
  label: string,
  leftValue: string,
  rightValue: string
): CompareTreeNode {
  const matches = collectNodes(
    root,
    (node) => node.label === label && node.leftValue === leftValue && node.rightValue === rightValue
  );
  assert.strictEqual(
    matches.length,
    1,
    `Expected exactly one node ${label} with ${leftValue} -> ${rightValue}.`
  );
  return matches[0]!;
}

function requireSingleNode(
  root: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode {
  const matches = collectNodes(root, predicate);
  assert.strictEqual(matches.length, 1, 'Expected exactly one matching compare node.');
  return matches[0]!;
}

function visit(node: CompareTreeNode, callback: (node: CompareTreeNode) => void): void {
  callback(node);
  for (const child of node.children) {
    visit(child, callback);
  }
}

function duplicateRoutineSource(): string {
  return ['Procedure Save()', 'EndProcedure', '', 'Procedure Save()', 'EndProcedure'].join('\n');
}

function logicalBaseRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function logicalIncomingRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  Try',
    '    C = 1;',
    '  Except',
    '    C = 0;',
    '  EndTry;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function logicalManualRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 2;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function secondBaseRoutine(): string {
  return [
    'Procedure Other()',
    '  If X Then',
    '    X = 1;',
    '  EndIf;',
    '  If Y Then',
    '    Y = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function secondIncomingRoutine(): string {
  return [
    'Procedure Other()',
    '  If X Then',
    '    X = 1;',
    '  EndIf;',
    '  Try',
    '    Z = 1;',
    '  Except',
    '    Z = 0;',
    '  EndTry;',
    '  If Y Then',
    '    Y = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function formXml(title: string): string {
  return [
    '<Form>',
    '  <ChildItems>',
    '    <Item>',
    '      <Name>ItemsTable</Name>',
    `      <Title>${title}</Title>`,
    '    </Item>',
    '  </ChildItems>',
    '</Form>',
  ].join('\n');
}

function predefinedXml(presentation: string): string {
  return [
    '<PredefinedData>',
    '  <Item id="main">',
    '    <Name>Main</Name>',
    `    <Presentation>${presentation}</Presentation>`,
    '  </Item>',
    '</PredefinedData>',
  ].join('\n');
}
