import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildConfigurationCompare, type ConfigurationCompareResult } from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { captureMergePath } from '../../../src/compareMerge/merge/mergeSnapshot';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';
import {
  createExtensionCompareTempRoot,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const CONFIGURATION_UUID = '11111111-1111-4111-8111-111111111111';
const BASE_ROLE_UUID = '22222222-2222-4222-8222-222222222222';
const TARGET_ROLE_UUID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ROLE_UUID = '44444444-4444-4444-8444-444444444444';
const RIGHTS_PATH = path.join('Roles', 'Sales', 'Ext', 'Rights.xml');

suite('Adopted Role Rights whole-transfer guard', () => {
  test('blocks a same-base CFE whole-row copy when Rights.xml exists only on the incoming Role', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target')]);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source', true)]);
      await writeCompareBytes(source, RIGHTS_PATH, rightsXml());

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the whole-row action is otherwise available');
        assert.strictEqual(await exists(path.join(target, RIGHTS_PATH)), false, 'fixture has an incoming-only Rights.xml');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'incoming-only adopted Role Rights.xml must not bypass the read-only semantic row');
        assert.strictEqual(await exists(path.join(target, RIGHTS_PATH)), false, 'a rejected preview must not materialize the source-only sidecar');
        assert.ok((await fs.readFile(path.join(source, RIGHTS_PATH))).equals(Buffer.from(rightsXml())), 'the incoming sidecar remains unchanged');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks creating a previously absent adopted Role with Rights.xml by whole-row copy', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, []);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source', true)]);
      await writeCompareBytes(source, RIGHTS_PATH, rightsXml());

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the new adopted Role row is otherwise transferable');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'an incoming adopted identity is sufficient even when the target Role does not exist');
        assert.strictEqual(await exists(path.join(target, 'Roles', 'Sales.xml')), false, 'a rejected preview must not create the Role descriptor');
        assert.strictEqual(await exists(path.join(target, RIGHTS_PATH)), false, 'a rejected preview must not create Rights.xml');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks target-only Rights.xml when the incoming whole-row copy removes Rights=Extended', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target', true)]);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source')]);
      await writeCompareBytes(target, RIGHTS_PATH, rightsXml());
      const targetRightsBefore = await fs.readFile(path.join(target, RIGHTS_PATH));
      const targetDescriptorBefore = await fs.readFile(path.join(target, 'Roles', 'Sales.xml'));

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the whole-row action is otherwise available');
        const incomingDescriptor = await fs.readFile(path.join(source, 'Roles', 'Sales.xml'), 'utf8');
        assert.doesNotMatch(incomingDescriptor, /<xr:Property>Rights<\/xr:Property>/u, 'fixture removes the Rights extension marker');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'target-only Rights.xml and marker removal must be surfaced before output building');
        assert.ok((await fs.readFile(path.join(target, RIGHTS_PATH))).equals(targetRightsBefore), 'target Rights.xml remains untouched');
        assert.ok((await fs.readFile(path.join(target, 'Roles', 'Sales.xml'))).equals(targetDescriptorBefore), 'target descriptor remains untouched');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a canonical incoming Rights.xml with a foreign root namespace', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target')]);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source')]);
      await writeCompareBytes(source, RIGHTS_PATH, '<Rights xmlns="urn:foreign" version="2.20"><Right/></Rights>');

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the whole-row action is otherwise available');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'a canonical Rights.xml with a foreign XML root must not be copied raw');
        if (!created.ok) {
          const diagnostic = created.diagnostics.find((item) => item.code === 'EXTENSION_TRANSFER_BLOCKED' && item.nodeId === row.id);
          assert.ok(/структура/iu.test(diagnostic?.suggestedAction ?? ''), 'the reason should explain that its XML structure is unconfirmed');
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a malformed target-only canonical Rights.xml before descriptor replacement', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target', true)]);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source')]);
      const malformed = '<!-- an unterminated comment before the root';
      await writeCompareBytes(target, RIGHTS_PATH, malformed);
      const targetDescriptorBefore = await fs.readFile(path.join(target, 'Roles', 'Sales.xml'));

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'a malformed target-only canonical Rights.xml must not be deleted by descriptor replacement');
        assert.ok((await fs.readFile(path.join(target, RIGHTS_PATH))).equals(Buffer.from(malformed)), 'the malformed reserved file remains untouched');
        assert.ok((await fs.readFile(path.join(target, 'Roles', 'Sales.xml'))).equals(targetDescriptorBefore), 'the descriptor remains untouched');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks valid Rights.xml when its leading comment puts the root beyond the 64 KiB probe', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target')]);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source')]);
      const content = rightsXmlWithOversizedLeadingComment();
      await writeCompareBytes(source, RIGHTS_PATH, content);
      const snapshot = await captureMergePath(path.join(source, RIGHTS_PATH), { retainContent: false, probeXmlRootNames: true });
      assert.strictEqual(snapshot.state, 'file');
      if (snapshot.state === 'file') {
        assert.strictEqual(snapshot.rootExpandedName, undefined, 'the captured root probe is bounded to the first 64 KiB');
      }

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'an unprobed canonical Rights.xml must not be copied raw');
        if (!created.ok) {
          const diagnostic = created.diagnostics.find((item) => item.code === 'EXTENSION_TRANSFER_BLOCKED' && item.nodeId === row.id);
          assert.ok(/структура/iu.test(diagnostic?.suggestedAction ?? ''), 'the reason should explain that its XML structure is unconfirmed');
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('does not reserve a Rights.xml basename outside the canonical Role sidecar path', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target')]);
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'source')]);
      const otherRightsPath = path.join('Roles', 'Sales', 'Ext', 'Other', 'Rights.xml');
      await writeCompareBytes(source, otherRightsPath, rightsXml());

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assert.strictEqual(created.ok, true, created.ok ? '' : JSON.stringify(created.diagnostics));
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a CF-to-CFE whole-row overlay when the adopted target Role owns Rights.xml', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'extension comment')]);
      await writeCompareBytes(target, RIGHTS_PATH, rightsXml());

      // The incoming CF is the exact same captured base. This selects the existing
      // overlay-adopted whole-row route while leaving the Rights sidecar on the CFE.
      const compare = await openCompare(tempRoot, target, base, { left: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the whole-row overlay is otherwise available');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'the CF↔CFE overlay route must apply the same adopted Role boundary');
        assert.ok((await fs.readFile(path.join(target, RIGHTS_PATH))).equals(Buffer.from(rightsXml())), 'the CFE Rights sidecar remains untouched');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a CF own Rights.xml when the paired CFE target Role is adopted', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      await writeBaseRole(base, 'base');
      await writeCompareBytes(base, RIGHTS_PATH, rightsXml());
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'extension comment')]);

      const compare = await openCompare(tempRoot, target, base, { left: base });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the CF→CFE overlay is otherwise available');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'an adopted identity on target must guard the exact Role Rights artifact on source');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks target CF own Rights.xml when the paired incoming CFE Role is adopted', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(target, 'base');
      await writeCompareBytes(target, RIGHTS_PATH, rightsXml());
      await writeCfe(source, [adoptedRole(SOURCE_ROLE_UUID, 'extension comment')]);

      const compare = await openCompare(tempRoot, target, source, { right: target });
      try {
        const row = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(row.mergeable, true, 'the CFE→CF overlay is otherwise available');
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assertWholeTransferBlocked(created, row.id, 'an adopted identity on source must guard the exact Role Rights artifact on target');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps an own Role full-copy with a Rights.xml sidecar available', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeCfe(target, []);
      await writeCfe(source, [ownRole('Ext_Sales', SOURCE_ROLE_UUID, 'incoming')]);
      const ownRightsPath = path.join('Roles', 'Ext_Sales', 'Ext', 'Rights.xml');
      await writeCompareBytes(source, ownRightsPath, rightsXml());

      const compare = await openCompare(tempRoot, target, source);
      try {
        const row = roleRow(compare.result, 'Role.Ext_Sales');
        assert.strictEqual(row.mergeable, true, row.mergeState?.reason);
        const created = await compare.result.workspace.createPreviewForNodeIds([row.id]);
        assert.strictEqual(created.ok, true, created.ok ? '' : JSON.stringify(created.diagnostics));
        if (created.ok) {
          assert.ok(created.preview.items.some((item) => item.previewPath?.replace(/\\/gu, '/') === 'Roles/Ext_Sales/Ext/Rights.xml'),
            'the own Role full-copy still includes its captured Rights.xml');
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps an unrelated own row selectable when another adopted Role has Rights.xml', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeBaseRole(base, 'base');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'target')]);
      await writeCfe(source, [
        adoptedRole(SOURCE_ROLE_UUID, 'source'),
        { type: 'Catalog', name: 'Ext_Data', uuid: '55555555-5555-4555-8555-555555555555', belonging: 'Own', propertiesXml: '<Comment>incoming</Comment>' },
      ]);
      await writeCompareBytes(target, RIGHTS_PATH, rightsXml());

      const compare = await openCompare(tempRoot, target, source, { left: base, right: base });
      try {
        const role = roleRow(compare.result, 'Role.Sales');
        assert.strictEqual(role.mergeable, true, 'the adopted Role is present and independently selectable');
        const catalog = roleRow(compare.result, 'Catalog.Ext_Data');
        assert.strictEqual(catalog.mergeable, true, catalog.mergeState?.reason);
        const created = await compare.result.workspace.createPreviewForNodeIds([catalog.id]);
        assert.strictEqual(created.ok, true, created.ok ? '' : JSON.stringify(created.diagnostics));
        if (created.ok) {
          assert.ok(created.preview.items.some((item) => item.previewPath?.replace(/\\/gu, '/') === 'Catalogs/Ext_Data.xml'));
          assert.ok(!created.preview.items.some((item) => item.previewPath?.replace(/\\/gu, '/') === RIGHTS_PATH.replace(/\\/gu, '/')),
            'the unrelated selection does not include the adopted Role sidecar');
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps an unrelated semantic property selectable while the adopted Role Rights sidecar is blocked', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const current = path.join(tempRoot, 'current-cf');
      const target = path.join(tempRoot, 'target-cfe');
      await writeBaseRole(base, 'base', '<Synonym>base</Synonym>');
      await writeBaseRole(current, 'base', '<Synonym>incoming</Synonym>');
      await writeCfe(target, [adoptedRole(TARGET_ROLE_UUID, 'base', true, '<Synonym>base</Synonym>')]);
      await writeCompareBytes(target, RIGHTS_PATH, rightsXml());

      const compare = await openCompare(tempRoot, target, current, { left: base });
      try {
        const role = roleRow(compare.result, 'Role.Sales');
        const synonym = collectNodes(role).find((node) => node.kind === 'xmlProperty'
          && node.label.toLocaleLowerCase('en-US').includes('synonym')
          && node.rightValue?.includes('incoming'));
        assert.ok(synonym, `the independent semantic property should be projected: ${JSON.stringify(collectNodes(role).map((node) => ({ label: node.label, kind: node.kind, value: node.rightValue, mergeable: node.mergeable, reason: node.mergeState?.reason })))}`);
        assert.strictEqual(synonym!.mergeable, true, synonym!.mergeState?.reason ?? synonym!.conflict?.message);
        const created = await compare.result.workspace.createPreviewForNodeIds([synonym!.id]);
        assert.strictEqual(created.ok, true, created.ok ? '' : JSON.stringify(created.diagnostics));
      } finally {
        await compare.dispose();
      }
    });
  });
});

function adoptedRole(uuid: string, comment: string, rightsExtended = false, extraProperties = ''): ExtensionCompareObjectFixture {
  return {
    type: 'Role',
    name: 'Sales',
    uuid,
    belonging: 'Adopted',
    anchorUuid: BASE_ROLE_UUID,
    descriptorXml: roleDescriptor('Sales', uuid, comment, BASE_ROLE_UUID, rightsExtended, extraProperties),
  };
}

function ownRole(name: string, uuid: string, comment: string): ExtensionCompareObjectFixture {
  return {
    type: 'Role',
    name,
    uuid,
    descriptorXml: roleDescriptor(name, uuid, comment),
  };
}

async function writeBaseRole(root: string, comment: string, extraProperties = ''): Promise<void> {
  await writeDesignerConfiguration(root, {
    uuid: CONFIGURATION_UUID,
    name: 'Shared configuration',
    objects: [{
      type: 'Role',
      name: 'Sales',
      uuid: BASE_ROLE_UUID,
      descriptorXml: roleDescriptor('Sales', BASE_ROLE_UUID, comment, undefined, false, extraProperties),
    }],
  });
}

async function writeCfe(root: string, objects: readonly ExtensionCompareObjectFixture[]): Promise<void> {
  await writeDesignerConfiguration(root, {
    uuid: CONFIGURATION_UUID,
    name: 'Shared configuration',
    purpose: 'Customization',
    namePrefix: 'Ext_',
    objects,
  });
}

function roleDescriptor(
  name: string,
  uuid: string,
  comment: string,
  sourceUuid?: string,
  rightsExtended = false,
  extraProperties = '',
): string {
  const ownership = sourceUuid
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject>`
    : '';
  const rightsState = rightsExtended
    ? '<xr:PropertyState><xr:Property>Rights</xr:Property><xr:State>Extended</xr:State></xr:PropertyState>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20">` +
    `<Role uuid="${uuid}"><InternalInfo>${rightsState}</InternalInfo><Properties><Name>${name}</Name>${ownership}<Comment>${comment}</Comment>${extraProperties}</Properties></Role></MetaDataObject>`;
}

function rightsXml(): string {
  return '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">' +
    '<setForNewObjects>true</setForNewObjects><setForAttributesByDefault>true</setForAttributesByDefault>' +
    '<independentRightsOfChildObjects>false</independentRightsOfChildObjects></Rights>';
}

function rightsXmlWithOversizedLeadingComment(): string {
  return `<!--${'x'.repeat(64 * 1024)}-->${rightsXml()}`;
}

async function openCompare(
  tempRoot: string,
  targetRoot: string,
  incomingRoot: string,
  extensionBaseRoots?: { left?: string; right?: string },
): Promise<{ result: ConfigurationCompareResult; dispose(): Promise<void> }> {
  const runtime = await createMergeMutationTestRuntime(targetRoot);
  try {
    const result = await buildConfigurationCompare({
      leftRootPath: targetRoot,
      rightRootPath: incomingRoot,
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

function roleRow(result: ConfigurationCompareResult, qualifiedName: string): CompareTreeNode {
  const row = collectNodes(result.projection.root).find((node) => node.kind === 'extensionMetadataObject' && node.label === qualifiedName);
  assert.ok(row, `Missing public transfer row ${qualifiedName}`);
  return row!;
}

function collectNodes(node: CompareTreeNode): CompareTreeNode[] {
  return [node, ...node.children.flatMap(collectNodes)];
}

function assertWholeTransferBlocked(
  created: Awaited<ReturnType<ConfigurationCompareResult['workspace']['createPreviewForNodeIds']>>,
  rowId: string,
  message: string,
): void {
  assert.strictEqual(created.ok, false, `${message}; actual=${JSON.stringify(created)}`);
  if (created.ok) {return;}
  assert.ok(created.diagnostics.some((item) => item.code === 'EXTENSION_TRANSFER_BLOCKED' && item.nodeId === rowId),
    `${message}; expected a row-scoped extension diagnostic, got ${JSON.stringify(created.diagnostics)}`);
  const diagnostic = created.diagnostics.find((item) => item.code === 'EXTENSION_TRANSFER_BLOCKED' && item.nodeId === rowId);
  assert.ok(diagnostic?.suggestedAction?.includes('Rights.xml'), 'the UI diagnostic should name the protected Designer sidecar');
  assert.ok(diagnostic?.suggestedAction?.includes('базовой роли'), 'the UI diagnostic should explain the ownership conversion that is missing');
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue335-role-rights-whole-transfer-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
