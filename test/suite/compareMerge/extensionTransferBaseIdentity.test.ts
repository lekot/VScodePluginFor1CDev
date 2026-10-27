import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';
import {
  createExtensionCompareTempRoot,
  pathExists,
  readUtf8,
  writeCompareBytes,
  writeDesignerConfiguration,
} from '../../helpers/extensionCompareFixtures';

const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const SOURCE_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_UUID = '33333333-3333-4333-8333-333333333333';
const TARGET_LOCAL_UUID = '44444444-4444-4444-8444-444444444444';

suite('Extension transfer known-base identity guards', () => {
  test('blocks an unrelated CF own object whose qualified name is occupied in the known target base', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cf');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: BASE_UUID }],
      });
      await writeDesignerConfiguration(target, { purpose: 'Customization', namePrefix: 'Ext_' });
      await writeDesignerConfiguration(source, {
        objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: SOURCE_UUID }],
      });

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        assertObjectBlocked(compare.result, 'same qualified name in target base must block foreign own copy');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a foreign own object from another CFE when the known target base owns its qualified name', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: BASE_UUID }],
      });
      await writeDesignerConfiguration(target, { purpose: 'Customization', namePrefix: 'Ext_' });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: SOURCE_UUID, belonging: 'Own' }],
      });

      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        assertObjectBlocked(compare.result, 'foreign CFE own object must not replace a same-name base object');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a base UUID collision even when the own source uses a different qualified name', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cf');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'BaseItem', uuid: BASE_UUID }],
      });
      await writeDesignerConfiguration(target, { purpose: 'Customization', namePrefix: 'Ext_' });
      await writeDesignerConfiguration(source, {
        objects: [{ type: 'Catalog', name: 'Ext_New', uuid: BASE_UUID }],
      });

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        assertObjectBlocked(compare.result, 'reusing a target-base UUID under another name must block own copy');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('allows an unrelated own object when its qualified name and UUID are absent from the known base', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cf');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'BaseItem', uuid: BASE_UUID }],
      });
      await writeDesignerConfiguration(target, { purpose: 'Customization', namePrefix: 'Ext_' });
      await writeDesignerConfiguration(source, {
        objects: [{ type: 'Catalog', name: 'Ext_New', uuid: SOURCE_UUID }],
      });

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        assert.strictEqual(compare.result.workspace.listMergeableNodeIds().length, 1,
          'a known base with no same-name or same-UUID object must retain own-copy support');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps proven base borrowing and adopted-target updates available', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const borrowedTarget = path.join(tempRoot, 'borrowed-target-cfe');
      const adoptedTarget = path.join(tempRoot, 'adopted-target-cfe');
      await writeDesignerConfiguration(base, {
        objects: [{
          type: 'Catalog', name: 'BaseItem', uuid: BASE_UUID,
          propertiesXml: '<Comment>source base version</Comment>',
        }],
      });
      await writeDesignerConfiguration(borrowedTarget, { purpose: 'Customization', namePrefix: 'Ext_' });
      await writeDesignerConfiguration(adoptedTarget, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{
          type: 'Catalog',
          name: 'BaseItem',
          uuid: TARGET_LOCAL_UUID,
          belonging: 'Adopted',
          anchorUuid: BASE_UUID,
          propertiesXml: '<Comment>existing adopted target</Comment>',
        }],
      });

      const borrowed = await openCompare(tempRoot, borrowedTarget, base, { extensionBaseRoots: { left: base } });
      try {
        assert.strictEqual(borrowed.result.workspace.listMergeableNodeIds().length, 1,
          'a proven own base object remains borrowable');
      } finally {
        await borrowed.dispose();
      }

      const adopted = await openCompare(tempRoot, adoptedTarget, base, { extensionBaseRoots: { left: base } });
      try {
        assert.strictEqual(adopted.result.workspace.listMergeableNodeIds().length, 1,
          'an adopted target proven against the same base remains overlayable');
      } finally {
        await adopted.dispose();
      }
    });
  });

  test('invalidates own-copy execution when a known target-base registration appears after preview', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cf');
      await writeDesignerConfiguration(base);
      await writeDesignerConfiguration(target, { purpose: 'Customization', namePrefix: 'Ext_' });
      await writeDesignerConfiguration(source, {
        objects: [{ type: 'Catalog', name: 'Ext_New', uuid: SOURCE_UUID }],
      });

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base },
      });
      try {
        const nodeIds = compare.result.workspace.listMergeableNodeIds();
        assert.strictEqual(nodeIds.length, 1, 'the base initially proves no conflicting registration');
        const created = await compare.result.workspace.createPreviewForNodeIds(nodeIds);
        assert.strictEqual(created.ok, true, created.ok ? '' : JSON.stringify(created.diagnostics));
        if (!created.ok) {
          return;
        }
        const targetConfigurationBefore = await readUtf8(target, 'Configuration.xml');
        const baseConfiguration = await readUtf8(base, 'Configuration.xml');
        const changedBaseConfiguration = baseConfiguration.replace('</ChildObjects>', '<Catalog>Ext_New</Catalog></ChildObjects>');
        assert.notStrictEqual(changedBaseConfiguration, baseConfiguration, 'the fixture must add a base registration');
        await writeCompareBytes(base, 'Configuration.xml', changedBaseConfiguration);

        const approved = compare.result.workspace.approvePreview(created.preview.previewId);
        assert.strictEqual(approved.ok, true, 'approval may capture the preview before source-witness validation');
        const executed = await compare.result.workspace.executeApprovedPreview(created.preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, false, 'a changed known target base must invalidate the own-copy preview');
        assert.strictEqual(await readUtf8(target, 'Configuration.xml'), targetConfigurationBefore,
          'failed base CAS must leave target registrations unchanged');
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Ext_New.xml')), false,
          'failed base CAS must leave the descriptor unwritten');
      } finally {
        await compare.dispose();
      }
    });
  });
});

interface OpenCompareOptions extends Pick<ConfigurationCompareInput, 'extensionBaseRoots'> {
  readonly withRuntime?: boolean;
}

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
  const runtime = options.withRuntime ? await createMergeMutationTestRuntime(leftRootPath) : undefined;
  try {
    const result = await buildConfigurationCompare({
      leftRootPath,
      rightRootPath,
      backupRootPath: path.join(tempRoot, 'backups'),
      extensionBaseRoots: options.extensionBaseRoots,
      mutationEngine: runtime?.engine,
      configurationId: runtime?.configurationId,
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
        await runtime?.coordinator.dispose();
      },
    };
  } catch (error) {
    await runtime?.coordinator.dispose();
    throw error;
  }
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue336-base-identity-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function assertObjectBlocked(result: ConfigurationCompareResult, context: string): void {
  assert.strictEqual(result.workspace.listMergeableNodeIds().length, 0, context);
  const blockedRows = collectNodes(result.projection.root).filter((node) => (
    node.mergeable === false
    && (node.mergeState?.state === 'blocked' || node.mergeState?.state === 'identityConflict')
  ));
  assert.ok(blockedRows.length > 0 || result.session.state.messages.some((message) => message.blocking),
    `${context}: the rejection should be visible as a blocking diagnostic`);
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}
