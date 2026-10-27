import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
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
