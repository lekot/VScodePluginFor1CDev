import * as assert from 'assert';
import * as fs from 'fs/promises';
import fsPromises = require('fs/promises');
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import { tryBuildExtensionCompareState } from '../../../src/compareMerge/extensions/extensionCompare';
import { indexExtensionMetadataRoot, probeExtensionMetadataRoot } from '../../../src/compareMerge/extensions/extensionMetadataIndex';
import { captureMergePath } from '../../../src/compareMerge/merge/mergeSnapshot';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  createExtensionCompareTempRoot,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const UUID = {
  targetConfiguration: '11111111-1111-4111-8111-111111111111',
  sourceConfiguration: '22222222-2222-4222-8222-222222222222',
  baseConfiguration: '33333333-3333-4333-8333-333333333333',
  baseModule: '44444444-4444-4444-8444-444444444444',
  targetModule: '55555555-5555-4555-8555-555555555555',
  sourceModule: '66666666-6666-4666-8666-666666666666',
  ownObject: '77777777-7777-4777-8777-777777777777',
} as const;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const MODULE_PATH = 'CommonModules/Shared/Ext/Module.bsl';

const ROOT_CONFIGURATION_CASES = [
  {
    name: 'missing Configuration.xml',
    mutate: async (sourceRoot: string): Promise<void> => {
      await fs.rm(path.join(sourceRoot, 'Configuration.xml'));
      await writeCompareBytes(sourceRoot, 'ConfigurationExtension.xml', '<Extension/>');
    },
  },
  {
    name: 'malformed Configuration.xml',
    mutate: async (sourceRoot: string): Promise<void> => {
      await fs.writeFile(path.join(sourceRoot, 'Configuration.xml'), '<MetaDataObject><Configuration>', 'utf8');
    },
  },
  {
    name: 'malformed root UUID',
    mutate: async (sourceRoot: string): Promise<void> => replaceConfigurationUuid(sourceRoot, 'not-a-uuid'),
  },
  {
    name: 'zero root UUID',
    mutate: async (sourceRoot: string): Promise<void> => replaceConfigurationUuid(sourceRoot, ZERO_UUID),
  },
] as const;

const BASE_CONFIGURATION_CASES = [
  {
    name: 'missing base Configuration.xml',
    mutate: async (baseRoot: string): Promise<void> => {
      await fs.rm(path.join(baseRoot, 'Configuration.xml'));
    },
  },
  {
    name: 'malformed base Configuration.xml',
    mutate: async (baseRoot: string): Promise<void> => {
      await fs.writeFile(path.join(baseRoot, 'Configuration.xml'), '<MetaDataObject><Configuration>', 'utf8');
    },
  },
  {
    name: 'malformed base UUID',
    mutate: async (baseRoot: string): Promise<void> => replaceConfigurationUuid(baseRoot, 'not-a-uuid'),
  },
  {
    name: 'zero base UUID',
    mutate: async (baseRoot: string): Promise<void> => replaceConfigurationUuid(baseRoot, ZERO_UUID),
  },
  {
    name: 'duplicate base Properties',
    mutate: async (baseRoot: string): Promise<void> => {
      const filePath = path.join(baseRoot, 'Configuration.xml');
      const xml = await fs.readFile(filePath, 'utf8');
      const duplicate = xml.replace('<Properties></Properties>', '<Properties></Properties><Properties></Properties>');
      assert.notStrictEqual(duplicate, xml, 'fixture must contain one direct root Properties element');
      await fs.writeFile(filePath, duplicate, 'utf8');
    },
  },
] as const;

suite('Extension compare validation', () => {
  test('returns before reading registered sidecars when neither root has CFE evidence', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cf');
      const object: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: UUID.ownObject };
      await writeDesignerConfiguration(target, { objects: [object] });
      await writeDesignerConfiguration(source, { objects: [object] });
      const targetSidecar = path.join(target, 'Catalogs', 'Products', 'Ext', 'Module.bsl');
      const sourceSidecar = path.join(source, 'Catalogs', 'Products', 'Ext', 'Module.bsl');
      await writeCompareBytes(target, path.relative(target, targetSidecar), Buffer.alloc(256 * 1024, 0x41));
      await writeCompareBytes(source, path.relative(source, sourceSidecar), Buffer.alloc(256 * 1024, 0x42));

      const mutableFs = fsPromises;
      const originalReadFile = mutableFs.readFile;
      const sidecarReads: string[] = [];
      const instrumentedReadFile = ((...args: Parameters<typeof originalReadFile>) => {
        const requestedPath = args[0];
        if (typeof requestedPath === 'string' && requestedPath.endsWith(path.join('Catalogs', 'Products', 'Ext', 'Module.bsl'))) {
          sidecarReads.push(path.resolve(requestedPath));
        }
        return Reflect.apply(originalReadFile, mutableFs, args);
      }) as typeof originalReadFile;
      Object.defineProperty(mutableFs, 'readFile', { configurable: true, value: instrumentedReadFile });
      try {
        const result = await tryBuildExtensionCompareState({ leftRootPath: target, rightRootPath: source }, 'right');
        assert.strictEqual(result, undefined, 'ordinary CF roots should remain on the generic compare route');
        assert.deepStrictEqual(sidecarReads, [], 'the extension probe must not read registered sidecar contents');
      } finally {
        Object.defineProperty(mutableFs, 'readFile', { configurable: true, value: originalReadFile });
      }
    });
  });

  test('routes unregistered malformed descriptor markers with a missing root manifest into fail-closed CFE compare', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-missing-config');
      await writeDesignerConfiguration(target);
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await writeCompareBytes(source, 'Catalogs/Unregistered.xml', '<MetaDataObject><Catalog><Properties><ObjectBelonging>Adopted</ObjectBelonging></Properties><ExtendedConfigurationObject');

      const result = await tryBuildExtensionCompareState({ leftRootPath: target, rightRootPath: source }, 'right');

      assert.ok(result, 'an unregistered object marker must prevent CF fallback');
      assert.strictEqual(result.comparisonInfo?.mode, 'extension');
      assert.deepStrictEqual(result.mergeableNodeIds ?? [], [], 'the incomplete CFE root must remain blocked');
    });
  });

  test('detects an object marker after a long UTF-8 BOM-prefixed descriptor preamble', async () => {
    await withTempRoot(async (tempRoot) => {
      const rootPath = path.join(tempRoot, 'long-marker-root');
      await writeDesignerConfiguration(rootPath);
      const preamble = Buffer.from(`\uFEFF<!--${'x'.repeat(96 * 1024)}-->`, 'utf8');
      const descriptor = Buffer.from('<MetaDataObject><Catalog><Properties><ExtendedConfigurationObject>anchor</ExtendedConfigurationObject></Properties></Catalog></MetaDataObject>', 'utf8');
      await writeCompareBytes(rootPath, 'Catalogs/Unregistered.xml', Buffer.concat([preamble, descriptor]));

      const index = await indexExtensionMetadataRoot({ rootPath, sourceId: 'probe-source', side: 'right' });

      assert.strictEqual(index.rootKind, 'cfe');
      assert.strictEqual(index.cfeMarkerSeen, true);
    });
  });

  test('binds reusable root evidence to its canonical root and refreshes it when Configuration.xml changes', async () => {
    await withTempRoot(async (tempRoot) => {
      const rootPath = path.join(tempRoot, 'probed-root');
      const otherRootPath = path.join(tempRoot, 'other-root');
      await writeDesignerConfiguration(rootPath);
      await writeDesignerConfiguration(otherRootPath);
      const evidence = await probeExtensionMetadataRoot({ rootPath });

      await assert.rejects(
        indexExtensionMetadataRoot({ rootPath: otherRootPath, sourceId: 'other-source', side: 'right', rootEvidence: evidence }),
        /belongs to a different root/u,
      );

      const configurationPath = path.join(rootPath, 'Configuration.xml');
      const configurationXml = await fs.readFile(configurationPath, 'utf8');
      await fs.writeFile(configurationPath, configurationXml.replace('<Properties></Properties>', '<Properties><ObjectBelonging>Adopted</ObjectBelonging></Properties>'), 'utf8');
      const refreshed = await indexExtensionMetadataRoot({ rootPath, sourceId: 'probe-source', side: 'right', rootEvidence: evidence });
      assert.strictEqual(refreshed.rootKind, 'cfe', 'a changed root manifest must be re-probed before index reuse');
    });
  });

  test('cancels a sidecar snapshot after the in-flight file read and leaves no read pending', async () => {
    await withTempRoot(async (tempRoot) => {
      const sidecarPath = path.join(tempRoot, 'sidecar');
      for (const name of ['01.bin', '02.bin', '03.bin']) {
        await writeCompareBytes(tempRoot, path.join('sidecar', name), Buffer.alloc(1024, name.charCodeAt(1)));
      }
      const ordinarySnapshot = await captureMergePath(sidecarPath, { retainContent: false });
      const uncancelledSnapshot = await captureMergePath(sidecarPath, { retainContent: false, cancellation: { isCancellationRequested: false } });
      assert.strictEqual(ordinarySnapshot.state, 'directory');
      assert.strictEqual(uncancelledSnapshot.state, 'directory');
      if (ordinarySnapshot.state !== 'directory' || uncancelledSnapshot.state !== 'directory') {return;}
      assert.strictEqual(uncancelledSnapshot.mergeHash, ordinarySnapshot.mergeHash);
      assert.strictEqual(uncancelledSnapshot.mutationFingerprint, ordinarySnapshot.mutationFingerprint);

      const mutableFs = fsPromises;
      const originalReadFile = mutableFs.readFile;
      let cancelled = false;
      let reads = 0;
      let activeReads = 0;
      const instrumentedReadFile = (async (...args: Parameters<typeof originalReadFile>) => {
        reads += 1;
        activeReads += 1;
        try {
          const content = await Reflect.apply(originalReadFile, mutableFs, args);
          cancelled = true;
          return content;
        } finally {
          activeReads -= 1;
        }
      }) as typeof originalReadFile;
      Object.defineProperty(mutableFs, 'readFile', { configurable: true, value: instrumentedReadFile });
      try {
        await assert.rejects(
          captureMergePath(sidecarPath, { retainContent: false, cancellation: { get isCancellationRequested() { return cancelled; } } }),
          (error: unknown) => (error as { code?: string }).code === 'CONFIGURATION_COMPARE_CANCELLED',
        );
        assert.strictEqual(reads, 1, 'the cancelled snapshot must stop before the next sibling file');
        assert.strictEqual(activeReads, 0, 'the cancellation must wait for the in-flight filesystem read to finish');
      } finally {
        Object.defineProperty(mutableFs, 'readFile', { configurable: true, value: originalReadFile });
      }
    });
  });

  test('blocks a CFE target with duplicate direct root ChildObjects before a valid own transfer', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const incomingOwn: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Ext_Orders',
        uuid: UUID.ownObject,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, {
        uuid: UUID.targetConfiguration,
        purpose: 'Customization',
        namePrefix: 'Ext_',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.sourceConfiguration,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [incomingOwn],
      });

      const configurationPath = path.join(target, 'Configuration.xml');
      const xml = await fs.readFile(configurationPath, 'utf8');
      const duplicate = xml.replace(
        '</ChildObjects>',
        '</ChildObjects><ChildObjects></ChildObjects>',
      );
      assert.notStrictEqual(duplicate, xml, 'target fixture must contain its root ChildObjects list');
      await fs.writeFile(configurationPath, duplicate, 'utf8');

      const before = await snapshotFiles(target);
      const compare = await openCompare(tempRoot, target, source);
      try {
        await assertBlockedWithoutWrites(compare.result, target, before, 'duplicate target root ChildObjects');
        assert.ok(compare.result.session.state.messages.some((message) => (
          message.code === 'EXTENSION_CONFIGURATION_CHILD_OBJECTS_INVALID' && message.blocking
        )), 'duplicate root ChildObjects should produce a root-wide configuration diagnostic');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('accepts one empty direct root ChildObjects as an empty registration list', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const incomingOwn: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Ext_Orders',
        uuid: UUID.ownObject,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, {
        uuid: UUID.targetConfiguration,
        purpose: 'Customization',
        namePrefix: 'Ext_',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.sourceConfiguration,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [incomingOwn],
      });

      const compare = await openCompare(tempRoot, target, source);
      try {
        assert.strictEqual(compare.result.workspace.payload.comparisonInfo?.mode, 'extension');
        assert.strictEqual(compare.result.workspace.listMergeableNodeIds().length, 1,
          'a single empty ChildObjects must remain a valid empty registration list');
      } finally {
        await compare.dispose();
      }
    });
  });

  for (const scenario of ROOT_CONFIGURATION_CASES) {
    test(`blocks CFE source with ${scenario.name} before offering a transfer`, async () => {
      await withTempRoot(async (tempRoot) => {
        const target = path.join(tempRoot, 'target-cfe');
        const source = path.join(tempRoot, 'source-cfe');
        await writeOwnCfePair(target, source);
        await scenario.mutate(source);

        const before = await snapshotFiles(target);
        const compare = await openCompare(tempRoot, target, source);
        try {
          await assertBlockedWithoutWrites(compare.result, target, before, scenario.name);
        } finally {
          await compare.dispose();
        }
      });
    });
  }

  for (const scenario of BASE_CONFIGURATION_CASES) {
    test(`blocks explicit CF base with ${scenario.name} before adopted-module transfer`, async () => {
      await withTempRoot(async (tempRoot) => {
        const base = path.join(tempRoot, 'base-cf');
        const target = path.join(tempRoot, 'target-cfe');
        const source = path.join(tempRoot, 'source-cfe');
        await writeAdoptedModuleCompare(base, target, source);
        await scenario.mutate(base);

        const before = await snapshotFiles(target);
        const compare = await openCompare(tempRoot, target, source, {
          extensionBaseRoots: { left: base, right: base },
        });
        try {
          await assertBlockedWithoutWrites(compare.result, target, before, scenario.name);
        } finally {
          await compare.dispose();
        }
      });
    });
  }

  for (const [index, decorator] of [
    '&ИзменениеИКонтроль("ПриЗаписи")',
    '&ChangeAndValidate("OnWrite")',
  ].entries()) {
    test(`blocks unsupported decorator ${decorator} in adopted CFE-to-CFE modules`, async () => {
      await withTempRoot(async (tempRoot) => {
        const base = path.join(tempRoot, 'base-cf');
        const target = path.join(tempRoot, 'target-cfe');
        const source = path.join(tempRoot, 'source-cfe');
        await writeAdoptedModuleCompare(
          base,
          target,
          source,
          '&Перед("ПриЗаписи")\nПроцедура Ext_Target()\nКонецПроцедуры',
          `${decorator}\nПроцедура Ext_Incoming()\nКонецПроцедуры`,
        );

        const before = await snapshotFiles(target);
        const compare = await openCompare(tempRoot, target, source, {
          extensionBaseRoots: { left: base, right: base },
        });
        try {
          await assertPreviewRejectedWithoutWrites(compare.result, target, before, `${index}:${decorator}`);
        } finally {
          await compare.dispose();
        }
      });
    });
  }

  test('allows Before, After, and Instead decorators and ignores decorator text in comments or strings', async () => {
    await withTempRoot(async (tempRoot) => {
      const modules = [
        '&Перед("ПриЗаписи")\nПроцедура Ext_Before()\nКонецПроцедуры',
        '&После("ПриЗаписи")\nПроцедура Ext_After()\nКонецПроцедуры',
        '&Вместо("ПриЗаписи")\nПроцедура Ext_Instead()\nКонецПроцедуры',
        [
          'Процедура Ext_TextOnly()',
          '    // &ИзменениеИКонтроль("ПриЗаписи")',
          '    DecoratorText = "&ChangeAndValidate(""OnWrite"")";',
          'КонецПроцедуры',
        ].join('\n'),
      ];

      for (const [index, moduleText] of modules.entries()) {
        const caseRoot = path.join(tempRoot, `supported-decorator-${index}`);
        const base = path.join(caseRoot, 'base-cf');
        const target = path.join(caseRoot, 'target-cfe');
        const source = path.join(caseRoot, 'source-cfe');
        await writeAdoptedModuleCompare(base, target, source, '', moduleText);

        const compare = await openCompare(tempRoot, target, source, {
          extensionBaseRoots: { left: base, right: base },
        });
        try {
          const nodeIds = compare.result.workspace.listMergeableNodeIds();
          assert.strictEqual(compare.result.workspace.payload.comparisonInfo?.mode, 'extension');
          assert.strictEqual(nodeIds.length, 1,
            `expected valid module to remain transferable: ${moduleText}`);
          const preview = await compare.result.workspace.createPreviewForNodeIds(nodeIds);
          assert.strictEqual(preview.ok, true,
            `expected supported module preview to succeed: ${JSON.stringify(preview)}`);
        } finally {
          await compare.dispose();
        }
      }
    });
  });
});

interface OpenCompareOptions extends Pick<ConfigurationCompareInput, 'extensionBaseRoots'> {}

interface OpenCompareHandle {
  readonly result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: OpenCompareOptions = {},
): Promise<OpenCompareHandle> {
  const result = await buildConfigurationCompare({
    leftRootPath,
    rightRootPath,
    backupRootPath: path.join(tempRoot, 'backups'),
    extensionBaseRoots: options.extensionBaseRoots,
  });
  let disposed = false;
  return {
    result,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      result.workspace.dispose();
    },
  };
}

async function writeOwnCfePair(target: string, source: string): Promise<void> {
  const targetObject: ExtensionCompareObjectFixture = {
    type: 'Catalog',
    name: 'Ext_Orders',
    uuid: UUID.ownObject,
    propertiesXml: '<Comment>target</Comment>',
  };
  const sourceObject: ExtensionCompareObjectFixture = {
    ...targetObject,
    propertiesXml: '<Comment>source</Comment>',
  };
  await writeDesignerConfiguration(target, {
    uuid: UUID.targetConfiguration,
    purpose: 'Customization',
    namePrefix: 'Ext_',
    objects: [targetObject],
  });
  await writeDesignerConfiguration(source, {
    uuid: UUID.sourceConfiguration,
    purpose: 'Customization',
    namePrefix: 'Ext_',
    objects: [sourceObject],
  });
}

async function writeAdoptedModuleCompare(
  base: string,
  target: string,
  source: string,
  targetModule = '&Перед("ПриЗаписи")\nПроцедура Ext_Target()\nКонецПроцедуры',
  sourceModule = '&После("ПриЗаписи")\nПроцедура Ext_Incoming()\nКонецПроцедуры',
): Promise<void> {
  await writeDesignerConfiguration(base, {
    uuid: UUID.baseConfiguration,
    objects: [{ type: 'CommonModule', name: 'Shared', uuid: UUID.baseModule }],
  });

  for (const [rootPath, localUuid] of [
    [target, UUID.targetModule],
    [source, UUID.sourceModule],
  ] as const) {
    const adopted: ExtensionCompareObjectFixture = {
      type: 'CommonModule',
      name: 'Shared',
      uuid: localUuid,
      belonging: 'Adopted',
      anchorUuid: UUID.baseModule,
      propertiesXml: '<xr:Properties><xr:Property>Module</xr:Property><xr:State>Extended</xr:State></xr:Properties>',
    };
    await writeDesignerConfiguration(rootPath, {
      purpose: 'Customization',
      objects: [adopted],
    });
  }

  await writeCompareBytes(target, MODULE_PATH, targetModule);
  await writeCompareBytes(source, MODULE_PATH, sourceModule);
}

async function replaceConfigurationUuid(rootPath: string, uuid: string): Promise<void> {
  const configurationPath = path.join(rootPath, 'Configuration.xml');
  const xml = await fs.readFile(configurationPath, 'utf8');
  const replaced = xml.replace(/(<Configuration\s+uuid=")[^"]*(")/u, (_match, prefix: string, suffix: string) => `${prefix}${uuid}${suffix}`);
  assert.notStrictEqual(replaced, xml, 'fixture must contain a root Configuration UUID');
  await fs.writeFile(configurationPath, replaced, 'utf8');
}

async function assertBlockedWithoutWrites(
  result: ConfigurationCompareResult,
  targetRoot: string,
  before: readonly (readonly [string, string])[],
  context: string,
): Promise<void> {
  assertBlocked(result, context);
  assert.deepStrictEqual(await snapshotFiles(targetRoot), before, `${context}: target files changed`);
}

async function assertPreviewRejectedWithoutWrites(
  result: ConfigurationCompareResult,
  targetRoot: string,
  before: readonly (readonly [string, string])[],
  context: string,
): Promise<void> {
  const nodeIds = result.workspace.listMergeableNodeIds();
  assert.strictEqual(result.workspace.payload.comparisonInfo?.mode, 'extension', `${context}: generic CF fallback`);
  assert.ok(nodeIds.length > 0, `${context}: the adopted module should be indexed before hydration`);
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  assert.strictEqual(created.ok, false, `${context}: unsupported decorator preview was accepted`);
  if (created.ok) {
    assert.fail(`${context}: unsupported decorator preview was accepted`);
  }
  assert.ok(created.diagnostics.length > 0, `${context}: rejected preview omitted diagnostics`);
  assert.deepStrictEqual(await snapshotFiles(targetRoot), before, `${context}: target files changed`);
}

function assertBlocked(result: ConfigurationCompareResult, context: string): void {
  const nodes = collectNodes(result.projection.root);
  const hasBlockingRow = nodes.some((node) => (
    node.mergeable === false
    || node.mergeState?.state === 'blocked'
    || node.mergeState?.state === 'identityConflict'
    || node.conflict?.blocking === true
  ));
  const hasBlockingMessage = result.session.state.messages.some((message) => message.blocking);
  assert.strictEqual(result.workspace.payload.comparisonInfo?.mode, 'extension', `${context}: generic CF fallback`);
  assert.strictEqual(result.workspace.listMergeableNodeIds().length, 0, `${context}: transfer was offered`);
  assert.ok(hasBlockingRow || hasBlockingMessage, `${context}: no blocking row or diagnostic was shown`);
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

async function snapshotFiles(rootPath: string): Promise<readonly (readonly [string, string])[]> {
  const files: Array<readonly [string, string]> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push([path.relative(rootPath, fullPath).replace(/\\/gu, '/'), (await fs.readFile(fullPath)).toString('base64')]);
      }
    }
  };
  await visit(rootPath);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue336-validation-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
