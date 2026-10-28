import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { createExtensionCompareTempRoot, readUtf8, writeCompareBytes, writeDesignerConfiguration, type ExtensionCompareObjectFixture } from '../../helpers/extensionCompareFixtures';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const UUID = {
  targetRoot: '11111111-1111-4111-8111-111111111111',
  sourceRoot: '22222222-2222-4222-8222-222222222222',
  module: '33333333-3333-4333-8333-333333333333',
} as const;

suite('CFE root purpose semantic merge', () => {
  test('selects ConfigurationExtensionPurpose alone and preserves every other target root property', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target');
      const source = path.join(tempRoot, 'source');
      await writeDesignerConfiguration(target, {
        uuid: UUID.targetRoot,
        name: 'TargetExtension',
        purpose: 'Customization',
        namePrefix: 'Target_',
        rootPropertiesXml: '<Comment>target marker</Comment><Version>1.0</Version>',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.sourceRoot,
        name: 'SourceExtension',
        purpose: 'AddOn',
        namePrefix: 'Source_',
        rootPropertiesXml: '<Comment>source marker</Comment><Version>2.0</Version>',
      });
      const before = await readUtf8(target, 'Configuration.xml');
      const compare = await openCompare(tempRoot, target, source);
      try {
        const purpose = findNode(compare.result.projection.root, 'Назначение расширения');
        assert.ok(purpose.mergeable, `purpose should be selectable: ${JSON.stringify(purpose.mergeState)}`);
        assert.strictEqual(purpose.leftValue, 'Адаптация');
        assert.strictEqual(purpose.rightValue, 'Дополнение');
        const preview = await createPreview(compare.result, [purpose.id]);
        assert.strictEqual(preview.items.length, 1, 'purpose-only selection should produce one captured Configuration.xml write');
        assert.strictEqual(preview.items[0]?.previewPath, 'Configuration.xml');
        await execute(compare.result, preview.previewId);

        const after = await readUtf8(target, 'Configuration.xml');
        assert.match(after, /<ConfigurationExtensionPurpose>AddOn<\/ConfigurationExtensionPurpose>/u);
        assert.match(after, new RegExp(`<Configuration uuid="${UUID.targetRoot}"`, 'u'));
        assert.match(after, /<Name>TargetExtension<\/Name>/u);
        assert.match(after, /<NamePrefix>Target_<\/NamePrefix>/u);
        assert.match(after, /<Comment>target marker<\/Comment>/u);
        assert.match(after, /<Version>1\.0<\/Version>/u);
        assert.doesNotMatch(after, /SourceExtension|Source_|source marker|<Version>2\.0/u);
        assert.notStrictEqual(after, before);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('combines purpose change and new object registration into one Configuration.xml write', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target');
      const source = path.join(tempRoot, 'source');
      const incoming: ExtensionCompareObjectFixture = {
        type: 'CommonModule', name: 'Ext_NewModule', uuid: UUID.module, belonging: 'Own',
        propertiesXml: '<Comment>incoming module</Comment><Global>false</Global>',
      };
      await writeDesignerConfiguration(target, {
        uuid: UUID.targetRoot, name: 'TargetExtension', purpose: 'Customization', namePrefix: 'Ext_',
        rootPropertiesXml: '<Comment>target marker</Comment>',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.sourceRoot, name: 'SourceExtension', purpose: 'AddOn', namePrefix: 'Ext_',
        rootPropertiesXml: '<Comment>source marker</Comment>', objects: [incoming],
      });
      const compare = await openCompare(tempRoot, target, source);
      try {
        const purpose = findNode(compare.result.projection.root, 'Назначение расширения');
        const object = findNode(compare.result.projection.root, 'CommonModule.Ext_NewModule');
        assert.ok(purpose.mergeable);
        assert.ok(object.mergeable);
        const preview = await createPreview(compare.result, [purpose.id, object.id]);
        const configurationWrites = preview.items.filter((item) => item.previewPath === 'Configuration.xml');
        assert.strictEqual(configurationWrites.length, 1, 'root purpose and registration must share a single captured write');
        assert.strictEqual(preview.items.length, 2, 'the second write is the new object descriptor');
        await execute(compare.result, preview.previewId);

        const configuration = await readUtf8(target, 'Configuration.xml');
        assert.match(configuration, /<ConfigurationExtensionPurpose>AddOn<\/ConfigurationExtensionPurpose>/u);
        assert.match(configuration, new RegExp(`<Configuration uuid="${UUID.targetRoot}"`, 'u'));
        assert.match(configuration, /<Name>TargetExtension<\/Name>/u);
        assert.match(configuration, /<NamePrefix>Ext_<\/NamePrefix>/u);
        assert.match(configuration, /<Comment>target marker<\/Comment>/u);
        assert.match(configuration, /<CommonModule>Ext_NewModule<\/CommonModule>/u);
        assert.doesNotMatch(configuration, /SourceExtension|source marker/u);
        assert.match(await readUtf8(target, 'CommonModules/Ext_NewModule.xml'), /<Comment>incoming module<\/Comment>/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks execution when either captured root Configuration.xml becomes stale', async () => {
    await withTempRoot(async (tempRoot) => {
      for (const staleSide of ['target', 'source'] as const) {
        const caseRoot = path.join(tempRoot, staleSide);
        const target = path.join(caseRoot, 'target');
        const source = path.join(caseRoot, 'source');
        await writeDesignerConfiguration(target, { uuid: UUID.targetRoot, name: 'Target', purpose: 'Customization' });
        await writeDesignerConfiguration(source, { uuid: UUID.sourceRoot, name: 'Source', purpose: 'AddOn' });
        const compare = await openCompare(tempRoot, target, source);
        try {
          const purpose = findNode(compare.result.projection.root, 'Назначение расширения');
          const preview = await createPreview(compare.result, [purpose.id]);
          const approved = compare.result.workspace.approvePreview(preview.previewId);
          assert.strictEqual(approved.ok, true);
          const root = staleSide === 'target' ? target : source;
          const configPath = path.join(root, 'Configuration.xml');
          await fs.appendFile(configPath, '\n<!-- stale -->', 'utf8');
          const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, false, `${staleSide} root witness should invalidate execution`);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('shows unsupported purpose values as read-only root properties', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target');
      const source = path.join(tempRoot, 'source');
      await writeDesignerConfiguration(target, { uuid: UUID.targetRoot, purpose: 'Customization' });
      await writeDesignerConfiguration(source, { uuid: UUID.sourceRoot, purpose: 'FuturePurpose' });
      const compare = await openCompare(tempRoot, target, source);
      try {
        const purpose = findNode(compare.result.projection.root, 'Назначение расширения');
        assert.strictEqual(purpose.mergeable, false);
        assert.match(purpose.rightValue ?? '', /Недопустимое назначение/u);
        const reason = purpose.mergeState?.state === 'blocked' ? purpose.mergeState.reason ?? '' : '';
        assert.match(reason, /поддерживаемыми значениями/u);
        assert.ok(!compare.result.workspace.listMergeableNodeIds().includes(purpose.id));
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps malformed source Form.xml visible as read-only and exposes its diagnostic', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target');
      const source = path.join(tempRoot, 'source');
      const object: ExtensionCompareObjectFixture = {
        type: 'CommonModule', name: 'Ext_Module', uuid: UUID.module, belonging: 'Own',
        propertiesXml: '<Global>false</Global>',
      };
      await writeDesignerConfiguration(target, { purpose: 'Customization', namePrefix: 'Ext_', objects: [object] });
      await writeDesignerConfiguration(source, { purpose: 'Customization', namePrefix: 'Ext_', objects: [object] });
      const relativeForm = 'CommonModules/Ext_Module/Forms/Main/Ext/Form.xml';
      await writeCompareBytes(target, relativeForm, '<Form><WindowTitle>Target</WindowTitle></Form>');
      await writeCompareBytes(source, relativeForm, '<Form><WindowTitle>Broken</Form>');
      const compare = await withPlatform('linux', () => openCompare(tempRoot, target, source));
      try {
        const form = findNode(compare.result.projection.root, 'Форма: Forms/Main/Ext');
        assert.strictEqual(form.mergeable, false);
        assert.strictEqual(form.mergeState?.state, 'blocked');
        assert.ok(!compare.result.workspace.listMergeableNodeIds().includes(form.id));
        const diagnostics = findNode(compare.result.projection.root, 'Диагностика');
        assert.ok(diagnostics.children.some((node) => node.label === 'XML_ADAPTER_PARSE_FAILED'));
        assert.ok(form.children.length === 0, 'malformed file must not expose executable XML properties');
      } finally {
        await compare.dispose();
      }
    });
  });
});

interface OpenCompareHandle {
  result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function openCompare(tempRoot: string, leftRootPath: string, rightRootPath: string): Promise<OpenCompareHandle> {
  const runtime = await createMergeMutationTestRuntime(leftRootPath);
  try {
    const input: ConfigurationCompareInput = {
      leftRootPath,
      rightRootPath,
      backupRootPath: path.join(tempRoot, 'backups'),
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
    };
    const result = await buildConfigurationCompare(input);
    return {
      result,
      dispose: async () => {
        result.workspace.dispose();
        await runtime.coordinator.dispose();
      },
    };
  } catch (error) {
    await runtime.coordinator.dispose();
    throw error;
  }
}

async function createPreview(result: ConfigurationCompareResult, nodeIds: readonly string[]) {
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  if (!created.ok) {throw new Error(`Preview failed: ${JSON.stringify(created.diagnostics)}`);}
  return created.preview;
}

async function execute(result: ConfigurationCompareResult, previewId: string): Promise<void> {
  const approved = result.workspace.approvePreview(previewId);
  assert.strictEqual(approved.ok, true, `Preview approval failed: ${JSON.stringify(approved.diagnostics)}`);
  const executed = await result.workspace.executeApprovedPreview(previewId, { destructiveConfirmed: true });
  assert.strictEqual(executed.ok, true, `Preview execution failed: ${JSON.stringify(executed.diagnostics)}`);
}

function findNode(root: CompareTreeNode, label: string): CompareTreeNode {
  const matches = [root, ...root.children.flatMap(collectNodes)].filter((node) => node.label === label);
  assert.strictEqual(matches.length, 1, `Expected one node ${label}, found ${matches.length}`);
  return matches[0]!;
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await createExtensionCompareTempRoot('issue335-purpose-merge-');
  try {return await callback(root);}
  finally {await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });}
}

async function withPlatform<T>(platform: NodeJS.Platform, callback: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {return await callback();}
  finally {Object.defineProperty(process, 'platform', original);}
}
