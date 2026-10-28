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
  readUtf8,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const PURPOSES = ['AddOn', 'Customization', 'Patch'] as const;

const UUID = {
  baseRoot: '11111111-1111-4111-8111-111111111111',
  targetRoot: '22222222-2222-4222-8222-222222222222',
  sourceRoot: '33333333-3333-4333-8333-333333333333',
  baseModule: '44444444-4444-4444-8444-444444444444',
  targetModule: '55555555-5555-4555-8555-555555555555',
  sourceModule: '66666666-6666-4666-8666-666666666666',
} as const;

suite('Extension purpose transfer', () => {
  test('transfers an adopted CommonModule across all six purpose pairs without copying the source root purpose', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      for (const targetPurpose of PURPOSES) {
        for (const sourcePurpose of PURPOSES) {
          if (targetPurpose === sourcePurpose) {
            continue;
          }

          const caseId = `${targetPurpose}-from-${sourcePurpose}`;
          const caseRoot = path.join(tempRoot, caseId);
          const base = path.join(caseRoot, 'base');
          const target = path.join(caseRoot, 'target-cfe');
          const source = path.join(caseRoot, 'source-cfe');
          const baseModule: ExtensionCompareObjectFixture = {
            type: 'CommonModule',
            name: 'SharedHook',
            uuid: UUID.baseModule,
            propertiesXml: '<Global>false</Global>',
          };
          const targetModule: ExtensionCompareObjectFixture = {
            type: 'CommonModule',
            name: 'SharedHook',
            uuid: UUID.targetModule,
            belonging: 'Adopted',
            anchorUuid: UUID.baseModule,
            propertiesXml: '<Comment>target module</Comment><Global>false</Global>',
          };
          const sourceModule: ExtensionCompareObjectFixture = {
            ...targetModule,
            uuid: UUID.sourceModule,
            propertiesXml: '<Comment>source module</Comment><Global>true</Global>',
          };
          await writeDesignerConfiguration(base, {
            uuid: UUID.baseRoot,
            objects: [baseModule],
          });
          await writeDesignerConfiguration(target, {
            uuid: UUID.targetRoot,
            name: 'TargetExtension',
            purpose: targetPurpose,
            rootPropertiesXml: '<Comment>target root marker</Comment>',
            objects: [targetModule],
          });
          await writeDesignerConfiguration(source, {
            uuid: UUID.sourceRoot,
            name: 'SourceExtension',
            purpose: sourcePurpose,
            rootPropertiesXml: '<Comment>source root marker</Comment>',
            objects: [sourceModule],
          });

          const targetModuleBytes = Buffer.from(
            '&Перед("TargetHook")\r\nПроцедура TargetBefore()\r\nКонецПроцедуры\r\n',
            'utf8'
          );
          const sourceModuleBytes = Buffer.from(
            '&Перед("T336_BaseHook")\r\nПроцедура SourceBefore()\r\nКонецПроцедуры\r\n',
            'utf8'
          );
          await writeCompareBytes(
            target,
            'CommonModules/SharedHook/Ext/Module.bsl',
            targetModuleBytes
          );
          await writeCompareBytes(
            source,
            'CommonModules/SharedHook/Ext/Module.bsl',
            sourceModuleBytes
          );
          const targetConfigurationBefore = await fs.readFile(
            path.join(target, 'Configuration.xml')
          );

          const compare = await openCompare(tempRoot, target, source, {
            extensionBaseRoots: { left: base, right: base },
          });
          try {
            const node = findNode(compare.result.projection.root, 'CommonModule.SharedHook');
            assert.ok(
              node.mergeable,
              `${caseId}: adopted module should be selectable; state=${JSON.stringify(node.mergeState)}, conflict=${JSON.stringify(node.conflict)}`
            );
            assert.strictEqual(
              node.status,
              'changed',
              `${caseId}: source object changes should be visible`
            );
            const preview = await createPreview(compare.result, [node.id]);
            const executeResult = await execute(compare.result, preview.previewId);
            assert.strictEqual(executeResult, undefined);

            const configurationAfter = await fs.readFile(path.join(target, 'Configuration.xml'));
            assert.deepStrictEqual(
              configurationAfter,
              targetConfigurationBefore,
              `${caseId}: object-only transfer must not copy source root purpose, UUID or other root properties`
            );
            const descriptor = await readUtf8(target, 'CommonModules/SharedHook.xml');
            assert.match(
              descriptor,
              new RegExp(`<CommonModule uuid="${UUID.targetModule}"`, 'u'),
              `${caseId}: adopted transfer must retain the target-local object UUID`
            );
            assert.match(
              descriptor,
              new RegExp(
                `<ExtendedConfigurationObject>${UUID.baseModule}</ExtendedConfigurationObject>`,
                'u'
              ),
              `${caseId}: adopted transfer must retain the shared base anchor`
            );
            assert.match(
              descriptor,
              /<Comment>source module<\/Comment>/u,
              `${caseId}: source object properties should transfer`
            );
            assert.deepStrictEqual(
              await fs.readFile(path.join(target, 'CommonModules/SharedHook/Ext/Module.bsl')),
              sourceModuleBytes,
              `${caseId}: adopted interceptor bytes should transfer exactly`
            );
          } finally {
            await compare.dispose();
          }
        }
      }
    });
  });

  test('transfers an own CommonModule into a Patch CFE while preserving its target root identity', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-patch-cfe');
      const source = path.join(tempRoot, 'source-addon-cfe');
      const ownModule: ExtensionCompareObjectFixture = {
        type: 'CommonModule',
        name: 'Ext_Feature',
        uuid: UUID.sourceModule,
        belonging: 'Own',
        propertiesXml: '<Comment>source module</Comment><Global>false</Global>',
      };
      await writeDesignerConfiguration(target, {
        uuid: UUID.targetRoot,
        name: 'TargetPatch',
        purpose: 'Patch',
        namePrefix: 'Ext_',
        rootPropertiesXml: '<Comment>target root marker</Comment>',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.sourceRoot,
        name: 'SourceAddOn',
        purpose: 'AddOn',
        namePrefix: 'Ext_',
        rootPropertiesXml: '<Comment>source root marker</Comment>',
        objects: [ownModule],
      });
      const moduleBytes = Buffer.from(
        '&Перед("PatchHook")\r\nПроцедура PatchBefore()\r\nКонецПроцедуры\r\n',
        'utf8'
      );
      await writeCompareBytes(source, 'CommonModules/Ext_Feature/Ext/Module.bsl', moduleBytes);
      const targetConfigurationBefore = await readUtf8(target, 'Configuration.xml');
      const compare = await openCompare(tempRoot, target, source, {});
      try {
        const node = findNode(compare.result.projection.root, 'CommonModule.Ext_Feature');
        assert.ok(
          node.mergeable,
          `own CommonModule should be selectable into Patch after native acceptance; state=${JSON.stringify(node.mergeState)}, conflict=${JSON.stringify(node.conflict)}`
        );
        const preview = await createPreview(compare.result, [node.id]);
        await execute(compare.result, preview.previewId);

        const targetConfigurationAfter = await readUtf8(target, 'Configuration.xml');
        assert.match(
          targetConfigurationAfter,
          /<ConfigurationExtensionPurpose>Patch<\/ConfigurationExtensionPurpose>/u
        );
        assert.match(
          targetConfigurationAfter,
          new RegExp(`<Configuration uuid="${UUID.targetRoot}"`, 'u')
        );
        assert.match(targetConfigurationAfter, /<Comment>target root marker<\/Comment>/u);
        assert.match(targetConfigurationAfter, /<CommonModule>Ext_Feature<\/CommonModule>/u);
        assert.notStrictEqual(
          targetConfigurationAfter,
          targetConfigurationBefore,
          'own-object import must add a registration to the target Configuration.xml'
        );
        const descriptor = await readUtf8(target, 'CommonModules/Ext_Feature.xml');
        assert.match(descriptor, new RegExp(`<CommonModule uuid="${UUID.sourceModule}"`, 'u'));
        assert.match(descriptor, /<Comment>source module<\/Comment>/u);
        assert.deepStrictEqual(
          await fs.readFile(path.join(target, 'CommonModules/Ext_Feature/Ext/Module.bsl')),
          moduleBytes
        );
      } finally {
        await compare.dispose();
      }
    });
  });

  test('merges ConfigurationExtensionPurpose independently and preserves target root identity and metadata', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-patch-cfe');
      const source = path.join(tempRoot, 'source-addon-cfe');
      await writeDesignerConfiguration(target, {
        uuid: UUID.targetRoot,
        name: 'TargetPatch',
        purpose: 'Patch',
        namePrefix: 'Target_',
        rootPropertiesXml: '<Comment>target root comment</Comment><Vendor>TargetVendor</Vendor>',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.sourceRoot,
        name: 'SourceAddOn',
        purpose: 'AddOn',
        namePrefix: 'Source_',
        rootPropertiesXml: '<Comment>source root comment</Comment><Vendor>SourceVendor</Vendor>',
      });

      const compare = await openCompare(tempRoot, target, source, {});
      try {
        const purpose = findNode(compare.result.projection.root, 'Назначение расширения');
        assert.ok(
          purpose.mergeable,
          `supported purpose difference should be selectable independently; state=${JSON.stringify(purpose.mergeState)}, conflict=${JSON.stringify(purpose.conflict)}`
        );
        const preview = await createPreview(compare.result, [purpose.id]);
        await execute(compare.result, preview.previewId);

        const configuration = await readUtf8(target, 'Configuration.xml');
        assert.match(configuration, new RegExp(`<Configuration uuid="${UUID.targetRoot}"`, 'u'));
        assert.match(
          configuration,
          /<ConfigurationExtensionPurpose>AddOn<\/ConfigurationExtensionPurpose>/u
        );
        assert.match(configuration, /<Name>TargetPatch<\/Name>/u);
        assert.match(configuration, /<NamePrefix>Target_<\/NamePrefix>/u);
        assert.match(configuration, /<Comment>target root comment<\/Comment>/u);
        assert.match(configuration, /<Vendor>TargetVendor<\/Vendor>/u);
        assert.doesNotMatch(configuration, /SourceAddOn|Source_|source root comment|SourceVendor/u);
      } finally {
        await compare.dispose();
      }
    });
  });
});

interface OpenCompareOptions extends Pick<ConfigurationCompareInput, 'extensionBaseRoots'> {}

interface OpenCompareHandle {
  result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: OpenCompareOptions
): Promise<OpenCompareHandle> {
  const runtime = await createMergeMutationTestRuntime(leftRootPath);
  try {
    const result = await buildConfigurationCompare({
      leftRootPath,
      rightRootPath,
      backupRootPath: path.join(tempRoot, 'backups'),
      extensionBaseRoots: options.extensionBaseRoots,
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
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
        await runtime.coordinator.dispose();
      },
    };
  } catch (error) {
    await runtime.coordinator.dispose();
    throw error;
  }
}

async function createPreview(
  result: ConfigurationCompareResult,
  nodeIds: readonly string[]
): Promise<
  Extract<
    Awaited<ReturnType<ConfigurationCompareResult['workspace']['createPreviewForNodeIds']>>,
    { ok: true }
  >['preview']
> {
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  if (!created.ok) {
    throw new Error(`Preview failed: ${JSON.stringify(created.diagnostics)}`);
  }
  return created.preview;
}

async function execute(result: ConfigurationCompareResult, previewId: string): Promise<void> {
  const approved = result.workspace.approvePreview(previewId);
  assert.strictEqual(
    approved.ok,
    true,
    `Preview approval failed: ${approved.diagnostics.map((item) => item.code).join(', ')}`
  );
  const executed = await result.workspace.executeApprovedPreview(previewId, {
    destructiveConfirmed: true,
  });
  assert.strictEqual(
    executed.ok,
    true,
    `Preview execution failed: ${executed.diagnostics.map((item) => item.code).join(', ')}`
  );
}

function findNode(root: CompareTreeNode, label: string): CompareTreeNode {
  const matches = collectNodes(root).filter((node) => node.label === label);
  assert.strictEqual(
    matches.length,
    1,
    `Expected one compare row ${label}, found ${matches.length}`
  );
  return matches[0]!;
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue335-purpose-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
