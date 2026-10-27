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
  metadataObjectXml,
  pathExists,
  readUtf8,
  writeCompareBytes,
  writeDesignerConfiguration,
  writeMetadataObject,
  type ExtensionCompareConfigurationFixture,
  type ExtensionCompareObjectFixture,
  type ExtensionCompareRootType,
} from '../../helpers/extensionCompareFixtures';

const FORMATS = ['2.17', '2.18', '2.19', '2.20', '2.21'] as const;
const ROOT_TYPES: readonly ExtensionCompareRootType[] = [
  'Catalog',
  'Document',
  'Enum',
  'CommonModule',
];

const UUID = {
  targetConfiguration: '11111111-1111-4111-8111-111111111111',
  sourceConfiguration: '22222222-2222-4222-8222-222222222222',
  catalog: '33333333-3333-4333-8333-333333333333',
  catalogLocal: '44444444-4444-4444-8444-444444444444',
  catalogOther: '55555555-5555-4555-8555-555555555555',
  commonModule: '66666666-6666-4666-8666-666666666666',
  commonModuleLocal: '77777777-7777-4777-8777-777777777777',
  secondCatalog: '88888888-8888-4888-8888-888888888888',
} as const;

const CASEFOLD_UUID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const BASE_ANCHOR_UUID = 'a1020304-5060-4708-90ab-cdef01234567';
const TARGET_LOCAL_UUID = 'b1020304-5060-4708-90ab-cdef01234567';
const OTHER_LOCAL_UUID = 'c1020304-5060-4708-90ab-cdef01234567';

suite('Extension-aware configuration compare', () => {
  test('admits the supported root types across Designer XML 2.17–2.21', async () => {
    await withTempRoot(async (tempRoot) => {
      for (const version of FORMATS) {
        for (const type of ROOT_TYPES) {
          const caseRoot = path.join(tempRoot, `${version.replace('.', '-')}-${type}`);
          const target = path.join(caseRoot, 'target-cf');
          const source = path.join(caseRoot, 'source-cfe');
          const object: ExtensionCompareObjectFixture = {
            type,
            name: `Ext_${type}_${version.replace('.', '')}`,
            uuid: UUID.catalog,
            belonging: 'Own',
          };
          await writeDesignerConfiguration(target, { version });
          await writeDesignerConfiguration(source, {
            version,
            purpose: 'Customization',
            namePrefix: 'Ext_',
            objects: [object],
          });

          const compare = await openCompare(tempRoot, target, source);
          try {
            assert.strictEqual(compare.result.workspace.listMergeableNodeIds().length, 1,
              `${type} ${version} should be a selectable own-object transfer`);
            assert.strictEqual(compare.result.workspace.payload.comparisonInfo?.mode, 'extension');
          } finally {
            await compare.dispose();
          }
        }
      }
    });
  });

  test('an ordinary CF with an empty NamePrefix stays on the legacy BSL compare path', async () => {
    await withTempRoot(async (tempRoot) => {
      const left = path.join(tempRoot, 'left-cf');
      const right = path.join(tempRoot, 'right-cf');
      const object: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Products',
        uuid: UUID.catalog,
      };
      await writeDesignerConfiguration(left, { rootPropertiesXml: '<NamePrefix></NamePrefix>', objects: [object] });
      await writeDesignerConfiguration(right, { rootPropertiesXml: '<NamePrefix/>', objects: [object] });
      await writeCompareBytes(left, 'Catalogs/Products/Ext/ObjectModule.bsl', 'Procedure Run()\n    Return 1;\nEndProcedure');
      await writeCompareBytes(right, 'Catalogs/Products/Ext/ObjectModule.bsl', 'Procedure Run()\n    Return 2;\nEndProcedure');

      const compare = await openCompare(tempRoot, left, right);
      try {
        assert.strictEqual(compare.result.workspace.payload.comparisonInfo, undefined);
        const bslRoutine = collectNodes(compare.result.projection.root).find((node) => (
          node.kind.toLowerCase().includes('bsl') && node.label.includes('Run')
        ));
        assert.ok(bslRoutine, 'legacy BSL routine diff should remain visible for CF↔CF');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CF→CFE creates a borrowed shell from the proven base without copying the base body or modules', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const extension = path.join(tempRoot, 'ConfigurationExtensions', 'Borrowed');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Products',
        uuid: UUID.catalog,
        propertiesXml: '<Comment>base-only comment</Comment>',
        childObjectsXml: '<Attribute>PrivateBaseAttribute</Attribute>',
      };
      await writeDesignerConfiguration(base, { objects: [baseObject] });
      await writeCompareBytes(base, 'Catalogs/Products/Ext/ObjectModule.bsl', 'Procedure BaseOnly()\nEndProcedure');
      await writeDesignerConfiguration(extension, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
      });

      const compare = await openCompare(tempRoot, extension, base, {
        withRuntime: true,
        extensionBaseRoots: { left: base },
      });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        assert.ok(preview.items.some((item) => item.previewEffect === 'create'));
        assert.ok(!JSON.stringify(preview).includes('contentBase64'));
        await execute(compare.result, preview.previewId);

        const targetDescriptor = await readUtf8(extension, 'Catalogs/Products.xml');
        const targetConfiguration = await readUtf8(extension, 'Configuration.xml');
        assert.match(targetDescriptor, /<ObjectBelonging>Adopted<\/ObjectBelonging>/u);
        assert.match(targetDescriptor, new RegExp(`<ExtendedConfigurationObject>${UUID.catalog}<\/ExtendedConfigurationObject>`, 'u'));
        assert.doesNotMatch(targetDescriptor, /base-only comment|PrivateBaseAttribute/u);
        assert.match(targetDescriptor, /<ChildObjects\s*\/>/u);
        assert.match(targetConfiguration, /<Catalog>Products<\/Catalog>/u);
        assert.strictEqual(await pathExists(path.join(extension, 'Catalogs/Products/Ext/ObjectModule.bsl')), false);
        assert.strictEqual(await pathExists(path.join(base, 'Catalogs/Products/Ext/ObjectModule.bsl')), true);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CF→CFE adopted overlay updates only the supported properties and retains local identity', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const extension = path.join(tempRoot, 'extension-cfe');
      const incoming: ExtensionCompareObjectFixture = {
        type: 'CommonModule',
        name: 'Shared',
        uuid: UUID.commonModule,
        propertiesXml: '<Synonym>Updated synonym</Synonym><Comment>Updated comment</Comment><Global>true</Global><ServerCall>true</ServerCall>',
      };
      const adopted: ExtensionCompareObjectFixture = {
        type: 'CommonModule',
        name: 'Shared',
        uuid: UUID.commonModuleLocal,
        belonging: 'Adopted',
        anchorUuid: UUID.commonModule,
        propertiesXml: '<Synonym>Old synonym</Synonym><Comment>Old comment</Comment><Global>false</Global><ServerCall>false</ServerCall><ExternalConnection>true</ExternalConnection>',
      };
      await writeDesignerConfiguration(base, { objects: [incoming] });
      await writeDesignerConfiguration(extension, {
        purpose: 'Customization',
        objects: [adopted],
      });

      const compare = await openCompare(tempRoot, extension, base, {
        withRuntime: true,
        extensionBaseRoots: { left: base },
      });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);

        const xml = await readUtf8(extension, 'CommonModules/Shared.xml');
        assert.match(xml, new RegExp(`<CommonModule uuid="${UUID.commonModuleLocal}"`, 'u'));
        assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${UUID.commonModule}<\/ExtendedConfigurationObject>`, 'u'));
        assert.match(xml, /<Synonym>Updated synonym<\/Synonym>/u);
        assert.match(xml, /<Comment>Updated comment<\/Comment>/u);
        assert.match(xml, /<Global>true<\/Global>/u);
        assert.match(xml, /<ServerCall>true<\/ServerCall>/u);
        assert.match(xml, /<ExternalConnection>true<\/ExternalConnection>/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CF adds or replaces an own object with source bytes and exactly one root registration', async () => {
    await withTempRoot(async (tempRoot) => {
      for (const replace of [false, true]) {
        const caseRoot = path.join(tempRoot, replace ? 'replace' : 'add');
        const target = path.join(caseRoot, 'target-cf');
        const extension = path.join(caseRoot, 'source-cfe');
        const own: ExtensionCompareObjectFixture = {
          type: 'Catalog',
          name: 'Ext_Orders',
          uuid: UUID.catalog,
          belonging: 'Own',
          propertiesXml: '<Comment>incoming source descriptor</Comment>',
        };
        await writeDesignerConfiguration(target, {
          objects: replace
            ? [{ ...own, belonging: undefined, propertiesXml: '<Comment>target before</Comment>' }]
            : [],
        });
        await writeDesignerConfiguration(extension, {
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [own],
        });
        const descriptor = path.join(extension, 'Catalogs/Ext_Orders.xml');
        const xmlBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(metadataObjectXml(own), 'utf8')]);
        await fs.writeFile(descriptor, xmlBytes);
        const sidecarBytes = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x0a]);
        await writeCompareBytes(extension, 'Catalogs/Ext_Orders/Ext/opaque.bin', sidecarBytes);

        const compare = await openCompare(tempRoot, target, extension, { withRuntime: true });
        try {
          const nodeId = onlyMergeableNodeId(compare.result);
          const preview = await createPreview(compare.result, [nodeId]);
          assert.ok(preview.items.some((item) => item.previewPath === 'Catalogs/Ext_Orders.xml'));
          await execute(compare.result, preview.previewId);

          const writtenDescriptor = await fs.readFile(path.join(target, 'Catalogs/Ext_Orders.xml'));
          const writtenSidecar = await fs.readFile(path.join(target, 'Catalogs/Ext_Orders/Ext/opaque.bin'));
          const configurationXml = await readUtf8(target, 'Configuration.xml');
          assert.deepStrictEqual(writtenDescriptor, xmlBytes);
          assert.deepStrictEqual(writtenSidecar, sidecarBytes);
          assert.strictEqual((configurationXml.match(/<Catalog>Ext_Orders<\/Catalog>/gu) ?? []).length, 1);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('CFE→CFE adopted transfer keeps the shared base anchor, target-local UUID, state and intercept bytes', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'CommonModule', name: 'Shared', uuid: UUID.commonModule }],
      });
      const targetAdopted: ExtensionCompareObjectFixture = {
        type: 'CommonModule',
        name: 'Shared',
        uuid: UUID.commonModuleLocal,
        belonging: 'Adopted',
        anchorUuid: UUID.commonModule,
        propertiesXml: '<xr:Properties><xr:Property>Module</xr:Property><xr:State>Extended</xr:State></xr:Properties>',
      };
      const sourceAdopted: ExtensionCompareObjectFixture = {
        ...targetAdopted,
        uuid: UUID.catalogOther,
        propertiesXml: '<Synonym>from source</Synonym><xr:Properties><xr:Property>Module</xr:Property><xr:State>Extended</xr:State></xr:Properties>',
      };
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: [targetAdopted] });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: [sourceAdopted] });
      const interceptBytes = Buffer.from([
        '&НаСервере\r\n&Перед("ПриЗаписи")\r\nПроцедура Ext_Before()\r\nКонецПроцедуры\r\n',
        '&После("ПриЗаписи")\r\nПроцедура Ext_After()\r\nКонецПроцедуры\r\n',
        '&Вместо("ПриЗаписи")\r\nПроцедура Ext_Instead()\r\nКонецПроцедуры\r\n',
      ].join(''));
      await writeCompareBytes(source, 'CommonModules/Shared/Ext/Module.bsl', interceptBytes);

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);

        const xml = await readUtf8(target, 'CommonModules/Shared.xml');
        const writtenModule = await fs.readFile(path.join(target, 'CommonModules/Shared/Ext/Module.bsl'));
        assert.match(xml, new RegExp(`<CommonModule uuid="${UUID.commonModuleLocal}"`, 'u'));
        assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${UUID.commonModule}<\/ExtendedConfigurationObject>`, 'u'));
        assert.match(xml, /<xr:State>Extended<\/xr:State>/u);
        assert.deepStrictEqual(writtenModule, interceptBytes);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CFE own replacement preserves the object UUID without requiring a base relation', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const own: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Ext_Orders',
        uuid: UUID.catalog,
        propertiesXml: '<Comment>target version</Comment>',
      };
      await writeDesignerConfiguration(target, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [own],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{ ...own, propertiesXml: '<Comment>source version</Comment>' }],
      });
      const sidecar = Buffer.from([0x4f, 0x77, 0x6e, 0x00, 0xff]);
      await writeCompareBytes(source, 'Catalogs/Ext_Orders/Ext/opaque.bin', sidecar);

      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);
        const xml = await readUtf8(target, 'Catalogs/Ext_Orders.xml');
        assert.match(xml, new RegExp(`<Catalog uuid="${UUID.catalog}"`, 'u'));
        assert.match(xml, /<Comment>source version<\/Comment>/u);
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Ext_Orders/Ext/opaque.bin')), sidecar);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CF adopted overlay updates the base object while preserving its full descriptor and UUID', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Products',
        uuid: UUID.catalog,
        propertiesXml: '<Synonym>base synonym</Synonym><Comment>keep this base detail</Comment><Hierarchical>true</Hierarchical>',
      };
      const adopted: ExtensionCompareObjectFixture = {
        ...baseObject,
        uuid: UUID.catalogLocal,
        belonging: 'Adopted',
        anchorUuid: UUID.catalog,
        propertiesXml: '<Synonym>extension synonym</Synonym>',
      };
      await writeDesignerConfiguration(target, { objects: [baseObject] });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: [adopted] });

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { right: target },
      });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);

        const xml = await readUtf8(target, 'Catalogs/Products.xml');
        assert.match(xml, new RegExp(`<Catalog uuid="${UUID.catalog}"`, 'u'));
        assert.doesNotMatch(xml, new RegExp(UUID.catalogLocal, 'u'));
        assert.match(xml, /<Synonym>extension synonym<\/Synonym>/u);
        assert.match(xml, /<Comment>keep this base detail<\/Comment>/u);
        assert.match(xml, /<Hierarchical>true<\/Hierarchical>/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CF blocks an adopted object whose child or module content would be flattened', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, {
        objects: [{ type: 'Catalog', name: 'Products', uuid: UUID.catalog }],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        objects: [{
          type: 'Catalog',
          name: 'Products',
          uuid: UUID.catalogLocal,
          belonging: 'Adopted',
          anchorUuid: UUID.catalog,
          childObjectsXml: '<Attribute>ExtensionOnly</Attribute>',
        }],
      });
      await writeCompareBytes(source, 'Catalogs/Products/Ext/ObjectModule.bsl', '&Перед("ПриЗаписи")\nПроцедура Ext_Before()\nКонецПроцедуры');

      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { right: target },
      });
      try {
        assertBlocked(compare.result, 'adopted Catalog with children and BSL module must be unsupported for CF flattening');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('new own objects obey CFE purpose and prefix rules while an existing own object can be updated', async () => {
    await withTempRoot(async (tempRoot) => {
      for (const purpose of ['AddOn', 'Customization', 'Patch'] as const) {
        const caseRoot = path.join(tempRoot, purpose);
        const base = path.join(caseRoot, 'base-cf');
        const incoming = path.join(caseRoot, 'incoming-cf');
        const target = path.join(caseRoot, 'target-cfe');
        const object: ExtensionCompareObjectFixture = {
          type: 'Catalog',
          name: 'Ext_New',
          uuid: UUID.catalog,
        };
        await writeDesignerConfiguration(base);
        await writeDesignerConfiguration(incoming, { objects: [object] });
        await writeDesignerConfiguration(target, { purpose, namePrefix: 'Ext_' });
        const compare = await openCompare(tempRoot, target, incoming, {
          extensionBaseRoots: { left: base },
        });
        try {
          const mergeable = compare.result.workspace.listMergeableNodeIds().length === 1;
          assert.strictEqual(mergeable, purpose !== 'Patch', `${purpose} own-object creation policy`);
          if (purpose === 'Patch') {
            assertBlocked(compare.result, 'Patch creation should remain visible and blocked');
          }
        } finally {
          await compare.dispose();
        }
      }

      const target = path.join(tempRoot, 'patch-update', 'target-cfe');
      const source = path.join(tempRoot, 'patch-update', 'source-cfe');
      const existing: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Ext_Existing',
        uuid: UUID.catalog,
        belonging: 'Own',
        propertiesXml: '<Comment>old</Comment>',
      };
      await writeDesignerConfiguration(target, { purpose: 'Patch', namePrefix: 'Ext_', objects: [existing] });
      await writeDesignerConfiguration(source, { purpose: 'Customization', namePrefix: 'Ext_', objects: [{
        ...existing,
        propertiesXml: '<Comment>updated</Comment>',
      }] });
      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);
        assert.match(await readUtf8(target, 'Configuration.xml'), /<ConfigurationExtensionPurpose>Patch<\/ConfigurationExtensionPurpose>/u);
        assert.match(await readUtf8(target, 'Catalogs/Ext_Existing.xml'), /<Comment>updated<\/Comment>/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('absence is not a delete instruction when applying a selected own object', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, {
        objects: [{ type: 'Catalog', name: 'KeepMe', uuid: UUID.secondCatalog }],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{ type: 'Catalog', name: 'Ext_New', uuid: UUID.catalog, belonging: 'Own' }],
      });
      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        assert.ok(preview.items.every((item) => item.previewEffect !== 'delete'));
        await execute(compare.result, preview.previewId);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/KeepMe.xml')), true);
        assert.match(await readUtf8(target, 'Configuration.xml'), /<Catalog>KeepMe<\/Catalog>/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('same UUID with a new name, same name with another UUID, and cross-type identity conflicts are blocked', async () => {
    await withTempRoot(async (tempRoot) => {
      const cases: Array<{
        name: string;
        left: ExtensionCompareConfigurationFixture;
        right: ExtensionCompareConfigurationFixture;
      }> = [
        {
          name: 'same UUID, different name',
          left: { objects: [{ type: 'Catalog', name: 'Ext_Old', uuid: UUID.catalog, belonging: 'Own' }] },
          right: { purpose: 'Customization', namePrefix: 'Ext_', objects: [{ type: 'Catalog', name: 'Ext_New', uuid: UUID.catalog, belonging: 'Own' }] },
        },
        {
          name: 'same name, different UUID',
          left: { objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: UUID.catalog, belonging: 'Own' }] },
          right: { purpose: 'Customization', namePrefix: 'Ext_', objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: UUID.catalogOther, belonging: 'Own' }] },
        },
        {
          name: 'cross-type identity',
          left: { objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: UUID.catalog, belonging: 'Own' }] },
          right: { purpose: 'Customization', namePrefix: 'Ext_', objects: [{ type: 'Document', name: 'Ext_Item', uuid: UUID.catalog, belonging: 'Own' }] },
        },
      ];

      for (const scenario of cases) {
        const caseRoot = path.join(tempRoot, scenario.name.replace(/ /gu, '-'));
        const left = path.join(caseRoot, 'left');
        const right = path.join(caseRoot, 'right');
        await writeDesignerConfiguration(left, scenario.left);
        await writeDesignerConfiguration(right, scenario.right);
        const before = await snapshotFiles(left);
        const compare = await openCompare(tempRoot, left, right);
        try {
          assertBlocked(compare.result, scenario.name);
          assert.deepStrictEqual(await snapshotFiles(left), before, `${scenario.name}: target files changed`);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('blocks a renamed own object when UUID matches after hex case folding', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, {
        objects: [{ type: 'Catalog', name: 'Ext_Old', uuid: CASEFOLD_UUID, belonging: 'Own' }],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{ type: 'Catalog', name: 'Ext_New', uuid: CASEFOLD_UUID.toUpperCase(), belonging: 'Own' }],
      });
      const before = await snapshotFiles(target);
      const compare = await openCompare(tempRoot, target, source);
      try {
        assertBlocked(compare.result, 'same UUID with case difference and a new name');
        assert.deepStrictEqual(await snapshotFiles(target), before, 'the rejected rename must not change target files');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a renamed adopted object that matches by case-folded base anchor', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'BaseCatalog',
        uuid: BASE_ANCHOR_UUID,
      };
      const adopted = (name: string, uuid: string, anchorUuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog',
        name,
        uuid,
        belonging: 'Adopted',
        anchorUuid,
      });
      await writeDesignerConfiguration(base, { objects: [baseObject] });
      await writeDesignerConfiguration(target, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [adopted('Ext_Old', TARGET_LOCAL_UUID, BASE_ANCHOR_UUID)],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [adopted('Ext_New', OTHER_LOCAL_UUID, BASE_ANCHOR_UUID.toUpperCase())],
      });

      const before = await snapshotFiles(target);
      const renamed = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        assertBlocked(renamed.result, 'case-insensitive common adopted anchor with a renamed object');
        assert.deepStrictEqual(await snapshotFiles(target), before, 'the rejected rename must not change target files');
      } finally {
        await renamed.dispose();
      }
    });
  });

  test('preserves target paths for same-name own identities when UUID hex casing differs', async () => {
    await withTempRoot(async (tempRoot) => {
      const sameNameTarget = path.join(tempRoot, 'same-name-target-cf');
      const sameNameSource = path.join(tempRoot, 'same-name-source-cfe');
      await writeDesignerConfiguration(sameNameTarget, {
        objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: CASEFOLD_UUID, belonging: 'Own' }],
      });
      await writeDesignerConfiguration(sameNameSource, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{ type: 'Catalog', name: 'Ext_Item', uuid: CASEFOLD_UUID.toUpperCase(), belonging: 'Own' }],
      });
      const sameName = await openCompare(tempRoot, sameNameTarget, sameNameSource, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(sameName.result);
        const preview = await createPreview(sameName.result, [nodeId]);
        await execute(sameName.result, preview.previewId);
        assert.strictEqual(await pathExists(path.join(sameNameTarget, 'Catalogs', 'Ext_Item.xml')), true);
        assert.strictEqual(await pathExists(path.join(sameNameTarget, 'Catalogs', 'Ext_New.xml')), false);
        const configurationXml = await readUtf8(sameNameTarget, 'Configuration.xml');
        assert.strictEqual((configurationXml.match(/<Catalog>Ext_Item<\/Catalog>/gu) ?? []).length, 1,
          'same-name identity update must preserve exactly one registration and its existing path');
      } finally {
        await sameName.dispose();
      }
    });
  });

  test('preserves target paths for same-name adopted identities when anchor UUID casing differs', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'BaseCatalog', uuid: BASE_ANCHOR_UUID }],
      });
      await writeDesignerConfiguration(target, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{
          type: 'Catalog', name: 'Ext_Item', uuid: TARGET_LOCAL_UUID,
          belonging: 'Adopted', anchorUuid: BASE_ANCHOR_UUID,
        }],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [{
          type: 'Catalog', name: 'Ext_Item', uuid: OTHER_LOCAL_UUID,
          belonging: 'Adopted', anchorUuid: BASE_ANCHOR_UUID.toUpperCase(),
          propertiesXml: '<Comment>updated</Comment>',
        }],
      });

      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
        withRuntime: true,
      });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Item.xml')), true);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_New.xml')), false);
        const configurationXml = await readUtf8(target, 'Configuration.xml');
        assert.strictEqual((configurationXml.match(/<Catalog>Ext_Item<\/Catalog>/gu) ?? []).length, 1,
          'same-name adopted identity update must preserve exactly one registration and its existing path');
        const adoptedXml = await readUtf8(target, 'Catalogs/Ext_Item.xml');
        assert.strictEqual(adoptedXml.match(/<Catalog uuid="([^"]+)"/u)?.[1]?.toLowerCase(), TARGET_LOCAL_UUID,
          'the update retains the target-local UUID');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a new own object that collides with an adopted target local UUID', async () => {
    await withTempRoot(async (tempRoot) => {
      const adopted = (name: string, uuid: string, anchorUuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog',
        name,
        uuid,
        belonging: 'Adopted',
        anchorUuid,
      });
      const own = (name: string, uuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog',
        name,
        uuid,
        belonging: 'Own',
      });
      const writeBase = async (base: string): Promise<void> => writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'BaseCatalog', uuid: BASE_ANCHOR_UUID }],
      });
      const caseRoot = path.join(tempRoot, 'new-own-collides-with-adopted-local');
      const base = path.join(caseRoot, 'base-cf');
      const target = path.join(caseRoot, 'target-cfe');
      const source = path.join(caseRoot, 'source-cfe');
      await writeBase(base);
      await writeDesignerConfiguration(target, {
        purpose: 'Customization', namePrefix: 'Ext_',
        objects: [adopted('Ext_ExistingAdopted', TARGET_LOCAL_UUID, BASE_ANCHOR_UUID)],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization', namePrefix: 'Ext_',
        objects: [own('Ext_IncomingOwn', TARGET_LOCAL_UUID.toUpperCase())],
      });
      const before = await snapshotFiles(target);
      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        assertBlocked(compare.result, 'a new own object must not reuse an adopted target object local UUID');
        assert.deepStrictEqual(await snapshotFiles(target), before, 'the rejected collision must not change target files');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('blocks a new adopted object that collides with an own target local UUID', async () => {
    await withTempRoot(async (tempRoot) => {
      const adopted = (name: string, uuid: string, anchorUuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog', name, uuid, belonging: 'Adopted', anchorUuid,
      });
      const own = (name: string, uuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog', name, uuid, belonging: 'Own',
      });
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(base, {
        objects: [{ type: 'Catalog', name: 'BaseCatalog', uuid: BASE_ANCHOR_UUID }],
      });
      await writeDesignerConfiguration(target, {
        purpose: 'Customization', namePrefix: 'Ext_',
        objects: [own('Ext_ExistingOwn', TARGET_LOCAL_UUID)],
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization', namePrefix: 'Ext_',
        objects: [adopted('Ext_IncomingAdopted', TARGET_LOCAL_UUID.toUpperCase(), BASE_ANCHOR_UUID)],
      });
      const before = await snapshotFiles(target);
      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        assertBlocked(compare.result, 'a new adopted object must not reuse an own target object local UUID');
        assert.deepStrictEqual(await snapshotFiles(target), before, 'the rejected collision must not change target files');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('allows an adopted update when its incoming local UUID is used by an unrelated target object', async () => {
    await withTempRoot(async (tempRoot) => {
      const adopted = (name: string, uuid: string, anchorUuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog', name, uuid, belonging: 'Adopted', anchorUuid,
      });
      const own = (
        name: string,
        uuid: string,
        type: 'Catalog' | 'Document' = 'Catalog',
      ): ExtensionCompareObjectFixture => ({
        type, name, uuid, belonging: 'Own',
      });
      for (const unrelatedType of ['Catalog', 'Document'] as const) {
        const caseRoot = path.join(tempRoot, `unrelated-${unrelatedType.toLowerCase()}`);
        const base = path.join(caseRoot, 'base-cf');
        const target = path.join(caseRoot, 'target-cfe');
        const source = path.join(caseRoot, 'source-cfe');
        await writeDesignerConfiguration(base, {
          objects: [{ type: 'Catalog', name: 'BaseCatalog', uuid: BASE_ANCHOR_UUID }],
        });
        await writeDesignerConfiguration(target, {
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [
            adopted('Ext_Adopted', TARGET_LOCAL_UUID, BASE_ANCHOR_UUID),
            own('Ext_Unrelated', OTHER_LOCAL_UUID, unrelatedType),
          ],
        });
        await writeDesignerConfiguration(source, {
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [
            { ...adopted('Ext_Adopted', OTHER_LOCAL_UUID.toUpperCase(), BASE_ANCHOR_UUID), propertiesXml: '<Comment>updated</Comment>' },
          ],
        });

        const compare = await openCompare(tempRoot, target, source, {
          extensionBaseRoots: { left: base, right: base },
          withRuntime: true,
        });
        try {
          const nodeId = onlyMergeableNodeId(compare.result);
          const preview = await createPreview(compare.result, [nodeId]);
          await execute(compare.result, preview.previewId);
          const adoptedXml = await readUtf8(target, 'Catalogs/Ext_Adopted.xml');
          const unrelatedDirectory = unrelatedType === 'Catalog' ? 'Catalogs' : 'Documents';
          const unrelatedXml = await readUtf8(target, `${unrelatedDirectory}/Ext_Unrelated.xml`);
          const unrelatedRoot = unrelatedType;
          const adoptedUuid = adoptedXml.match(/<Catalog uuid="([^"]+)"/u)?.[1]?.toLowerCase();
          const unrelatedUuid = unrelatedXml.match(new RegExp(`<${unrelatedRoot} uuid="([^"]+)"`, 'u'))?.[1]?.toLowerCase();
          assert.strictEqual(adoptedUuid, TARGET_LOCAL_UUID, 'an adopted update retains its target-local UUID');
          assert.strictEqual(unrelatedUuid, OTHER_LOCAL_UUID);
          assert.strictEqual(new Set([adoptedUuid, unrelatedUuid]).size, 2,
            `the materialized target keeps local UUIDs unique when the incoming adopted UUID is already used by an unrelated ${unrelatedType}`);
          assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Adopted.xml')), true);
          assert.strictEqual(await pathExists(path.join(target, unrelatedDirectory, 'Ext_Unrelated.xml')), true);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('duplicate UUIDs and duplicate qualified registrations block the selected batch', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target);
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [
          { type: 'Catalog', name: 'Ext_First', uuid: UUID.catalog, belonging: 'Own' },
          { type: 'Catalog', name: 'Ext_Second', uuid: UUID.catalog, belonging: 'Own' },
          { type: 'Document', name: 'Ext_RegisteredTwice', uuid: UUID.secondCatalog, belonging: 'Own' },
        ],
        registrations: [
          { type: 'Catalog', name: 'Ext_First' },
          { type: 'Catalog', name: 'Ext_Second' },
          { type: 'Document', name: 'Ext_RegisteredTwice' },
          { type: 'Document', name: 'Ext_RegisteredTwice' },
        ],
      });
      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        assertBlocked(compare.result, 'duplicate UUID and duplicate qualified registration');
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_First.xml')), false);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Second.xml')), false);
        assert.strictEqual(await pathExists(path.join(target, 'Documents/Ext_RegisteredTwice.xml')), false);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('adopted CFE transfer requires one explicit common base and matching purpose', async () => {
    await withTempRoot(async (tempRoot) => {
      const baseA = path.join(tempRoot, 'base-a');
      const baseB = path.join(tempRoot, 'base-b');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(baseA, { objects: [{ type: 'Catalog', name: 'Products', uuid: UUID.catalog }] });
      await writeDesignerConfiguration(baseB, { objects: [{ type: 'Catalog', name: 'Products', uuid: UUID.catalogOther }] });
      const adopted = (anchorUuid: string, uuid: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog',
        name: 'Products',
        uuid,
        belonging: 'Adopted',
        anchorUuid,
      });
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: [adopted(UUID.catalog, UUID.catalogLocal)] });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: [adopted(UUID.catalogOther, UUID.secondCatalog)] });

      const noBase = await openCompare(tempRoot, target, source);
      try {
        assertBlocked(noBase.result, 'same anchor labels without a base relation must not prove identity');
      } finally {
        await noBase.dispose();
      }

      const mismatchedBases = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: baseA, right: baseB },
      });
      try {
        assertBlocked(mismatchedBases.result, 'different explicit base configurations must block adopted transfer');
      } finally {
        await mismatchedBases.dispose();
      }
    });
  });

  test('sidecar replacement previews orphan deletion and waits for destructive confirmation', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const existing: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Ext_Orders',
        uuid: UUID.catalog,
        propertiesXml: '<Comment>target old</Comment>',
      };
      const incoming: ExtensionCompareObjectFixture = {
        ...existing,
        belonging: 'Own',
        propertiesXml: '<Comment>source new</Comment>',
      };
      await writeDesignerConfiguration(target, { objects: [existing] });
      await writeCompareBytes(target, 'Catalogs/Ext_Orders/Ext/ObjectModule.bsl', 'old module');
      await writeCompareBytes(target, 'Catalogs/Ext_Orders/Ext/Orphan.bin', Buffer.from([0, 1, 2]));
      await writeDesignerConfiguration(source, { purpose: 'Customization', namePrefix: 'Ext_', objects: [incoming] });
      await writeCompareBytes(source, 'Catalogs/Ext_Orders/Ext/ObjectModule.bsl', 'new module');

      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        const orphan = preview.items.find((item) => item.previewPath?.endsWith('Orphan.bin'));
        assert.ok(orphan, 'orphan file removal must be visible in preview');
        assert.strictEqual(orphan.previewEffect, 'delete');
        assert.strictEqual(orphan.destructive, true);
        compare.result.workspace.approvePreview(preview.previewId);
        const withoutConfirmation = await compare.result.workspace.executeApprovedPreview(preview.previewId);
        assert.strictEqual(withoutConfirmation.ok, false);
        if (!withoutConfirmation.ok) {
          assert.strictEqual(withoutConfirmation.diagnostics[0]?.code, 'CONFIG_COMPARE_DESTRUCTIVE_CONFIRMATION_REQUIRED');
        }
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Orders/Ext/Orphan.bin')), true);

        const confirmed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(confirmed.ok, true);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Orders/Ext/Orphan.bin')), false);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('source, base and target drift between compare and preview block the write', async () => {
    await withTempRoot(async (tempRoot) => {
      for (const drift of ['source', 'base', 'target'] as const) {
        const caseRoot = path.join(tempRoot, drift);
        const target = path.join(caseRoot, 'target-cf');
        const source = path.join(caseRoot, 'source-cfe');
        const base = path.join(caseRoot, 'base-cf');
        const incoming: ExtensionCompareObjectFixture = {
          type: 'Catalog',
          name: 'Ext_Item',
          uuid: UUID.catalog,
          belonging: 'Own',
          propertiesXml: '<Comment>incoming</Comment>',
        };
        await writeDesignerConfiguration(target, {
          objects: drift === 'target' ? [{ ...incoming, belonging: undefined, propertiesXml: '<Comment>existing</Comment>' }] : [],
        });
        await writeDesignerConfiguration(source, { purpose: 'Customization', namePrefix: 'Ext_', objects: [incoming] });
        await writeDesignerConfiguration(base, { objects: [{ type: 'Catalog', name: 'BaseItem', uuid: UUID.catalogOther }] });
        const compare = await openCompare(tempRoot, target, source, {
          withRuntime: true,
          extensionBaseRoots: drift === 'base' ? { right: base } : undefined,
        });
        try {
          const nodeId = onlyMergeableNodeId(compare.result);
          if (drift === 'source') {
            await writeCompareBytes(source, 'Catalogs/Ext_Item.xml', '<externally changed />');
          } else if (drift === 'base') {
            await writeCompareBytes(base, 'Configuration.xml', '<externally changed />');
          } else {
            await writeCompareBytes(target, 'Configuration.xml', '<externally changed />');
          }
          const created = await compare.result.workspace.createPreviewForNodeIds([nodeId]);
          assert.strictEqual(created.ok, false, `${drift} drift should invalidate materialization`);
          assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Item.xml')), drift === 'target');
          assert.strictEqual(await readUtf8(source, 'Catalogs/Ext_Item.xml') === '<externally changed />', drift === 'source');
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('a late source-side sidecar addition invalidates the complete source tree witness', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const incoming: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Ext_Item', uuid: UUID.catalog, belonging: 'Own',
      };
      await writeDesignerConfiguration(target);
      await writeDesignerConfiguration(source, { purpose: 'Customization', namePrefix: 'Ext_', objects: [incoming] });
      await writeCompareBytes(source, 'Catalogs/Ext_Item/Ext/ObjectModule.bsl', 'before capture');
      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        await writeCompareBytes(source, 'Catalogs/Ext_Item/Ext/late-added.bin', Buffer.from([0xde, 0xad]));
        const created = await compare.result.workspace.createPreviewForNodeIds([nodeId]);
        assert.strictEqual(created.ok, false);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Item.xml')), false);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('a missing known XML dependency rejects the complete selected batch before any target write', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target);
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [
          { type: 'Catalog', name: 'Ext_Good', uuid: UUID.catalog, propertiesXml: '<Comment>safe object</Comment>' },
          {
            type: 'Document',
            name: 'Ext_Bad',
            uuid: UUID.secondCatalog,
            propertiesXml: '<Attributes xmlns:v8="http://v8.1c.ru/8.1/data/core"><Attribute name="Dependency" id="1"><Type><v8:Type>cfg:CatalogRef.MissingDependency</v8:Type></Type></Attribute></Attributes>',
          },
        ],
      });
      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const goodId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Ext_Good');
        const badId = nodeIdForLabel(compare.result.projection.root, 'Document.Ext_Bad');
        const mergeableNodeIds = compare.result.workspace.listMergeableNodeIds();
        assert.ok(mergeableNodeIds.includes(goodId) && mergeableNodeIds.includes(badId),
          'dependency resolution belongs to the selected batch materialization stage after both supported nodes register');
        const created = await compare.result.workspace.createPreviewForNodeIds([goodId, badId]);
        assert.strictEqual(created.ok, false, 'a missing dependency in one row must reject the complete package');
        assert.ok(created.diagnostics.some((item) => item.blocking));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Good.xml')), false);
        assert.strictEqual(await pathExists(path.join(target, 'Documents/Ext_Bad.xml')), false);
        assert.doesNotMatch(await readUtf8(target, 'Configuration.xml'), /Ext_Good|Ext_Bad/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('a late target-side sidecar addition invalidates the captured target directory witness', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const incoming: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Ext_Item',
        uuid: UUID.catalog,
        propertiesXml: '<Comment>incoming</Comment>',
      };
      await writeDesignerConfiguration(target, {
        objects: [{ ...incoming, propertiesXml: '<Comment>target</Comment>' }],
      });
      await writeCompareBytes(target, 'Catalogs/Ext_Item/Ext/ObjectModule.bsl', 'same sidecar');
      await writeDesignerConfiguration(source, { purpose: 'Customization', namePrefix: 'Ext_', objects: [{ ...incoming, belonging: 'Own' }] });
      await writeCompareBytes(source, 'Catalogs/Ext_Item/Ext/ObjectModule.bsl', 'same sidecar');
      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        await writeCompareBytes(target, 'Catalogs/Ext_Item/Ext/late-target.bin', Buffer.from([0xca, 0xfe]));
        const created = await compare.result.workspace.createPreviewForNodeIds([nodeId]);
        assert.strictEqual(created.ok, false);
        assert.ok(created.diagnostics.some((item) => item.suggestedAction?.includes('изменился после сравнения')),
          `expected the changed target directory witness to block preview: ${JSON.stringify(created.diagnostics)}`);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs/Ext_Item/Ext/late-target.bin')), true);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('unsupported CFE markers, markerless manifest-known roots and unknown formats never fall back to CF merge', async () => {
    await withTempRoot(async (tempRoot) => {
      const cases: Array<{
        name: string;
        left: ExtensionCompareConfigurationFixture;
        right: ExtensionCompareConfigurationFixture;
        extensionBaseRoots?: ConfigurationCompareInput['extensionBaseRoots'];
      }> = [
        {
          name: 'unknown purpose',
          left: { purpose: 'FuturePurpose' },
          right: {},
        },
        {
          name: 'missing CFE root ownership marker',
          left: { purpose: 'Customization', rootObjectBelonging: null },
          right: {},
        },
        {
          name: 'invalid CFE root ownership marker',
          left: { purpose: 'Customization', rootObjectBelonging: 'Own' },
          right: {},
        },
        {
          name: 'manifest-known markerless CFE',
          left: {},
          right: {},
          extensionBaseRoots: { left: path.join(tempRoot, 'markerless-base') },
        },
        {
          name: 'unknown Designer format',
          left: { purpose: 'Customization', version: '2.22' },
          right: { version: '2.22' },
        },
        {
          name: 'EDT-style extension marker',
          left: { purpose: 'Customization', version: 'EDT' },
          right: { version: 'EDT' },
        },
      ];

      for (const scenario of cases) {
        const caseRoot = path.join(tempRoot, scenario.name.replace(/ /gu, '-'));
        const left = path.join(caseRoot, 'left');
        const right = path.join(caseRoot, 'right');
        const base = scenario.extensionBaseRoots?.left;
        if (base) {
          await writeDesignerConfiguration(base);
        }
        await writeDesignerConfiguration(left, scenario.left);
        await writeDesignerConfiguration(right, scenario.right);
        const compare = await openCompare(tempRoot, left, right, {
          extensionBaseRoots: scenario.extensionBaseRoots,
        });
        try {
          assertBlocked(compare.result, scenario.name);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('same-root and overlapping comparison roots are blocked', async () => {
    await withTempRoot(async (tempRoot) => {
      const same = path.join(tempRoot, 'same-cfe');
      await writeDesignerConfiguration(same, { purpose: 'Customization' });
      const sameRootCompare = await openCompare(tempRoot, same, same);
      try {
        assertBlocked(sameRootCompare.result, 'same comparison root');
      } finally {
        await sameRootCompare.dispose();
      }

      const left = path.join(tempRoot, 'overlap-left');
      const right = path.join(left, 'nested-right');
      await writeDesignerConfiguration(left, { purpose: 'Customization' });
      await writeDesignerConfiguration(right, { purpose: 'AddOn' });
      const overlapCompare = await openCompare(tempRoot, left, right);
      try {
        assertBlocked(overlapCompare.result, 'nested comparison roots');
      } finally {
        await overlapCompare.dispose();
      }
    });
  });
});

interface OpenCompareOptions extends Pick<ConfigurationCompareInput, 'extensionBaseRoots'> {
  withRuntime?: boolean;
}

interface OpenCompareHandle {
  result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: OpenCompareOptions = {},
): Promise<OpenCompareHandle> {
  const runtime = options.withRuntime
    ? await createMergeMutationTestRuntime(leftRootPath)
    : undefined;
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
  const tempRoot = await createExtensionCompareTempRoot();
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function onlyMergeableNodeId(result: ConfigurationCompareResult): string {
  const nodeIds = result.workspace.listMergeableNodeIds();
  assert.strictEqual(nodeIds.length, 1, `Expected one mergeable object, got ${nodeIds.length}: ${JSON.stringify({
    nodeIds,
    rows: collectNodes(result.projection.root).map((node) => ({ label: node.label, state: node.mergeState, conflict: node.conflict })),
    messages: result.session.state.messages,
  })}`);
  const selected = result.workspace.selectNodeIds(nodeIds);
  assert.strictEqual(selected.canCreatePreview, true);
  return nodeIds[0]!;
}

function nodeIdForLabel(root: CompareTreeNode, label: string): string {
  const matches = collectNodes(root).filter((node) => node.label === label);
  assert.strictEqual(matches.length, 1, `Expected one row ${label}, got ${matches.length}`);
  return matches[0]!.id;
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

async function execute(
  result: ConfigurationCompareResult,
  previewId: string,
  options: { destructiveConfirmed?: boolean } = {},
): Promise<void> {
  const approved = result.workspace.approvePreview(previewId);
  assert.strictEqual(approved.ok, true, `Preview approval failed: ${approved.diagnostics.map((item) => item.code).join(', ')}`);
  const executed = await result.workspace.executeApprovedPreview(previewId, {
    ...options,
    destructiveConfirmed: options.destructiveConfirmed ?? true,
  });
  assert.strictEqual(executed.ok, true, `Preview execution failed: ${executed.diagnostics.map((item) => item.code).join(', ')}`);
}

function assertBlocked(result: ConfigurationCompareResult, context: string): void {
  const nodes = collectNodes(result.projection.root);
  const blockingRows = nodes.filter((node) => (
    node.mergeable === false
    || node.mergeState?.state === 'blocked'
    || node.mergeState?.state === 'identityConflict'
    || node.conflict?.blocking === true
  ));
  const blockingMessages = result.session.state.messages.filter((message) => message.blocking);
  assert.strictEqual(result.workspace.payload.comparisonInfo?.mode, 'extension', `${context}: generic comparison fallback occurred`);
  assert.strictEqual(result.workspace.listMergeableNodeIds().length, 0, `${context}: blocked entries became executable`);
  assert.ok(blockingRows.length > 0 || blockingMessages.length > 0,
    `${context}: expected a visible blocking row/diagnostic; nodes=${JSON.stringify(nodes.map((node) => ({ label: node.label, kind: node.kind, mergeable: node.mergeable, mergeState: node.mergeState, conflict: node.conflict })))}`);
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
