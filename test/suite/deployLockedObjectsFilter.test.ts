import * as assert from 'assert';
import * as path from 'path';
import {
  DeployLockedObjectsPlanner,
  filterFilesByMasterLocks,
  filterOutLockedObjectFiles,
} from '../../src/bindings/deployLockedObjectsFilter';
import type { LockedObjectRef } from '../../src/services/ibcmd/ibcmdLockedObjectsParser';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import type {
  MasterSupportSnapshot,
  MetadataUniverseEntry,
  SupportStatusResult,
} from '../../src/support/supportTypes';

function locked(fullName: string): LockedObjectRef {
  const dotIdx = fullName.indexOf('.');
  const kind = dotIdx >= 0 ? fullName.slice(0, dotIdx) : '';
  const name = dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
  return { kind, name, fullName };
}

suite('filterOutLockedObjectFiles', () => {
  test('CommonModule: removes descriptor XML and files in object directory', () => {
    const files = [
      'CommonModules/АвансовыйОтчетЛокализация.xml',
      'CommonModules/АвансовыйОтчетЛокализация/Ext/Module.bsl',
      'Catalogs/Товары.xml',
      'Catalogs/Товары/Forms/ФормаЭлемента.xml',
    ];
    const result = filterOutLockedObjectFiles(files, [locked('CommonModule.АвансовыйОтчетЛокализация')]);
    assert.deepStrictEqual(result.filtered, [
      'CommonModules/АвансовыйОтчетЛокализация.xml',
      'CommonModules/АвансовыйОтчетЛокализация/Ext/Module.bsl',
    ]);
    assert.deepStrictEqual(result.kept, [
      'Catalogs/Товары.xml',
      'Catalogs/Товары/Forms/ФормаЭлемента.xml',
    ]);
  });

  test('empty locked list returns all files in kept', () => {
    const files = ['CommonModules/Foo.xml', 'Catalogs/Bar.xml'];
    const result = filterOutLockedObjectFiles(files, []);
    assert.deepStrictEqual(result.kept, files);
    assert.deepStrictEqual(result.filtered, []);
  });

  test('locked not in file list: kept is entire list, filtered is empty', () => {
    const files = ['Catalogs/Bar.xml'];
    const result = filterOutLockedObjectFiles(files, [locked('CommonModule.Ghost')]);
    assert.deepStrictEqual(result.kept, files);
    assert.deepStrictEqual(result.filtered, []);
  });

  test('multiple kinds filtered simultaneously (Catalog + CommonModule)', () => {
    const files = [
      'CommonModules/Mod.xml',
      'CommonModules/Mod/Ext/Module.bsl',
      'Catalogs/Ref.xml',
      'Catalogs/Ref/Forms/Form.xml',
      'Documents/Doc.xml',
    ];
    const result = filterOutLockedObjectFiles(files, [
      locked('CommonModule.Mod'),
      locked('Catalog.Ref'),
    ]);
    assert.deepStrictEqual(result.filtered, [
      'CommonModules/Mod.xml',
      'CommonModules/Mod/Ext/Module.bsl',
      'Catalogs/Ref.xml',
      'Catalogs/Ref/Forms/Form.xml',
    ]);
    assert.deepStrictEqual(result.kept, ['Documents/Doc.xml']);
  });

  test('comparison is case-insensitive', () => {
    const files = [
      'COMMONMODULES/FOO.XML',
      'commonmodules/foo/ext/module.bsl',
    ];
    const result = filterOutLockedObjectFiles(files, [locked('CommonModule.Foo')]);
    assert.strictEqual(result.filtered.length, 2);
    assert.strictEqual(result.kept.length, 0);
  });
});

suite('DeployLockedObjectsPlanner', () => {
  const configurationId = 'cfg-support' as ConfigurationId;
  const lockedOwnerId = '11111111-1111-1111-1111-111111111111';
  const lockedFragmentId = '22222222-2222-2222-2222-222222222222';

  test('ready plan routes ParentConfigurations and filters owner subtrees but only exact fragment files', async () => {
    const snapshot = readySnapshot(configurationId, [
      [lockedOwnerId, true],
      [lockedFragmentId, true],
    ]);
    const universe: MetadataUniverseEntry[] = [
      {
        relativeMetadataPath: 'Catalogs/Products.xml',
        objectUuid: lockedOwnerId,
        supportSubjectUuid: lockedOwnerId,
      },
      {
        relativeMetadataPath: 'Configuration.xml#ChildObjects/Catalog',
        objectUuid: lockedFragmentId,
        supportSubjectUuid: lockedFragmentId,
      },
    ];
    const planner = plannerFor(available(configurationId, {
      kind: 'ready',
      snapshot,
    }, universe));

    const result = await planner.plan({
      configurationId,
      mode: 'files',
      relativeFiles: [
        'Ext\\ParentConfigurations.bin',
        'Catalogs/Products.xml',
        'Catalogs/Products/Forms/Card.xml',
        'Catalogs/Other.xml',
        'Configuration.xml',
        'Ext/Other.bin',
      ],
    });

    assert.strictEqual(result.kind, 'ready');
    if (result.kind !== 'ready') {
      return;
    }
    assert.strictEqual(result.generationId, snapshot.generationId);
    assert.strictEqual(result.supportFileRouted, true);
    assert.deepStrictEqual(result.lockedSupportSubjectIds, [lockedOwnerId, lockedFragmentId]);
    assert.deepStrictEqual(result.skippedLockedFiles, [
      'Catalogs/Products.xml',
      'Catalogs/Products/Forms/Card.xml',
      'Configuration.xml',
    ]);
    assert.deepStrictEqual(result.relativeFiles, [
      'Catalogs/Other.xml',
      'Ext/Other.bin',
    ]);
  });

  test('ready plan fails closed when any locked subject is absent from the metadata universe', async () => {
    const status = available(configurationId, {
      kind: 'ready',
      snapshot: readySnapshot(configurationId, [[lockedOwnerId, true]]),
    }, []);

    const result = await plannerFor(status).plan({
      configurationId,
      mode: 'files',
      relativeFiles: ['Catalogs/Products.xml'],
    });

    assert.strictEqual(result.kind, 'unknown');
    if (result.kind !== 'unknown') {
      return;
    }
    assert.strictEqual(result.errorCode, 'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE');
    assert.ok(result.diagnostics.some((item) => item.includes(lockedOwnerId)));
  });

  test('invalid fragment mapping is rejected before any deploy file is admitted', () => {
    const snapshot = readySnapshot(configurationId, [[lockedOwnerId, true]]);
    const filtered = filterFilesByMasterLocks(
      ['Catalogs/Products.xml'],
      snapshot,
      [{
        relativeMetadataPath: 'Catalogs/Products.xml#',
        objectUuid: lockedOwnerId,
        supportSubjectUuid: lockedOwnerId,
      }],
    );

    assert.deepStrictEqual(filtered.kept, []);
    assert.deepStrictEqual(filtered.filtered, []);
    assert.strictEqual(filtered.mappingDiagnostics.length, 1);
  });

  test('unmanaged plan passes ordinary files through and still routes the support master', async () => {
    const planner = plannerFor(available(configurationId, {
      kind: 'unmanaged',
      reason: 'missing',
      configurationId,
      expectedFilePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    }, []));

    const result = await planner.plan({
      configurationId,
      mode: 'files',
      relativeFiles: [
        './Ext/ParentConfigurations.bin',
        'Catalogs/Products.xml',
      ],
    });

    assert.strictEqual(result.kind, 'unmanaged');
    if (result.kind !== 'unmanaged') {
      return;
    }
    assert.strictEqual(result.reason, 'missing');
    assert.strictEqual(result.supportFileRouted, true);
    assert.deepStrictEqual(result.skippedLockedFiles, []);
    assert.deepStrictEqual(result.relativeFiles, ['Catalogs/Products.xml']);
  });

  test('unknown master propagates its typed fail-closed diagnostic', async () => {
    const planner = plannerFor(available(configurationId, {
      kind: 'unknown',
      configurationId,
      filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
      errorCode: 'SUPPORT_MASTER_RECOVERY_REQUIRED',
      diagnostics: ['recovery journal is present'],
    }, []));

    const result = await planner.plan({
      configurationId,
      mode: 'files',
      relativeFiles: ['Catalogs/Products.xml'],
    });

    assert.deepStrictEqual(result, {
      kind: 'unknown',
      errorCode: 'SUPPORT_MASTER_RECOVERY_REQUIRED',
      diagnostics: ['recovery journal is present'],
    });
  });

  test('facade rejection and exception both become SUPPORT_OPERATION_FAILED', async () => {
    const rejected = new DeployLockedObjectsPlanner({
      getStatus: async () => ({
        status: 'operationRejected',
        errorCode: 'SUPPORT_OPERATION_FAILED',
        retryable: true,
      }),
    });
    const throwing = new DeployLockedObjectsPlanner({
      getStatus: async () => {
        throw new Error('secret internal failure');
      },
    });

    const rejectedResult = await rejected.plan({ configurationId, mode: 'files', relativeFiles: [] });
    const throwingResult = await throwing.plan({ configurationId, mode: 'files', relativeFiles: [] });

    assert.strictEqual(rejectedResult.kind, 'unknown');
    assert.strictEqual(throwingResult.kind, 'unknown');
    if (rejectedResult.kind === 'unknown' && throwingResult.kind === 'unknown') {
      assert.strictEqual(rejectedResult.errorCode, 'SUPPORT_OPERATION_FAILED');
      assert.strictEqual(throwingResult.errorCode, 'SUPPORT_OPERATION_FAILED');
      assert.ok(!throwingResult.diagnostics.join(' ').includes('secret internal failure'));
    }
  });

  test('managed full deploy is rejected with a distinct typed result', async () => {
    const snapshot = readySnapshot(configurationId, []);
    const result = await plannerFor(available(configurationId, {
      kind: 'ready',
      snapshot,
    }, [])).plan({
      configurationId,
      mode: 'full',
      relativeFiles: [],
    });

    assert.deepStrictEqual(result, {
      kind: 'fullDeployUnsafe',
      errorCode: 'SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE',
      diagnostics: [
        'Full-directory deploy is unsafe for a managed configuration; use file deploy with support routing.',
      ],
      generationId: snapshot.generationId,
    });
  });

  test('unmanaged full deploy remains allowed and does not invent file filtering', async () => {
    const result = await plannerFor(available(configurationId, {
      kind: 'unmanaged',
      reason: 'empty',
      configurationId,
      expectedFilePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    }, [])).plan({
      configurationId,
      mode: 'full',
      relativeFiles: [],
    });

    assert.strictEqual(result.kind, 'unmanaged');
    if (result.kind !== 'unmanaged') {
      return;
    }
    assert.strictEqual(result.reason, 'empty');
    assert.strictEqual(result.supportFileRouted, false);
    assert.deepStrictEqual(result.relativeFiles, []);
    assert.deepStrictEqual(result.skippedLockedFiles, []);
  });
});

function plannerFor(status: SupportStatusResult): DeployLockedObjectsPlanner {
  return new DeployLockedObjectsPlanner({
    getStatus: async () => status,
  });
}

function available(
  configurationId: ConfigurationId,
  master: SupportStatusResult['master'],
  entries: readonly MetadataUniverseEntry[],
): SupportStatusResult {
  if (master.kind === 'ready') {
    return {
      status: 'available',
      master,
      metadataUniverse: {
        configRoot: path.resolve('configuration'),
        metadataUniverseGenerationId: 'universe-generation',
        entries,
      },
    };
  }
  return {
    status: 'available',
    master,
  };
}

function readySnapshot(
  configurationId: ConfigurationId,
  objectLocks: ReadonlyArray<readonly [string, boolean]>,
): MasterSupportSnapshot {
  return {
    configurationId,
    generationId: 'generation-1',
    semanticDigest: 'a'.repeat(64),
    filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    formatRevision: '6',
    globalEditability: 'enabled',
    configurationMode: 'mixed',
    objectModes: new Map(objectLocks.map(([objectId, isLocked]) => [
      objectId,
      {
        objectId,
        locked: isLocked,
        effectiveMode: isLocked ? 'notEditable' : 'editableWithSupport',
        sources: [],
      },
    ])),
    supplierConfigurations: [],
  };
}
