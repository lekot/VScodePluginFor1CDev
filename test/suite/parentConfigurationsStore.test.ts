import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { ParentConfigurationsCodec } from '../../src/support/parentConfigurationsCodec';
import { ParentConfigurationsStore } from '../../src/support/parentConfigurationsStore';
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

suite('ParentConfigurationsStore', () => {
  const roots: string[] = [];

  teardown(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })));
  });

  test('represents missing and empty containers as unmanaged without inventing generation', async () => {
    const missingRoot = await tempRoot(roots);
    const emptyRoot = await tempRoot(roots);
    await writeSyntheticMaster(emptyRoot, Buffer.alloc(0));
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID);

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

  test('successful commit uses public lease, writes exact planned bytes and removes durable journal', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const filePath = await writeSyntheticMaster(root, beforeBytes);
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    const leases: Array<{ resourcePath: string; kind: string }> = [];
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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

  test('within-lease recovery path does not reacquire gateway', async () => {
    const root = await tempRoot(roots);
    const beforeBytes = buildParentConfigurations();
    const plan = objectModePlan(root, beforeBytes, 'editableWithSupport');
    await writeSyntheticMaster(root, plan.afterDocument.bytes);
    await writeRecoveryArtifacts(root, beforeBytes, plan.afterDocument.bytes);
    let leaseCalls = 0;
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
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
    await fs.access(path.join(root, '.cdt-support-recovery', 'journal.json'));
    await fs.access(path.join(root, '.cdt-support-recovery', 'ParentConfigurations.bin.backup'));
  });

  test('invalid/incomplete recovery journal fails closed and preserves evidence', async () => {
    const root = await tempRoot(roots);
    const bytes = buildParentConfigurations();
    await writeSyntheticMaster(root, bytes);
    const recoveryRoot = path.join(root, '.cdt-support-recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });
    await fs.writeFile(path.join(recoveryRoot, 'journal.json'), '{"version":1}', 'utf8');
    const store = new ParentConfigurationsStore(SUPPORT_TEST_CONFIGURATION_ID, {
      syncDirectory: async () => undefined,
      runExclusive: async (_resourcePath, _kind, operation) => operation(),
    });

    const state = await store.read(root);

    assert.strictEqual(state.kind, 'unknown');
    if (state.kind === 'unknown') {
      assert.strictEqual(state.errorCode, 'SUPPORT_MASTER_RECOVERY_REQUIRED');
      assert.match(state.diagnostics.join(' '), /without its exact backup/);
    }
    await fs.access(path.join(recoveryRoot, 'journal.json'));
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
  const recoveryRoot = path.join(configRoot, '.cdt-support-recovery');
  await fs.mkdir(recoveryRoot, { recursive: true });
  await fs.writeFile(
    path.join(recoveryRoot, 'ParentConfigurations.bin.backup'),
    beforeBytes,
  );
  await fs.writeFile(
    path.join(recoveryRoot, 'journal.json'),
    `${JSON.stringify({
      version: 1,
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      targetRelativePath: path.join('Ext', 'ParentConfigurations.bin').replace(/\\/g, '/'),
      beforeGenerationId: sha256(beforeBytes),
      plannedAfterGenerationId: sha256(afterBytes),
      expectedMetadataUniverseGenerationId: null,
      backupFile: 'ParentConfigurations.bin.backup',
    }, null, 2)}\n`,
    'utf8',
  );
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
