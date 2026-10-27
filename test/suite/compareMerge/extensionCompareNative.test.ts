import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { createExtensionCompareTempRoot, pathExists } from '../../helpers/extensionCompareFixtures';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../test/fixtures/compareMerge/extensions/native-2.20');
const FIXTURES = {
  base: path.join(FIXTURE_ROOT, 'base'),
  extensionA: path.join(FIXTURE_ROOT, 'extension-a'),
  extensionB: path.join(FIXTURE_ROOT, 'extension-b'),
} as const;

const ADOPTED_COMMON_MODULE = 'тестМодуль';
const OWN_COMMON_MODULE = 'T336_Feature';

suite('Native extension compare fixtures 2.20', () => {
  test('CF→CFE creates a borrowed shell from native base metadata', async () => {
    await withNativeSandbox(async (tempRoot) => {
      const base = await copyFixture(tempRoot, 'base', 'base');
      const target = await copyFixture(tempRoot, 'extensionA', 'target-extension-a');
      const baseBefore = await hashDirectory(base);
      const baseModule = await readMetadataObject(base, 'CommonModules', ADOPTED_COMMON_MODULE);
      const baseUuid = metadataUuid(baseModule, 'CommonModule');
      const targetRootUuid = configurationUuid(await readFile(target, 'Configuration.xml'));

      const compare = await openNativeCompare(tempRoot, target, base, { left: base });
      try {
        const nodeId = mergeableObjectId(compare.result, `CommonModule.${ADOPTED_COMMON_MODULE}`);
        const preview = await createPreview(compare.result, [nodeId]);
        assert.ok(preview.items.some((item) => item.previewPath === `CommonModules/${ADOPTED_COMMON_MODULE}.xml`));
        await approveAndExecute(compare.result, preview.previewId);

        const borrowed = await readMetadataObject(target, 'CommonModules', ADOPTED_COMMON_MODULE);
        const targetConfiguration = await readFile(target, 'Configuration.xml');
        assert.match(borrowed, /<ObjectBelonging>Adopted<\/ObjectBelonging>/u);
        assert.strictEqual(metadataTag(borrowed, 'ExtendedConfigurationObject'), baseUuid);
        assert.strictEqual(configurationUuid(targetConfiguration), targetRootUuid);
        assert.strictEqual((targetConfiguration.match(/<CommonModule>тестМодуль<\/CommonModule>/gu) ?? []).length, 1);
        assert.strictEqual(await pathExists(path.join(target, 'CommonModules', ADOPTED_COMMON_MODULE, 'Ext', 'Module.bsl')), false,
          'the borrowed shell must not copy the base module body');
        assert.strictEqual(await hashDirectory(base), baseBefore, 'native base source changed');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE-B→CF transfers its own module and rejects flattening the adopted interceptor', async () => {
    await withNativeSandbox(async (tempRoot) => {
      const source = await copyFixture(tempRoot, 'extensionB', 'source-extension-b');
      const sourceBefore = await hashDirectory(source);
      const target = await copyFixture(tempRoot, 'base', 'target-cf-own');
      const targetRootUuid = configurationUuid(await readFile(target, 'Configuration.xml'));
      const ownDescriptorBytes = await fs.readFile(path.join(source, 'CommonModules', `${OWN_COMMON_MODULE}.xml`));
      const ownModuleBytes = await fs.readFile(path.join(source, 'CommonModules', OWN_COMMON_MODULE, 'Ext', 'Module.bsl'));

      const ownCompare = await openNativeCompare(tempRoot, target, source, { right: target });
      try {
        const ownId = mergeableObjectId(ownCompare.result, `CommonModule.${OWN_COMMON_MODULE}`);
        const preview = await createPreview(ownCompare.result, [ownId]);
        await approveAndExecute(ownCompare.result, preview.previewId);

        assert.deepStrictEqual(await fs.readFile(path.join(target, 'CommonModules', `${OWN_COMMON_MODULE}.xml`)), ownDescriptorBytes);
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'CommonModules', OWN_COMMON_MODULE, 'Ext', 'Module.bsl')), ownModuleBytes);
        assert.strictEqual(configurationUuid(await readFile(target, 'Configuration.xml')), targetRootUuid);
        assert.strictEqual((await readFile(target, 'Configuration.xml')).match(/<CommonModule>T336_Feature<\/CommonModule>/gu)?.length, 1);
        assert.strictEqual(await hashDirectory(source), sourceBefore, 'CFE-B source changed during own-object transfer');
      } finally {
        await ownCompare.dispose();
      }

      const blockedTarget = await copyFixture(tempRoot, 'base', 'target-cf-blocked');
      const blockedTargetBefore = await hashDirectory(blockedTarget);
      const blockedCompare = await openNativeCompare(tempRoot, blockedTarget, source, { right: blockedTarget });
      try {
        const adoptedId = objectId(blockedCompare.result, `CommonModule.${ADOPTED_COMMON_MODULE}`);
        const rejected = await blockedCompare.result.workspace.createPreviewForNodeIds([adoptedId]);
        assert.strictEqual(rejected.ok, false, `native adopted interceptor unexpectedly previewed: ${JSON.stringify(rejected)}`);
        assert.ok(rejected.diagnostics.length > 0, 'rejection should explain that the adopted interceptor cannot be flattened');
        assert.strictEqual(await hashDirectory(blockedTarget), blockedTargetBefore, 'rejected adopted transfer wrote to the CF target');
        assert.strictEqual(await hashDirectory(source), sourceBefore, 'rejected adopted transfer changed CFE-B source');
      } finally {
        await blockedCompare.dispose();
      }
    });
  });

  test('CFE-B adopted Comment overlay remains separate from its interceptor sidecar', async () => {
    await withNativeSandbox(async (tempRoot) => {
      const target = await copyFixture(tempRoot, 'base', 'target-cf-comment');
      const source = await copyFixture(tempRoot, 'extensionB', 'source-extension-b-comment');
      const sourceDescriptorPath = path.join(source, 'CommonModules', `${ADOPTED_COMMON_MODULE}.xml`);
      const sourceDescriptor = await fs.readFile(sourceDescriptorPath, 'utf8');
      assert.match(sourceDescriptor, /<Comment>Incoming CFE adopted CommonModule<\/Comment>/u);
      assert.match(sourceDescriptor, /<xr:PropertyState>[\s\S]*?<xr:Property>Module<\/xr:Property>[\s\S]*?<xr:State>Extended<\/xr:State>[\s\S]*?<\/xr:PropertyState>/u);
      await fs.rm(path.join(source, 'CommonModules', ADOPTED_COMMON_MODULE, 'Ext', 'Module.bsl'));
      await fs.writeFile(sourceDescriptorPath, sourceDescriptor.replace(/<xr:PropertyState>[\s\S]*?<\/xr:PropertyState>/u, ''), 'utf8');
      const sourceBefore = await hashDirectory(source);
      const targetBefore = await fs.readFile(path.join(target, 'CommonModules', `${ADOPTED_COMMON_MODULE}.xml`));
      const targetUuid = metadataUuid(targetBefore.toString('utf8'), 'CommonModule');

      const compare = await openNativeCompare(tempRoot, target, source, { right: target });
      try {
        const adoptedId = mergeableObjectId(compare.result, `CommonModule.${ADOPTED_COMMON_MODULE}`);
        const preview = await createPreview(compare.result, [adoptedId]);
        await approveAndExecute(compare.result, preview.previewId);

        const written = await fs.readFile(path.join(target, 'CommonModules', `${ADOPTED_COMMON_MODULE}.xml`), 'utf8');
        assert.strictEqual(metadataUuid(written, 'CommonModule'), targetUuid);
        assert.strictEqual(metadataTag(written, 'Comment'), 'Incoming CFE adopted CommonModule');
        assert.strictEqual(await hashDirectory(source), sourceBefore, 'CFE-B source changed during metadata overlay');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE-B→CFE-A transfers adopted interceptor and own module in one approved batch', async () => {
    await withNativeSandbox(async (tempRoot) => {
      const base = await copyFixture(tempRoot, 'base', 'base');
      const target = await copyFixture(tempRoot, 'extensionA', 'target-extension-a');
      const source = await copyFixture(tempRoot, 'extensionB', 'source-extension-b');
      const baseBefore = await hashDirectory(base);
      const sourceBefore = await hashDirectory(source);
      const targetRootUuid = configurationUuid(await readFile(target, 'Configuration.xml'));
      const baseAdoptedUuid = metadataUuid(await readMetadataObject(base, 'CommonModules', ADOPTED_COMMON_MODULE), 'CommonModule');
      const sourceAdopted = await readMetadataObject(source, 'CommonModules', ADOPTED_COMMON_MODULE);
      const sourceAdoptedUuid = metadataUuid(sourceAdopted, 'CommonModule');
      const adoptedBytes = await fs.readFile(path.join(source, 'CommonModules', ADOPTED_COMMON_MODULE, 'Ext', 'Module.bsl'));
      const ownDescriptorBytes = await fs.readFile(path.join(source, 'CommonModules', `${OWN_COMMON_MODULE}.xml`));
      const ownModuleBytes = await fs.readFile(path.join(source, 'CommonModules', OWN_COMMON_MODULE, 'Ext', 'Module.bsl'));

      const compare = await openNativeCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const adoptedId = mergeableObjectId(compare.result, `CommonModule.${ADOPTED_COMMON_MODULE}`);
        const ownId = mergeableObjectId(compare.result, `CommonModule.${OWN_COMMON_MODULE}`);
        const preview = await createPreview(compare.result, [adoptedId, ownId]);
        assert.ok(preview.items.some((item) => item.previewPath === `CommonModules/${ADOPTED_COMMON_MODULE}.xml`));
        assert.ok(preview.items.some((item) => item.previewPath === `CommonModules/${ADOPTED_COMMON_MODULE}/Ext/Module.bsl`));
        assert.ok(preview.items.some((item) => item.previewPath === `CommonModules/${OWN_COMMON_MODULE}.xml`));
        assert.ok(preview.items.some((item) => item.previewPath === `CommonModules/${OWN_COMMON_MODULE}/Ext/Module.bsl`));
        await approveAndExecute(compare.result, preview.previewId);

        const targetConfiguration = await readFile(target, 'Configuration.xml');
        const writtenAdopted = await readMetadataObject(target, 'CommonModules', ADOPTED_COMMON_MODULE);
        assert.strictEqual(configurationUuid(targetConfiguration), targetRootUuid);
        assert.strictEqual(metadataUuid(writtenAdopted, 'CommonModule'), sourceAdoptedUuid);
        assert.strictEqual(metadataTag(writtenAdopted, 'ExtendedConfigurationObject'), baseAdoptedUuid);
        assert.match(writtenAdopted, /<xr:PropertyState>[\s\S]*?<xr:Property>Module<\/xr:Property>[\s\S]*?<xr:State>Extended<\/xr:State>[\s\S]*?<\/xr:PropertyState>/u);
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'CommonModules', ADOPTED_COMMON_MODULE, 'Ext', 'Module.bsl')), adoptedBytes);
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'CommonModules', `${OWN_COMMON_MODULE}.xml`)), ownDescriptorBytes);
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'CommonModules', OWN_COMMON_MODULE, 'Ext', 'Module.bsl')), ownModuleBytes);
        assert.strictEqual((targetConfiguration.match(/<CommonModule>тестМодуль<\/CommonModule>/gu) ?? []).length, 1);
        assert.strictEqual((targetConfiguration.match(/<CommonModule>T336_Feature<\/CommonModule>/gu) ?? []).length, 1);
        assert.strictEqual(await hashDirectory(base), baseBefore, 'native base source changed');
        assert.strictEqual(await hashDirectory(source), sourceBefore, 'CFE-B source changed during batch transfer');
      } finally {
        await compare.dispose();
      }
    });
  });
});

async function openNativeCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  extensionBaseRoots: ConfigurationCompareInput['extensionBaseRoots'],
): Promise<{ result: ConfigurationCompareResult; dispose(): Promise<void> }> {
  const runtime = await createMergeMutationTestRuntime(leftRootPath);
  try {
    const result = await buildConfigurationCompare({
      leftRootPath,
      rightRootPath,
      backupRootPath: path.join(tempRoot, 'backups'),
      extensionBaseRoots,
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
    });
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

async function withNativeSandbox(callback: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await createExtensionCompareTempRoot('issue336-native-compare-');
  try {
    await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function copyFixture(tempRoot: string, fixtureName: keyof typeof FIXTURES, destinationName: string): Promise<string> {
  const source = FIXTURES[fixtureName];
  const destination = path.join(tempRoot, destinationName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  return destination;
}

function mergeableObjectId(result: ConfigurationCompareResult, label: string): string {
  const node = objectNode(result, label);
  const mergeableNodeIds = result.workspace.listMergeableNodeIds();
  assert.ok(mergeableNodeIds.includes(node.id), `${label} is not mergeable: ${JSON.stringify({
    node: { id: node.id, mergeable: node.mergeable, mergeState: node.mergeState, conflict: node.conflict },
    messages: result.session.state.messages,
  })}`);
  return node.id;
}

function objectId(result: ConfigurationCompareResult, label: string): string {
  return objectNode(result, label).id;
}

function objectNode(result: ConfigurationCompareResult, label: string): CompareTreeNode {
  const matches = collectNodes(result.projection.root).filter((node) => node.label === label);
  assert.strictEqual(matches.length, 1, `Expected one ${label} row, found ${matches.length}`);
  return matches[0]!;
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

async function createPreview(
  result: ConfigurationCompareResult,
  nodeIds: readonly string[],
): Promise<Extract<Awaited<ReturnType<ConfigurationCompareResult['workspace']['createPreviewForNodeIds']>>, { ok: true }>['preview']> {
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  if (!created.ok) {
    assert.fail(`Preview failed: ${JSON.stringify(created.diagnostics)}`);
  }
  return created.preview;
}

async function approveAndExecute(result: ConfigurationCompareResult, previewId: string): Promise<void> {
  const approved = result.workspace.approvePreview(previewId);
  assert.strictEqual(approved.ok, true, `Preview approval failed: ${JSON.stringify(approved.diagnostics)}`);
  const executed = await result.workspace.executeApprovedPreview(previewId, { destructiveConfirmed: true });
  assert.strictEqual(executed.ok, true, `Preview execution failed: ${JSON.stringify(executed.diagnostics)}`);
}

async function hashDirectory(rootPath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Unexpected symbolic link in native fixture: ${fullPath}`);
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        hash.update(path.relative(rootPath, fullPath).replace(/\\/gu, '/'));
        hash.update('\0');
        hash.update(await fs.readFile(fullPath));
        hash.update('\n');
      }
    }
  };
  await visit(rootPath);
  return hash.digest('hex');
}

async function readFile(rootPath: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(rootPath, relativePath), 'utf8');
}

async function readMetadataObject(rootPath: string, folder: string, name: string): Promise<string> {
  return readFile(rootPath, path.join(folder, `${name}.xml`));
}

function configurationUuid(xml: string): string {
  const match = /<Configuration\b[^>]*\buuid=["']([^"']+)["']/u.exec(xml);
  assert.ok(match, 'Configuration.xml has no root UUID');
  return match[1]!;
}

function metadataUuid(xml: string, type: string): string {
  const match = new RegExp(`<${type}\\b[^>]*\\buuid=["']([^"']+)["']`, 'u').exec(xml);
  assert.ok(match, `${type} descriptor has no UUID`);
  return match[1]!;
}

function metadataTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?\\s*>([\\s\\S]*?)<\\/${tag}>`, 'u').exec(xml);
  assert.ok(match, `Metadata descriptor has no ${tag} element`);
  return match[1]!.trim();
}
