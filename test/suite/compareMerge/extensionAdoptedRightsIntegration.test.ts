import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  createExtensionCompareTempRoot,
  pathExists,
  readUtf8,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const MD = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE = 'http://v8.1c.ru/8.3/xcf/readable';
const ROLE_RIGHTS = 'http://v8.1c.ru/8.2/roles';
const ROLE_UUID = '22222222-2222-4222-8222-222222222222';
const ROLE_TARGET_UUID = '33333333-3333-4333-8333-333333333333';
const ROLE_SOURCE_UUID = '44444444-4444-4444-8444-444444444444';
const CATALOG_UUID = '55555555-5555-4555-8555-555555555555';
const CATALOG_TARGET_UUID = '66666666-6666-4666-8666-666666666666';
const CATALOG_SOURCE_UUID = '77777777-7777-4777-8777-777777777777';
const OWN_CATALOG_UUID = '88888888-8888-4888-8888-888888888888';

suite('Public adopted Rights integration (#335)', () => {
  test('CFE→CFE exposes an inherited selected right through compare, preview, approval, and execution', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const paths = {
        target: path.join(tempRoot, 'target-cfe'),
        source: path.join(tempRoot, 'source-cfe'),
        targetBase: path.join(tempRoot, 'target-base-cf'),
        sourceBase: path.join(tempRoot, 'source-base-cf'),
      };
      const baseRole: ExtensionCompareObjectFixture = { type: 'Role', name: 'Ext_Role', uuid: ROLE_UUID };
      const targetRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        uuid: ROLE_TARGET_UUID,
        belonging: 'Adopted',
        anchorUuid: ROLE_UUID,
        descriptorXml: roleDescriptor(ROLE_TARGET_UUID, true, true),
      };
      const sourceRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        uuid: ROLE_SOURCE_UUID,
        belonging: 'Adopted',
        anchorUuid: ROLE_UUID,
        descriptorXml: roleDescriptor(ROLE_SOURCE_UUID, true, false),
      };
      const baseCatalog: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: CATALOG_UUID };
      const targetCatalog: ExtensionCompareObjectFixture = {
        ...baseCatalog, uuid: CATALOG_TARGET_UUID, belonging: 'Adopted', anchorUuid: CATALOG_UUID,
      };
      const sourceCatalog: ExtensionCompareObjectFixture = {
        ...baseCatalog, uuid: CATALOG_SOURCE_UUID, belonging: 'Adopted', anchorUuid: CATALOG_UUID,
      };

      await writeAdoptedConfiguration(paths.targetBase, [baseRole, baseCatalog]);
      await writeAdoptedConfiguration(paths.sourceBase, [baseRole, baseCatalog]);
      await writeAdoptedConfiguration(paths.target, [targetRole, targetCatalog], true);
      await writeAdoptedConfiguration(paths.source, [sourceRole, sourceCatalog], true);
      await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Roles/Ext_Role.xml'), path.join(paths.sourceBase, 'Roles/Ext_Role.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
      await fs.copyFile(path.join(paths.target, 'Configuration.xml'), path.join(paths.source, 'Configuration.xml'));
      await writeCompareBytes(paths.target, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));
      await writeCompareBytes(paths.sourceBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));
      await writeCompareBytes(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));

      const runtimeCompare = await compareWithRuntime(tempRoot, paths.target, paths.source, {
        extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
      });
      try {
        const role = findRole(runtimeCompare.result, 'Role.Ext_Role');
        const right = collectNodes(role).find((node) => node.kind === 'xmlProperty'
          && node.payloadRef && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-object=catalog.products')
          && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-right=read'));
        assert.ok(right?.mergeable, `the effective Read change should be selectable: ${JSON.stringify(describeNodes(collectNodes(role)))}`);
        if (!right) {return;}
        const preview = await createPreview(runtimeCompare.result, [right.id]);
        assert.strictEqual(runtimeCompare.result.workspace.approvePreview(preview.previewId).ok, true);
        const executed = await runtimeCompare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
        const targetRights = await readUtf8(paths.target, 'Roles/Ext_Role/Ext/Rights.xml');
        assert.doesNotMatch(targetRights, /<right><name>Read<\/name><value>[^<]*<\/value>/u,
          'returning the target to the base allow must remove its explicit deny override');
        assert.match(await readUtf8(paths.target, 'Roles/Ext_Role.xml'), /<xr:Property>Rights<\/xr:Property><xr:State>Extended<\/xr:State>/u);
        assert.strictEqual(await pathExists(path.join(paths.source, 'Roles/Ext_Role/Ext/Rights.xml')), false,
          'the adopted source inherits Rights and stays physically unchanged');
      } finally {
        await runtimeCompare.dispose();
      }
    });
  });

  test('a selected CFE Rights change cannot rely on a declaration present only in its proven CF base', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const paths = {
        target: path.join(tempRoot, 'target-cfe'),
        source: path.join(tempRoot, 'source-cfe'),
        targetBase: path.join(tempRoot, 'target-base-cf'),
        sourceBase: path.join(tempRoot, 'source-base-cf'),
      };
      const baseRole: ExtensionCompareObjectFixture = { type: 'Role', name: 'Ext_Role', uuid: ROLE_UUID };
      const targetRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        uuid: ROLE_TARGET_UUID,
        belonging: 'Adopted',
        anchorUuid: ROLE_UUID,
        descriptorXml: roleDescriptor(ROLE_TARGET_UUID, true, true),
      };
      const sourceRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        uuid: ROLE_SOURCE_UUID,
        belonging: 'Adopted',
        anchorUuid: ROLE_UUID,
        descriptorXml: roleDescriptor(ROLE_SOURCE_UUID, true, false),
      };
      const baseCatalog: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: CATALOG_UUID };
      await writeAdoptedConfiguration(paths.targetBase, [baseRole, baseCatalog]);
      await writeAdoptedConfiguration(paths.sourceBase, [baseRole, baseCatalog]);
      await writeAdoptedConfiguration(paths.target, [targetRole], true);
      await writeAdoptedConfiguration(paths.source, [sourceRole], true);
      await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Roles/Ext_Role.xml'), path.join(paths.sourceBase, 'Roles/Ext_Role.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
      await fs.copyFile(path.join(paths.target, 'Configuration.xml'), path.join(paths.source, 'Configuration.xml'));
      await writeCompareBytes(paths.target, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));
      await writeCompareBytes(paths.sourceBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));
      await writeCompareBytes(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));

      const runtimeCompare = await compareWithRuntime(tempRoot, paths.target, paths.source, {
        extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
      });
      try {
        const role = findRole(runtimeCompare.result, 'Role.Ext_Role');
        const right = collectNodes(role).find((node) => (node.kind === 'xmlProperty' || node.kind === 'roleRight')
          && node.payloadRef && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-object=catalog.products')
          && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-right=read'));
        assert.ok(right?.mergeable, `the Rights change should reach dependency validation: ${JSON.stringify(describeNodes(collectNodes(role)))}`);
        if (!right) {return;}
        const before = {
          descriptor: await fs.readFile(path.join(paths.target, 'Roles/Ext_Role.xml')),
          rights: await fs.readFile(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')),
          configuration: await fs.readFile(path.join(paths.target, 'Configuration.xml')),
        };
        const preview = await runtimeCompare.result.workspace.createPreviewForNodeIds([right.id]);
        assert.strictEqual(preview.ok, false, JSON.stringify(preview));
        assert.match(JSON.stringify(preview.diagnostics), /не объявлен физически в target CFE/u,
          'a proven base declaration cannot satisfy a selected CFE Rights reference');
        assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Roles/Ext_Role.xml')), before.descriptor);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')), before.rights);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Configuration.xml')), before.configuration);
      } finally {
        await runtimeCompare.dispose();
      }
    });
  });

  test('a selected validated CFE object output satisfies its Rights declaration while an unselected base reference stays harmless', async function (this: Mocha.Context) {
    this.timeout(180000);
    for (const selectPackage of [false, true]) {
      await withTempRoot(async (tempRoot) => {
        const paths = {
          target: path.join(tempRoot, 'target-cfe'),
          source: path.join(tempRoot, 'source-cfe'),
          targetBase: path.join(tempRoot, 'target-base-cf'),
          sourceBase: path.join(tempRoot, 'source-base-cf'),
        };
        const baseRole: ExtensionCompareObjectFixture = { type: 'Role', name: 'Ext_Role', uuid: ROLE_UUID };
        const targetRole: ExtensionCompareObjectFixture = {
          ...baseRole,
          uuid: ROLE_TARGET_UUID,
          belonging: 'Adopted',
          anchorUuid: ROLE_UUID,
          descriptorXml: roleDescriptor(ROLE_TARGET_UUID, true, true),
        };
        const sourceRole: ExtensionCompareObjectFixture = {
          ...baseRole,
          uuid: ROLE_SOURCE_UUID,
          belonging: 'Adopted',
          anchorUuid: ROLE_UUID,
          descriptorXml: roleDescriptor(ROLE_SOURCE_UUID, true, true),
        };
        const baseCatalog: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: CATALOG_UUID };
        const sourceOwnCatalog: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Ext_Products', uuid: OWN_CATALOG_UUID, belonging: 'Own',
        };
        await writeAdoptedConfiguration(paths.targetBase, [baseRole, baseCatalog]);
        await writeAdoptedConfiguration(paths.sourceBase, [baseRole, baseCatalog]);
        await writeAdoptedConfiguration(paths.target, [targetRole], true);
        await writeAdoptedConfiguration(paths.source, [sourceRole, sourceOwnCatalog], true);
        await writeCompareBytes(paths.target, 'Roles/Ext_Role/Ext/Rights.xml', rightsWithOwnCfeReference(false));
        await writeCompareBytes(paths.source, 'Roles/Ext_Role/Ext/Rights.xml', rightsWithOwnCfeReference(true));
        await writeCompareBytes(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));
        await writeCompareBytes(paths.sourceBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));

        const runtimeCompare = await compareWithRuntime(tempRoot, paths.target, paths.source, {
          extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
        });
        try {
          const role = findRole(runtimeCompare.result, 'Role.Ext_Role');
          const right = collectNodes(role).find((node) => (node.kind === 'xmlProperty' || node.kind === 'roleRight')
            && node.payloadRef && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-object=catalog.ext_products')
            && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-right=read'));
          assert.ok(right?.mergeable, `the Ext_Products Rights change should be selectable: ${JSON.stringify(describeNodes(collectNodes(role)))}`);
          if (!right) {return;}
          const ownCatalogRow = collectNodes(runtimeCompare.result.projection.root).find((node) =>
            node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Ext_Products',
          );
          assert.ok(ownCatalogRow?.mergeable, 'the incoming own CFE Catalog is an independently selected validated object output');
          const before = {
            configuration: await fs.readFile(path.join(paths.target, 'Configuration.xml')),
            rights: await fs.readFile(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')),
          };
          const selectedIds = selectPackage ? [right.id, ownCatalogRow!.id] : [right.id];
          const preview = await runtimeCompare.result.workspace.createPreviewForNodeIds(selectedIds);
          if (!selectPackage) {
            assert.strictEqual(preview.ok, false, JSON.stringify(preview));
            assert.match(JSON.stringify(preview.diagnostics), /не объявлен физически в target CFE/u);
            assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Configuration.xml')), before.configuration);
            assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')), before.rights);
            assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Ext_Products.xml')), false);
            return;
          }
          assert.strictEqual(preview.ok, true, JSON.stringify(preview));
          const approved = runtimeCompare.result.workspace.approvePreview(preview.preview.previewId);
          assert.strictEqual(approved.ok, true, JSON.stringify(approved));
          const executed = await runtimeCompare.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
          assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Ext_Products.xml')), true,
            'the selected descriptor output and registration must create the physical CFE declaration');
          const outputRights = await readUtf8(paths.target, 'Roles/Ext_Role/Ext/Rights.xml');
          assert.match(outputRights, /<name>Catalog\.Ext_Products<\/name>.*?<name>Read<\/name><value>true<\/value>/su);
          assert.match(outputRights, /<name>Catalog\.Products<\/name>.*?<name>Read<\/name><value>true<\/value>/su,
            'the unselected Products reference is present in output but resolves through its proven base');
        } finally {
          await runtimeCompare.dispose();
        }
      });
    }
  });

  test('a selected own CFE Catalog output satisfies a newly inserted adopted Rights object in the same preview', async function (this: Mocha.Context) {
    this.timeout(180000);
    for (const selectCatalog of [false, true]) {
      await withTempRoot(async (tempRoot) => {
        const paths = {
          target: path.join(tempRoot, 'target-cfe'),
          source: path.join(tempRoot, 'source-cfe'),
          targetBase: path.join(tempRoot, 'target-base-cf'),
          sourceBase: path.join(tempRoot, 'source-base-cf'),
        };
        const baseRole: ExtensionCompareObjectFixture = { type: 'Role', name: 'Ext_Role', uuid: ROLE_UUID };
        const targetRole: ExtensionCompareObjectFixture = {
          ...baseRole,
          uuid: ROLE_TARGET_UUID,
          belonging: 'Adopted',
          anchorUuid: ROLE_UUID,
          descriptorXml: roleDescriptor(ROLE_TARGET_UUID, true, false),
        };
        const sourceRole: ExtensionCompareObjectFixture = {
          ...baseRole,
          uuid: ROLE_SOURCE_UUID,
          belonging: 'Adopted',
          anchorUuid: ROLE_UUID,
          descriptorXml: roleDescriptor(ROLE_SOURCE_UUID, true, true),
        };
        const sourceOwnCatalog: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Ext_Products', uuid: OWN_CATALOG_UUID, belonging: 'Own',
        };
        await writeAdoptedConfiguration(paths.targetBase, [baseRole]);
        await writeAdoptedConfiguration(paths.sourceBase, [baseRole]);
        await writeAdoptedConfiguration(paths.target, [targetRole], true);
        await writeAdoptedConfiguration(paths.source, [sourceRole, sourceOwnCatalog], true);
        await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
        await fs.copyFile(path.join(paths.targetBase, 'Roles/Ext_Role.xml'), path.join(paths.sourceBase, 'Roles/Ext_Role.xml'));
        await writeCompareBytes(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsPolicyOnlyXml());
        await writeCompareBytes(paths.sourceBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsPolicyOnlyXml());
        await writeCompareBytes(paths.source, 'Roles/Ext_Role/Ext/Rights.xml', rightsWithOwnCfeObject());

        const runtimeCompare = await compareWithRuntime(tempRoot, paths.target, paths.source, {
          extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
        });
        try {
          const role = findRole(runtimeCompare.result, 'Role.Ext_Role');
          const rightsObject = collectNodes(role).find((node) => node.kind === 'roleRightsObject'
            && node.payloadRef && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-object=catalog.ext_products'));
          assert.ok(rightsObject?.mergeable,
            `the new whole Rights object should be a selected semantic candidate: ${JSON.stringify(describeNodes(collectNodes(role)))}`);
          if (!rightsObject) {return;}
          const ownCatalogRow = collectNodes(runtimeCompare.result.projection.root).find((node) =>
            node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Ext_Products',
          );
          assert.ok(ownCatalogRow?.mergeable,
            `the incoming own CFE Catalog is a separately validated full-copy output: ${JSON.stringify(describeNodes(collectNodes(runtimeCompare.result.projection.root)))}`);
          const before = {
            descriptor: await fs.readFile(path.join(paths.target, 'Roles/Ext_Role.xml')),
            configuration: await fs.readFile(path.join(paths.target, 'Configuration.xml')),
          };
          assert.strictEqual(await pathExists(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')), false,
            'the target begins without an adopted Rights file');
          assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Ext_Products.xml')), false,
            'the target begins without the referenced own Catalog');

          const selectedIds = selectCatalog ? [rightsObject.id, ownCatalogRow!.id] : [rightsObject.id];
          const preview = await runtimeCompare.result.workspace.createPreviewForNodeIds(selectedIds);
          if (!selectCatalog) {
            assert.strictEqual(preview.ok, false, JSON.stringify(preview));
            assert.match(JSON.stringify(preview.diagnostics), /Catalog\.Ext_Products.*отсутствует в целевой конфигурации/u);
            assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Roles/Ext_Role.xml')), before.descriptor);
            assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Configuration.xml')), before.configuration);
            assert.strictEqual(await pathExists(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')), false);
            assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Ext_Products.xml')), false);
            return;
          }

          assert.strictEqual(preview.ok, true, JSON.stringify(preview));
          const approved = runtimeCompare.result.workspace.approvePreview(preview.preview.previewId);
          assert.strictEqual(approved.ok, true, JSON.stringify(approved));
          const executed = await runtimeCompare.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
          assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Ext_Products.xml')), true,
            'the selected Catalog full-copy output creates its physical target declaration');
          assert.match(await readUtf8(paths.target, 'Roles/Ext_Role.xml'), /<xr:Property>Rights<\/xr:Property><xr:State>Extended<\/xr:State>/u);
          const outputRights = await readUtf8(paths.target, 'Roles/Ext_Role/Ext/Rights.xml');
          assert.match(outputRights, /<name>Catalog\.Ext_Products<\/name>.*?<name>Read<\/name><value>true<\/value>/su);
          assert.match(outputRights, /<name>Catalog\.Ext_Products<\/name>.*?<name>Delete<\/name><value>true<\/value>/su);
          assert.strictEqual(await pathExists(path.join(paths.source, 'Roles/Ext_Role/Ext/Rights.xml')), true,
            'the source adopted Rights file remains physically present and unchanged');
          assert.strictEqual(await pathExists(path.join(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml')), true,
            'the policy-only base Rights file remains present');
        } finally {
          await runtimeCompare.dispose();
        }
      });
    }
  });

  test('CFE Rights copied into a CF target uses the physical CF target object without a CFE declaration gate', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const paths = {
        target: path.join(tempRoot, 'target-cf'),
        source: path.join(tempRoot, 'source-cfe'),
        base: path.join(tempRoot, 'source-base-cf'),
      };
      const baseRole: ExtensionCompareObjectFixture = { type: 'Role', name: 'Ext_Role', uuid: ROLE_UUID };
      const targetRole: ExtensionCompareObjectFixture = { ...baseRole, propertiesXml: '<Comment>target</Comment>' };
      const sourceRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        uuid: ROLE_SOURCE_UUID,
        belonging: 'Adopted',
        anchorUuid: ROLE_UUID,
        descriptorXml: roleDescriptor(ROLE_SOURCE_UUID, true, false),
      };
      const baseCatalog: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: CATALOG_UUID };
      await writeAdoptedConfiguration(paths.base, [baseRole, baseCatalog]);
      await writeAdoptedConfiguration(paths.target, [targetRole, baseCatalog]);
      await writeAdoptedConfiguration(paths.source, [sourceRole], true);
      await writeCompareBytes(paths.base, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));
      await writeCompareBytes(paths.target, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));

      const runtimeCompare = await compareWithRuntime(tempRoot, paths.target, paths.source, {
        extensionBaseRoots: { right: paths.base },
      });
      try {
        const role = findRole(runtimeCompare.result, 'Role.Ext_Role');
        const right = collectNodes(role).find((node) => (node.kind === 'xmlProperty' || node.kind === 'roleRight')
          && node.payloadRef && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-object=catalog.products')
          && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-right=read'));
        assert.ok(right?.mergeable, `the CFE Rights delta should remain selectable for a CF target: ${JSON.stringify(describeNodes(collectNodes(role)))}`);
        if (!right) {return;}
        const preview = await createPreview(runtimeCompare.result, [right.id]);
        assert.strictEqual(runtimeCompare.result.workspace.approvePreview(preview.previewId).ok, true);
        const executed = await runtimeCompare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
        assert.match(await readUtf8(paths.target, 'Roles/Ext_Role/Ext/Rights.xml'), /<right><name>Read<\/name><value(?:\s[^>]*)?>true<\/value><\/right>/u);
        assert.doesNotMatch(await readUtf8(paths.target, 'Roles/Ext_Role.xml'), /<xr:Property>Rights<\/xr:Property>/u,
          'the CF target keeps its native own Role descriptor without a CFE PropertyState marker');
        assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Products.xml')), true,
          'the selected CFE Rights reference resolves against the physical CF target declaration');
      } finally {
        await runtimeCompare.dispose();
      }
    });
  });

  test('execute-time target, source-missing, and both base Rights witnesses prevent stale writes', async function (this: Mocha.Context) {
    this.timeout(180000);
    for (const drift of ['target', 'source-missing', 'target-base', 'source-base'] as const) {
      await withTempRoot(async (tempRoot) => {
        const paths = {
          target: path.join(tempRoot, 'target-cfe'),
          source: path.join(tempRoot, 'source-cfe'),
          targetBase: path.join(tempRoot, 'target-base-cf'),
          sourceBase: path.join(tempRoot, 'source-base-cf'),
        };
        const baseRole: ExtensionCompareObjectFixture = { type: 'Role', name: 'Ext_Role', uuid: ROLE_UUID };
        const targetRole: ExtensionCompareObjectFixture = {
          ...baseRole,
          uuid: ROLE_TARGET_UUID,
          belonging: 'Adopted',
          anchorUuid: ROLE_UUID,
          descriptorXml: roleDescriptor(ROLE_TARGET_UUID, true, true),
        };
        const sourceRole: ExtensionCompareObjectFixture = {
          ...baseRole,
          uuid: ROLE_SOURCE_UUID,
          belonging: 'Adopted',
          anchorUuid: ROLE_UUID,
          descriptorXml: roleDescriptor(ROLE_SOURCE_UUID, true, false),
        };
        const baseCatalog: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: CATALOG_UUID };
        await writeAdoptedConfiguration(paths.targetBase, [baseRole, baseCatalog]);
        await writeAdoptedConfiguration(paths.sourceBase, [baseRole, baseCatalog]);
        await writeAdoptedConfiguration(paths.target, [targetRole, {
          ...baseCatalog, uuid: CATALOG_TARGET_UUID, belonging: 'Adopted', anchorUuid: CATALOG_UUID,
        }], true);
        await writeAdoptedConfiguration(paths.source, [sourceRole, {
          ...baseCatalog, uuid: CATALOG_SOURCE_UUID, belonging: 'Adopted', anchorUuid: CATALOG_UUID,
        }], true);
        await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
        await fs.copyFile(path.join(paths.targetBase, 'Roles/Ext_Role.xml'), path.join(paths.sourceBase, 'Roles/Ext_Role.xml'));
        await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
        await fs.copyFile(path.join(paths.target, 'Configuration.xml'), path.join(paths.source, 'Configuration.xml'));
        await writeCompareBytes(paths.target, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));
        await writeCompareBytes(paths.sourceBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));
        await writeCompareBytes(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));

        const runtimeCompare = await compareWithRuntime(tempRoot, paths.target, paths.source, {
          extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
        });
        try {
          const role = findRole(runtimeCompare.result, 'Role.Ext_Role');
          const right = collectNodes(role).find((node) => (node.kind === 'xmlProperty' || node.kind === 'roleRight')
            && node.payloadRef && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-object=catalog.products')
            && decodeURIComponent(node.payloadRef).toLocaleLowerCase('en-US').includes('rights-right=read'));
          assert.ok(right?.mergeable, `${drift}: Rights candidate should be selectable before its witness changes`);
          if (!right) {return;}
          const preview = await createPreview(runtimeCompare.result, [right.id]);
          assert.strictEqual(runtimeCompare.result.workspace.approvePreview(preview.previewId).ok, true);
          if (drift === 'target') {
            await writeCompareBytes(paths.target, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(true));
          } else if (drift === 'source-missing') {
            await writeCompareBytes(paths.source, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));
          } else if (drift === 'target-base') {
            await writeCompareBytes(paths.targetBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));
          } else {
            await writeCompareBytes(paths.sourceBase, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(false));
          }
          const before = {
            descriptor: await fs.readFile(path.join(paths.target, 'Roles/Ext_Role.xml')),
            rights: await fs.readFile(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')),
            configuration: await fs.readFile(path.join(paths.target, 'Configuration.xml')),
          };
          const executed = await runtimeCompare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, false, `${drift}: stale Rights witness must fail execution`);
          assert.ok(executed.result?.failed.some((operation) => operation.code === 'MERGE_WITNESS_MISMATCH'),
            `${drift}: expected witness failure: ${JSON.stringify(executed.result?.failed)}`);
          assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Roles/Ext_Role.xml')), before.descriptor);
          assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Roles/Ext_Role/Ext/Rights.xml')), before.rights);
          assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Configuration.xml')), before.configuration);
        } finally {
          await runtimeCompare.dispose();
        }
      });
    }
  });
});

interface OpenCompareOptions {
  readonly extensionBaseRoots?: { readonly left?: string; readonly right?: string };
}

interface OpenCompareHandle {
  readonly result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function compareWithRuntime(
  tempRoot: string,
  target: string,
  source: string,
  options: OpenCompareOptions,
): Promise<OpenCompareHandle> {
  const runtime = await createMergeMutationTestRuntime(target);
  try {
    const result = await buildConfigurationCompare({
      leftRootPath: target,
      rightRootPath: source,
      backupRootPath: path.join(tempRoot, 'runtime-backups'),
      extensionBaseRoots: options.extensionBaseRoots,
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

async function writeAdoptedConfiguration(
  root: string,
  objects: readonly ExtensionCompareObjectFixture[],
  cfe = false,
): Promise<void> {
  await writeDesignerConfiguration(root, {
    name: 'Shared configuration',
    ...(cfe ? { purpose: 'Customization', namePrefix: 'Ext_' } : {}),
    objects: objects.map(mdClassesFixture),
  });
  const configurationPath = path.join(root, 'Configuration.xml');
  const original = await fs.readFile(configurationPath, 'utf8');
  const qualified = original.replace('<MetaDataObject ', `<MetaDataObject xmlns="${MD}" `);
  assert.notStrictEqual(qualified, original);
  await fs.writeFile(configurationPath, qualified, 'utf8');
}

function mdClassesFixture(fixture: ExtensionCompareObjectFixture): ExtensionCompareObjectFixture {
  if (fixture.descriptorXml) {return fixture;}
  const xml = `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" version="2.20">` +
    `<${fixture.type} uuid="${fixture.uuid}"><Properties><Name>${fixture.name}</Name>` +
    `${fixture.belonging === 'Adopted' ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${fixture.anchorUuid}</ExtendedConfigurationObject>` : ''}` +
    `</Properties><ChildObjects/></${fixture.type}></MetaDataObject>`;
  return { ...fixture, descriptorXml: xml };
}

function roleDescriptor(uuid: string, adopted: boolean, rightsExtended: boolean): string {
  const ownership = adopted
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${ROLE_UUID}</ExtendedConfigurationObject>`
    : '';
  const state = rightsExtended
    ? '<xr:PropertyState><xr:Property>Rights</xr:Property><xr:State>Extended</xr:State></xr:PropertyState>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" xmlns:xr="${READABLE}" version="2.20">` +
    `<Role uuid="${uuid}"><InternalInfo><xr:GeneratedType name="RoleRef" uuid="${ROLE_UUID}"/>${state}</InternalInfo>` +
    `<Properties><Name>Ext_Role</Name>${ownership}</Properties><ChildObjects/></Role></MetaDataObject>`;
}

function rightsXml(read: boolean): string {
  return `<Rights xmlns="${ROLE_RIGHTS}" version="2.20"><setForNewObjects>false</setForNewObjects>` +
    `<setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>` +
    `<object><name>Catalog.Products</name><right><name>Read</name><value>${read}</value></right></object></Rights>`;
}

function rightsWithOwnCfeReference(read: boolean): string {
  return `<Rights xmlns="${ROLE_RIGHTS}" version="2.20"><setForNewObjects>false</setForNewObjects>` +
    `<setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>` +
    '<object><name>Catalog.Products</name><right><name>Read</name><value>true</value></right></object>' +
    `<object><name>Catalog.Ext_Products</name><right><name>Read</name><value>${read}</value></right></object></Rights>`;
}

function rightsPolicyOnlyXml(): string {
  return `<Rights xmlns="${ROLE_RIGHTS}" version="2.20"><setForNewObjects>false</setForNewObjects>` +
    '<setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects></Rights>';
}

function rightsWithOwnCfeObject(): string {
  return `<Rights xmlns="${ROLE_RIGHTS}" version="2.20"><setForNewObjects>false</setForNewObjects>` +
    '<setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
    '<object><name>Catalog.Ext_Products</name><right><name>Read</name><value>true</value></right>' +
    '<right><name>Delete</name><value>true</value></right></object></Rights>';
}

function findRole(result: ConfigurationCompareResult, label: string): CompareTreeNode {
  const role = collectNodes(result.projection.root).find((node) => node.kind === 'extensionMetadataObject' && node.label === label);
  assert.ok(role, `expected ${label}: ${JSON.stringify(describeNodes(collectNodes(result.projection.root)))}`);
  return role!;
}

function collectNodes(node: CompareTreeNode): CompareTreeNode[] {
  return [node, ...node.children.flatMap(collectNodes)];
}

function describeNodes(nodes: readonly CompareTreeNode[]): string {
  return JSON.stringify(nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    mergeable: node.mergeable,
    state: node.mergeState,
    pointer: node.payloadRef,
    conflict: node.conflict,
  })));
}

async function createPreview(result: ConfigurationCompareResult, nodeIds: readonly string[]) {
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  if (!created.ok) {assert.fail(`preview failed: ${JSON.stringify(created.diagnostics)}`);}
  return created.preview;
}

async function withTempRoot(callback: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await createExtensionCompareTempRoot('issue335-adopted-rights-public-');
  try {
    await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
