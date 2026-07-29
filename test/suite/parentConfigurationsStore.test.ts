import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { ParentConfigurationsCodec } from '../../src/support/parentConfigurationsCodec';
import {
  ParentConfigurationsStore,
  type ParentConfigurationsStoreDeps,
} from '../../src/support/parentConfigurationsStore';
import { MetadataUniverseResolver } from '../../src/support/metadataUniverseResolver';
import { SupportMutationError } from '../../src/support/supportTypes';
import {
  SUPPORT_TEST_CONFIGURATION_ID,
  SUPPORT_UUIDS,
  buildParentConfigurations,
  parseReadyDocument,
  sha256,
  syntheticSupplier,
  writeSyntheticMaster,
} from './supportTestFixtures';

const TRUSTED_GLOBAL_STORAGE_ROOT = path.join(
  os.tmpdir(),
  `cdt-support-global-storage-${process.pid}`,
);

suite('ParentConfigurationsStore', () => {
  const roots: string[] = [];

  teardown(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })));
    await fs.rm(TRUSTED_GLOBAL_STORAGE_ROOT, { recursive: true, force: true });
  });

  test('represents missing and empty containers as unmanaged without inventing generation', async () => {
    const missingRoot = await tempRoot(roots);
    const emptyRoot = await tempRoot(roots);
    await writeSyntheticMaster(emptyRoot, Buffer.alloc(0));
    const store = storeFor(missingRoot);

    const missing = await store.read(missingRoot);
    const empty = await store.read(emptyRoot);

    assert.deepStrictEqual(missing, {
      kind: 'unmanaged',
      reason: 'missing',
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      expectedFilePath: path.join(missingRoot, 'Ext', 'ParentConfigurations.bin'),
    });
    assert.deepStrictEqual(empty, {
      kind: 'unmanaged',
      reason: 'empty',
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      expectedFilePath: path.join(emptyRoot, 'Ext', 'ParentConfigurations.bin'),
    });
  });

  test('publishes unknown after three unstable reads instead of using an unproven generation', async () => {
    const root = await tempRoot(roots);
    const bytes = buildParentConfigurations();
    let statCall = 0;
    let readCall = 0;
    const store = storeFor(root, {
      stat: async () => ({
        size: bytes.length,
        mtimeMs: statCall += 1,
      }),
      readFile: async () => {
        readCall += 1;
        return bytes;
      },
    });

    const state = await store.read(root);

    assert.strictEqual(readCall, 3);
    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_FILE_INVALID');
      assert.strictEqual(state.generationId, undefined);
      assert.match(state.diagnostics.join(' '), /changed during stable read/);
    }
  });

  test('successful commit uses public lease, writes exact planned bytes and removes durable journal', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const leases: Array<{ resourcePath: string; kind: string }> = [];
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (resourcePath, kind, operation) => {
        leases.push({ resourcePath, kind });
        return operation();
      },
    });

    const result = await store.commit(plan, plan.before.generationId);

    assert.deepStrictEqual(leases, [{
      resourcePath: filePath,
      kind: 'support.commitParentConfigurations',
    }]);
    assert.strictEqual(result.before.generationId, plan.before.generationId);
    assert.strictEqual(result.after.generationId, plan.after.generationId);
    assert.strictEqual(result.changedTokenCount, plan.patches.length);
    assert.deepStrictEqual(await fs.readFile(filePath), Buffer.from(plan.afterDocument.bytes));
    await assert.rejects(
      fs.access(path.join(root, '.cdt-support-recovery')),
      isEnoent,
    );
  });

  test('within-lease commit never reacquires the public configuration gateway', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    await writeSyntheticMaster(root, beforeBytes);
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    let leaseCalls = 0;
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => {
        leaseCalls += 1;
        return operation();
      },
    });

    await store.commitWithinExclusiveLease(plan, plan.before.generationId);

    assert.strictEqual(leaseCalls, 0);
  });

  test('master CAS rejects an external third generation before journaling and never clobbers it', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const thirdGeneration = buildParentConfigurations({
      suppliers: [syntheticSupplier({
        objects: [{
          mode: '2',
          localUuid: SUPPORT_UUIDS.objectA,
          vendorUuid: SUPPORT_UUIDS.vendorA,
        }],
      })],
    });
    await fs.writeFile(filePath, thirdGeneration);
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
    });

    await assert.rejects(
      store.commitWithinExclusiveLease(plan, plan.before.generationId),
      hasMutationCode('SUPPORT_STALE_GENERATION'),
    );

    assert.deepStrictEqual(await fs.readFile(filePath), thirdGeneration);
    await assert.rejects(
      fs.access(path.join(root, '.cdt-support-recovery')),
      isEnoent,
    );
  });

  test('rejects a plan for another target path before journaling or changing the master', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const wrongTargetPlan = {
      ...plan,
      before: {
        ...plan.before,
        filePath: path.join(root, 'Ext', 'OtherParentConfigurations.bin'),
      },
    };
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
    });

    await assert.rejects(
      store.commitWithinExclusiveLease(wrongTargetPlan, plan.before.generationId),
      hasMutationCode('SUPPORT_STALE_GENERATION'),
    );

    assert.deepStrictEqual(await fs.readFile(filePath), beforeBytes);
    await assert.rejects(
      fs.access(path.join(root, '.cdt-support-recovery')),
      isEnoent,
    );
  });

  test('metadata-universe CAS rejects stale generation before writing master', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    const basePlan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const staleUniversePlan = {
      ...basePlan,
      expectedMetadataUniverseGenerationId: '0'.repeat(64),
    };
    const resolver = new MetadataUniverseResolver({
      loadTree: async (configRoot) => universeTree(configRoot, SUPPORT_UUIDS.objectA),
    });
    const store = storeFor(root, {
      universeResolver: resolver,
      syncDirectory: async () => undefined,
    });

    await assert.rejects(
      store.commitWithinExclusiveLease(staleUniversePlan, basePlan.before.generationId),
      hasMutationCode('SUPPORT_METADATA_UNIVERSE_STALE'),
    );

    assert.deepStrictEqual(await fs.readFile(filePath), beforeBytes);
  });

  test('post-write universe drift conditionally restores exact backup and cleans journal', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    const basePlan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const treeBefore = universeTree(root, SUPPORT_UUIDS.objectA);
    const expectedUniverse = await new MetadataUniverseResolver({
      loadTree: async () => treeBefore,
    }).resolve(root);
    let resolveCall = 0;
    const driftingResolver = new MetadataUniverseResolver({
      loadTree: async (configRoot) => {
        resolveCall += 1;
        return resolveCall === 1
          ? universeTree(configRoot, SUPPORT_UUIDS.objectA)
          : universeTree(configRoot, SUPPORT_UUIDS.objectB);
      },
    });
    const plan = {
      ...basePlan,
      expectedMetadataUniverseGenerationId: expectedUniverse.metadataUniverseGenerationId,
    };
    const store = storeFor(root, {
      universeResolver: driftingResolver,
      syncDirectory: async () => undefined,
    });

    await assert.rejects(
      store.commitWithinExclusiveLease(plan, plan.before.generationId),
      hasMutationCode('SUPPORT_METADATA_UNIVERSE_STALE'),
    );

    assert.deepStrictEqual(await fs.readFile(filePath), beforeBytes);
    await assert.rejects(
      fs.access(path.join(root, '.cdt-support-recovery')),
      isEnoent,
    );
  });

  test('public read acquires recovery lease and restores planned-after generation from exact backup', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const filePath = await writeSyntheticMaster(root, plan.afterDocument.bytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    const leases: string[] = [];
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, kind, operation) => {
        leases.push(kind);
        return operation();
      },
    });

    const state = await store.read(root);

    assert.deepStrictEqual(leases, ['support.recoverParentConfigurations']);
    assert.strictEqual(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.strictEqual(state.snapshot.generationId, sha256(beforeBytes));
    }
    assert.deepStrictEqual(await fs.readFile(filePath), beforeBytes);
    await assert.rejects(
      fs.access(path.join(root, '.cdt-support-recovery')),
      isEnoent,
    );
  });

  test('recovery proves an interrupted pre-write generation and only removes its artifacts', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.strictEqual(state.snapshot.generationId, sha256(beforeBytes));
    }
    assert.deepStrictEqual(await fs.readFile(filePath), beforeBytes);
    await assert.rejects(
      fs.access(path.join(root, '.cdt-support-recovery')),
      isEnoent,
    );
  });

  test('cleans an orphan backup only when the live master is independently valid', async () => {
    const validRoot = await tempRoot(roots);
    const invalidRoot = await tempRoot(roots);
    const bytes = buildParentConfigurations();
    await writeSyntheticMaster(validRoot, bytes);
    await writeSyntheticMaster(invalidRoot, Buffer.from('{broken}', 'utf8'));
    for (const root of [validRoot, invalidRoot]) {
      const livePath = recoveryLivePath(root);
      await fs.mkdir(livePath, { recursive: true });
      await fs.writeFile(path.join(livePath, 'ParentConfigurations.bin.backup'), bytes);
    }
    const validStore = storeFor(validRoot, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });
    const invalidStore = storeFor(invalidRoot, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const valid = await validStore.read(validRoot);
    const invalid = await invalidStore.read(invalidRoot);

    assert.strictEqual(valid.kind, 'ready');
    await assert.rejects(
      fs.access(path.join(validRoot, '.cdt-support-recovery')),
      isEnoent,
    );
    assert.strictEqual(invalid.kind, 'unknown');
    if (invalid.kind === 'unknown') {
      assert.strictEqual(invalid.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.match(invalid.diagnostics.join(' '), /Orphan recovery backup/);
    }
    await fs.access(path.join(recoveryLivePath(invalidRoot), 'ParentConfigurations.bin.backup'));
  });

  test('within-lease recovery path does not reacquire gateway', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, plan.afterDocument.bytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    let leaseCalls = 0;
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => {
        leaseCalls += 1;
        return operation();
      },
    });

    const document = await store.readParsedWithinExclusiveLease(root);

    assert.strictEqual(leaseCalls, 0);
    assert.strictEqual(document.state.kind, 'ready');
    assert.deepStrictEqual(
      await fs.readFile(path.join(root, 'Ext', 'ParentConfigurations.bin')),
      beforeBytes,
    );
  });

  test('recovery refuses to overwrite a third live generation and publishes fail-closed unknown', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const thirdBytes = buildParentConfigurations({
      suppliers: [syntheticSupplier({
        objects: [{
          mode: '2',
          localUuid: SUPPORT_UUIDS.objectA,
          vendorUuid: SUPPORT_UUIDS.vendorA,
        }],
      })],
    });
    const filePath = await writeSyntheticMaster(root, thirdBytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.strictEqual(state.generationId, sha256(thirdBytes));
      assert.match(state.diagnostics.join(' '), /third generation/);
    }
    assert.deepStrictEqual(await fs.readFile(filePath), thirdBytes);
    await fs.access(path.join(recoveryLivePath(root), 'journal.json'));
    await fs.access(path.join(recoveryLivePath(root), 'ParentConfigurations.bin.backup'));
  });

  test('invalid/incomplete recovery journal fails closed and preserves evidence', async () => {
    const root = await tempRoot(roots);
    const bytes = buildParentConfigurations();
    await writeSyntheticMaster(root, bytes);
    const livePath = recoveryLivePath(root);
    await fs.mkdir(livePath, { recursive: true });
    await fs.writeFile(path.join(livePath, 'journal.json'), '{"version":1}', 'utf8');
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.match(state.diagnostics.join(' '), /without its exact backup/);
    }
    await fs.access(path.join(livePath, 'journal.json'));
  });

  test('looks up stable generations before parse and isolates identical bytes by physical root', async () => {
    const firstRoot = await tempRoot(roots);
    const secondRoot = await tempRoot(roots);
    const bytes = buildParentConfigurations();
    await writeSyntheticMaster(firstRoot, bytes);
    await writeSyntheticMaster(secondRoot, bytes);
    const store = storeFor(firstRoot);
    const originalParse = ParentConfigurationsCodec.parse;
    let parseCalls = 0;
    ParentConfigurationsCodec.parse = (...args: Parameters<typeof originalParse>) => {
      parseCalls += 1;
      return originalParse(...args);
    };

    try {
      const first = await store.readParsed(firstRoot);
      const firstAgain = await store.readParsed(firstRoot);
      assert.strictEqual(firstAgain, first);
      assert.strictEqual(parseCalls, 1, 'cached generation must be returned before invoking the codec');

      const second = await store.readParsed(secondRoot);
      const secondAgain = await store.readParsed(secondRoot);
      assert.strictEqual(secondAgain, second);
      assert.notStrictEqual(second, first, 'equal generations from different roots must not share documents');
      assert.strictEqual(parseCalls, 2);
      assert.notStrictEqual(second.context.filePath, first.context.filePath);
    } finally {
      ParentConfigurationsCodec.parse = originalParse;
    }
  });

  test('invalidates the root cache throughout commit and republishes only the committed generation', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    await writeSyntheticMaster(root, beforeBytes);
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
    });
    const originalParse = ParentConfigurationsCodec.parse;
    let parseCalls = 0;
    ParentConfigurationsCodec.parse = (...args: Parameters<typeof originalParse>) => {
      parseCalls += 1;
      return originalParse(...args);
    };

    try {
      await store.readParsed(root);
      assert.strictEqual(parseCalls, 1);

      await store.commitWithinExclusiveLease(plan, plan.before.generationId);
      assert.strictEqual(
        parseCalls,
        3,
        'commit must freshly parse the live before-generation and written after-generation',
      );

      const committed = await store.readParsed(root);
      assert.strictEqual(committed.state.kind, 'ready');
      if (committed.state.kind === 'ready') {
        assert.strictEqual(committed.state.snapshot.generationId, plan.after.generationId);
      }
      assert.strictEqual(parseCalls, 3, 'validated committed generation should be republished to the cache');
    } finally {
      ParentConfigurationsCodec.parse = originalParse;
    }
  });

  test('invalidates cached documents when recovery restores an earlier generation', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, beforeBytes);
    const store = storeFor(root, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });
    const cachedBefore = await store.readParsed(root);
    await writeSyntheticMaster(root, plan.afterDocument.bytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);

    const recovered = await store.readParsed(root);
    const recoveredAgain = await store.readParsed(root);

    assert.notStrictEqual(recovered, cachedBefore);
    assert.strictEqual(recoveredAgain, recovered);
    assert.strictEqual(recovered.state.kind, 'ready');
    if (recovered.state.kind === 'ready') {
      assert.strictEqual(recovered.state.snapshot.generationId, plan.before.generationId);
    }
  });

  test('uses deterministic globally-owned recovery locations isolated by configuration and root', async () => {
    const firstRoot = await tempRoot(roots);
    const secondRoot = await tempRoot(roots);
    const firstRecoveryRoot = recoveryRootFor(firstRoot);

    assert.strictEqual(recoveryRootFor(firstRoot), firstRecoveryRoot);
    assert.notStrictEqual(recoveryRootFor(secondRoot), firstRecoveryRoot);
    assert.notStrictEqual(
      recoveryRootFor(firstRoot, 'other-configuration' as typeof SUPPORT_TEST_CONFIGURATION_ID),
      firstRecoveryRoot,
    );
    assert.ok(isPathInside(TRUSTED_GLOBAL_STORAGE_ROOT, firstRecoveryRoot));
    assert.ok(!isPathInside(firstRoot, firstRecoveryRoot));

    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(firstRoot, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(firstRoot, plan.afterDocument.bytes);
    await writeRecoveryArtifacts(firstRoot, beforeBytes, plan.afterDocument.bytes);
    await fs.writeFile(path.join(recoveryLivePath(firstRoot), 'foreign.txt'), 'preserve', 'utf8');

    const state = await storeFor(firstRoot, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    }).read(firstRoot);

    assert.strictEqual(state.kind, 'unknown');
    await fs.access(path.join(recoveryLivePath(firstRoot), 'journal.json'));
    await assert.rejects(fs.access(path.join(firstRoot, '.cdt-support-recovery')), isEnoent);
  });

  test('rejects foreign live entries before rename or delete and preserves complete evidence', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, beforeBytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    const foreignPath = path.join(recoveryLivePath(root), 'foreign-evidence.txt');
    await fs.writeFile(foreignPath, 'preserve', 'utf8');
    const store = storeFor(root, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.match(state.diagnostics.join(' '), /foreign entry/i);
    }
    assert.strictEqual(await fs.readFile(foreignPath, 'utf8'), 'preserve');
    await fs.access(path.join(recoveryLivePath(root), 'journal.json'));
    await fs.access(path.join(recoveryLivePath(root), 'ParentConfigurations.bin.backup'));
    await assert.rejects(fs.access(recoveryTombstonePath(root)), isEnoent);
  });

  test('recognizes a tombstone on restart and completes cleanup without touching the master', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    await writeRecoveryArtifactsAt(
      recoveryTombstonePath(root),
      beforeBytes,
      plan.afterDocument.bytes,
    );
    const store = storeFor(root, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'ready');
    assert.deepStrictEqual(await fs.readFile(filePath), beforeBytes);
    await assert.rejects(fs.access(recoveryTombstonePath(root)), isEnoent);
  });

  test('atomic live-to-tombstone cleanup remains fail-closed after recursive delete failure', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, beforeBytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    const tombstonePath = recoveryTombstonePath(root);
    const mutableFs = require('fs/promises') as {
      rm(filePath: string, options: { recursive: true; force?: boolean }): Promise<void>;
    };
    const originalRm = mutableFs.rm;
    let injectedFailures = 0;
    mutableFs.rm = async (filePath, options) => {
      if (path.resolve(filePath) === path.resolve(tombstonePath)) {
        injectedFailures += 1;
        throw new Error('injected recursive delete failure');
      }
      return originalRm(filePath, options);
    };
    let firstState: Awaited<ReturnType<ParentConfigurationsStore['read']>> | undefined;
    try {
      firstState = await storeFor(root, {
        runExclusive: async (_resourcePath, _kind, operation) => operation(),
      }).read(root);
    } finally {
      mutableFs.rm = originalRm;
    }

    assert.strictEqual(injectedFailures, 1);
    assert.ok(firstState);
    if (!firstState) {
      throw new Error('Expected fail-closed recovery state.');
    }
    assert.strictEqual(firstState.kind, 'unknown');
    await assert.rejects(fs.access(recoveryLivePath(root)), isEnoent);
    await fs.access(path.join(tombstonePath, 'journal.json'));
    await fs.access(path.join(tombstonePath, 'ParentConfigurations.bin.backup'));

    const restarted = await storeFor(root, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    }).read(root);

    assert.strictEqual(restarted.kind, 'ready');
    await assert.rejects(fs.access(tombstonePath), isEnoent);
  });

  test('rejects a recovery-directory junction and preserves all outside evidence', async function () {
    const root = await tempRoot(roots);
    const outside = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, plan.afterDocument.bytes);
    await writeRecoveryArtifactsAt(
      path.join(outside, 'live'),
      beforeBytes,
      plan.afterDocument.bytes,
    );
    const sentinel = path.join(outside, 'outside-sentinel.txt');
    await fs.writeFile(sentinel, 'preserve', 'utf8');
    await fs.mkdir(path.dirname(recoveryRootFor(root)), { recursive: true });
    try {
      await fs.symlink(
        outside,
        recoveryRootFor(root),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (isLinkPrivilegeError(error)) {
        this.skip();
        return;
      }
      throw error;
    }
    const store = storeFor(root, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.match(state.diagnostics.join(' '), /Unsafe support recovery path|link or reparse/i);
    }
    assert.strictEqual(await fs.readFile(sentinel, 'utf8'), 'preserve');
    await fs.access(path.join(outside, 'live', 'journal.json'));
    await fs.access(path.join(outside, 'live', 'ParentConfigurations.bin.backup'));
  });

  test('rejects a linked recovery backup without following or deleting its outside target', async () => {
    const root = await tempRoot(roots);
    const outside = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, plan.afterDocument.bytes);
    const livePath = recoveryLivePath(root);
    await fs.mkdir(livePath, { recursive: true });
    const outsideBackup = path.join(outside, 'outside-backup.bin');
    await fs.writeFile(outsideBackup, beforeBytes);
    await writeRecoveryJournal(livePath, beforeBytes, plan.afterDocument.bytes);
    let outsideEvidence = outsideBackup;
    try {
      await fs.symlink(
        outsideBackup,
        path.join(livePath, 'ParentConfigurations.bin.backup'),
        'file',
      );
    } catch (error) {
      if (!isLinkPrivilegeError(error)) {
        throw error;
      }
      const outsideDirectory = path.join(outside, 'outside-backup-directory');
      await fs.mkdir(outsideDirectory);
      outsideEvidence = path.join(outsideDirectory, 'evidence.bin');
      await fs.writeFile(outsideEvidence, beforeBytes);
      await fs.symlink(
        outsideDirectory,
        path.join(livePath, 'ParentConfigurations.bin.backup'),
        'junction',
      );
    }
    const store = storeFor(root, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
    }
    assert.deepStrictEqual(await fs.readFile(outsideEvidence), beforeBytes);
    await fs.lstat(path.join(livePath, 'ParentConfigurations.bin.backup'));
    await fs.access(path.join(livePath, 'journal.json'));
  });

  test('rejects an escaping journal target and preserves recovery and outside evidence', async () => {
    const root = await tempRoot(roots);
    const outside = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, plan.afterDocument.bytes);
    const livePath = recoveryLivePath(root);
    await fs.mkdir(livePath, { recursive: true });
    await fs.writeFile(path.join(livePath, 'ParentConfigurations.bin.backup'), beforeBytes);
    await writeRecoveryJournal(
      livePath,
      beforeBytes,
      plan.afterDocument.bytes,
      '../outside.bin',
    );
    const outsideSentinel = path.join(outside, 'outside.bin');
    await fs.writeFile(outsideSentinel, 'preserve', 'utf8');
    const store = storeFor(root, {
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.match(state.diagnostics.join(' '), /schema is invalid|target path is invalid/i);
    }
    assert.strictEqual(await fs.readFile(outsideSentinel, 'utf8'), 'preserve');
    await fs.access(path.join(livePath, 'journal.json'));
    await fs.access(path.join(livePath, 'ParentConfigurations.bin.backup'));
  });
});

function objectModePlan(
  configRoot: string,
  bytes: Uint8Array,
  targetMode: 'editableWithSupport' | 'removedFromSupport',
) {
  const document = parseReadyDocument(bytes, configRoot);
  assert.strictEqual(document.state.kind, 'ready');
  if (document.state.kind !== 'ready') {
    throw new Error('Expected ready fixture');
  }
  return ParentConfigurationsCodec.planObjectMode(document, {
    configurationId: SUPPORT_TEST_CONFIGURATION_ID,
    objectId: SUPPORT_UUIDS.objectA,
    targetMode,
    expectedGenerationId: document.state.snapshot.generationId,
  });
}

async function writeRecoveryArtifacts(
  configRoot: string,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): Promise<void> {
  await writeRecoveryArtifactsAt(recoveryLivePath(configRoot), beforeBytes, afterBytes);
}

async function writeRecoveryArtifactsAt(
  recoveryRoot: string,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): Promise<void> {
  await fs.mkdir(recoveryRoot, { recursive: true });
  await fs.writeFile(
    path.join(recoveryRoot, 'ParentConfigurations.bin.backup'),
    beforeBytes,
  );
  await writeRecoveryJournal(recoveryRoot, beforeBytes, afterBytes);
}

async function writeRecoveryJournal(
  recoveryRoot: string,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  targetRelativePath = path.join('Ext', 'ParentConfigurations.bin').replace(/\\/g, '/'),
): Promise<void> {
  await fs.writeFile(
    path.join(recoveryRoot, 'journal.json'),
    `${JSON.stringify({
      version: 1,
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      targetRelativePath,
      beforeGenerationId: sha256(beforeBytes),
      plannedAfterGenerationId: sha256(afterBytes),
      expectedMetadataUniverseGenerationId: null,
      backupFile: 'ParentConfigurations.bin.backup',
    }, null, 2)}\n`,
    'utf8',
  );
}

function storeFor(
  configRoot: string,
  deps: Omit<ParentConfigurationsStoreDeps, 'recoveryRoot'> = {},
): ParentConfigurationsStore {
  return new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
    recoveryRoot: recoveryRootFor(configRoot),
    ...deps,
  });
}

function recoveryRootFor(
  configRoot: string,
  configurationId = SUPPORT_TEST_CONFIGURATION_ID,
): string {
  const resolvedRoot = path.resolve(configRoot);
  const normalizedRoot = process.platform === 'win32'
    ? resolvedRoot.toLocaleLowerCase()
    : resolvedRoot;
  const isolationKey = sha256(Buffer.from(`${configurationId}\0${normalizedRoot}`, 'utf8'));
  return path.join(
    TRUSTED_GLOBAL_STORAGE_ROOT,
    'support-master-recovery-v1',
    isolationKey,
  );
}

function recoveryLivePath(configRoot: string): string {
  return path.join(recoveryRootFor(configRoot), 'live');
}

function recoveryTombstonePath(configRoot: string): string {
  return path.join(recoveryRootFor(configRoot), 'tombstone');
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isLinkPrivilegeError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && ((error as { code?: string }).code === 'EPERM'
      || (error as { code?: string }).code === 'EACCES');
}

function universeTree(configRoot: string, objectUuid: string): TreeNode {
  const root: TreeNode = {
    id: 'Configuration',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    children: [],
  };
  const folder: TreeNode = {
    id: 'Catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    parent: root,
    properties: { type: 'Catalogs' },
    children: [],
  };
  const object: TreeNode = {
    id: 'Catalogs.Products',
    name: 'Products',
    type: MetadataType.Catalog,
    parent: folder,
    properties: { uuid: objectUuid },
    filePath: path.join(configRoot, 'Catalogs', 'Products.xml'),
  };
  folder.children = [object];
  root.children = [folder];
  return root;
}

async function tempRoot(roots: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-support-store-test-'));
  roots.push(root);
  return root;
}

function hasMutationCode(code: SupportMutationError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof SupportMutationError && error.code === code;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
