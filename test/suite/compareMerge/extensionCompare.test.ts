import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import { pairedXmlSidecars } from '../../../src/compareMerge/extensions/extensionSemanticProjection';
import { indexExtensionMetadataRoot, type ExtensionIndexedObject, type ExtensionMetadataIndex } from '../../../src/compareMerge/extensions/extensionMetadataIndex';
import { analyzeExtensionTransfers } from '../../../src/compareMerge/extensions/extensionTransfer';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { namespaceUriForName } from '../../../src/compareMerge/adapters/semanticXml/semanticXmlIdentity';
import { METADATA_TYPE_DESCRIPTORS } from '../../../src/constants/metadataTypeDescriptors';
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
const ROOT_TYPES: readonly ExtensionCompareRootType[] = METADATA_TYPE_DESCRIPTORS.map(({ designerRootTag }) => designerRootTag);
const REGISTER_ROOT_TYPES = [
  'InformationRegister',
  'AccumulationRegister',
  'AccountingRegister',
  'CalculationRegister',
] as const satisfies readonly ExtensionCompareRootType[];

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
  test('pairs normalized owner-relative Form and Predefined sidecars without collapsing Linux case-distinct forms', async () => {
    const sidecarFiles = [
      'Forms/Main/Ext/Form.xml',
      'Forms/main/Ext/Form.xml',
      'Forms/Secondary/Ext/Form.xml',
      'Ext/Predefined.xml',
    ].map((relativePath, index) => ({ relativePath: `Catalogs/Owner/${relativePath}`, hash: String(index).padStart(64, '0') }));
    const target = indexedSidecarOwner('left-source', 'left', sidecarFiles);
    const incoming = indexedSidecarOwner('right-source', 'right', sidecarFiles);
    const result = await withPlatform('linux', async () => pairedXmlSidecars(target, incoming));

    assert.deepStrictEqual(result.duplicatePaths, []);
    assert.deepStrictEqual(result.pairs.map((pair) => pair.relativePath).sort(), [
      'Ext/Predefined.xml',
      'Forms/Main/Ext/Form.xml',
      'Forms/Secondary/Ext/Form.xml',
      'Forms/main/Ext/Form.xml',
    ]);
    assert.strictEqual(result.pairs.filter((pair) => pair.kind === 'formXml').length, 3);
    assert.strictEqual(result.pairs.filter((pair) => pair.kind === 'predefinedXml').length, 1);
  });

  test('uses and leases the exact nested Template descriptor version for its DCS sidecar', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const owner: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog, childObjectsXml: '<Template>PrintTemplate</Template>',
      };
      const writeRoots = async (targetTemplateVersion: string, sourceTemplateVersion: string) => {
        await writeDesignerConfiguration(target, { purpose: 'Customization', objects: [mdClassesFixture(owner)] });
        await writeDesignerConfiguration(source, { purpose: 'Customization', objects: [mdClassesFixture(owner)] });
        const descriptor = (version: string) =>
          `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="${version}"><Template uuid="99999999-9999-4999-8999-999999999999"><Properties><Name>PrintTemplate</Name></Properties></Template></MetaDataObject>`;
        await writeCompareBytes(target, 'Catalogs/Products/Templates/PrintTemplate.xml', descriptor(targetTemplateVersion));
        await writeCompareBytes(source, 'Catalogs/Products/Templates/PrintTemplate.xml', descriptor(sourceTemplateVersion));
        await writeCompareBytes(target, 'Catalogs/Products/Templates/PrintTemplate/Ext/Template.xml', extensionDcsXml('SELECT 1'));
        await writeCompareBytes(source, 'Catalogs/Products/Templates/PrintTemplate/Ext/Template.xml', extensionDcsXml('SELECT 2'));
      };

      await writeRoots('2.20', '2.22');
      const unsupportedVersionCompare = await openCompare(tempRoot, target, source);
      try {
        const unsupported = unsupportedVersionCompare.result.session.state.messages.find((message) =>
          message.code === 'XML_DCS_OWNER_VERSION_UNSUPPORTED',
        );
        assert.ok(unsupported, `the nested 2.22 Template must block DCS despite a 2.20 parent Catalog: ${JSON.stringify(unsupportedVersionCompare.result.session.state.messages)}`);
        assert.match(unsupported!.suggestedAction ?? '', /исходного дескриптора «2\.22»/u);
      } finally {
        await unsupportedVersionCompare.dispose();
      }

      await fs.rm(target, { recursive: true, force: true });
      await fs.rm(source, { recursive: true, force: true });
      await writeRoots('2.20', '2.20');
      const leaseCompare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const query = collectNodes(leaseCompare.result.projection.root).find((node) =>
          node.kind === 'xmlProperty' && node.payloadRef?.includes('query') && node.rightValue?.includes('SELECT 2'),
        );
        assert.ok(query, `a selected DCS query change should be available: ${JSON.stringify(collectNodes(leaseCompare.result.projection.root).map((node) => ({label: node.label, kind: node.kind, state: node.mergeState})))}`);
        const preview = await leaseCompare.result.workspace.createPreviewForNodeIds([query!.id]);
        assert.strictEqual(preview.ok, true, JSON.stringify(preview));
        if (!preview.ok) {return;}
        await fs.writeFile(path.join(source, 'Catalogs/Products/Templates/PrintTemplate.xml'),
          (await readUtf8(source, 'Catalogs/Products/Templates/PrintTemplate.xml')).replace('version="2.20"', 'version="2.21"'),
          'utf8');
        const approval = leaseCompare.result.workspace.approvePreview(preview.preview.previewId);
        assert.strictEqual(approval.ok, true, JSON.stringify(approval));
        const execution = await leaseCompare.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(execution.ok, false, JSON.stringify(execution));
        assert.ok(execution.result?.failed.some((operation) => operation.code === 'MERGE_WITNESS_MISMATCH'), JSON.stringify(execution));
        assert.strictEqual(await readUtf8(target, 'Catalogs/Products/Templates/PrintTemplate/Ext/Template.xml'), extensionDcsXml('SELECT 1'));
      } finally {
        await leaseCompare.dispose();
      }
    });
  });

  test('copies a nested Form registration with its captured package while preserving target-only siblings', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cf');
      const owner = (childObjectsXml: string): ExtensionCompareObjectFixture => {
        const fixture: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Products', uuid: UUID.catalog, childObjectsXml,
        };
        return {
          ...fixture,
          descriptorXml: metadataObjectXml(fixture)
            .replace('<MetaDataObject', '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"'),
        };
      };
      await writeDesignerConfiguration(target, { objects: [owner('')] });
      await writeDesignerConfiguration(source, { objects: [owner('<Form>Editor</Form>')] });
      const nestedDescriptor = (synonym: string): string =>
        `<?xml version="1.0"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="99999999-9999-4999-8999-999999999999"><Properties><Name>Editor</Name><Synonym>${synonym}</Synonym></Properties></Form></MetaDataObject>`;
      await writeCompareBytes(source, 'Catalogs/Products/Forms/Editor.xml', nestedDescriptor('source editor'));
      await writeCompareBytes(source, 'Catalogs/Products/Forms/Editor/Ext/Form.xml', '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Events/><ChildItems/></Form>');
      await writeCompareBytes(source, 'Catalogs/Products/Forms/Editor/Ext/Form.bin', Buffer.from([0, 255, 17]));
      await writeCompareBytes(target, 'Catalogs/Products/Forms/Existing/Ext/Form.xml', '<Form version="2.20"><WindowTitle>keep sibling</WindowTitle></Form>');
      const siblingBefore = await fs.readFile(path.join(target, 'Catalogs/Products/Forms/Existing/Ext/Form.xml'));

      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const packageRegistration = collectNodes(compare.result.projection.root).find((node) =>
          node.mergeable && node.kind === 'xmlElement' && node.label.includes('Форма') && node.rightValue?.includes('Editor'));
        assert.ok(packageRegistration, 'new nested Form registration should be selectable as a linked package');
        const preview = await createPreview(compare.result, [packageRegistration!.id]);
        await execute(compare.result, preview.previewId);

        assertMdClassesElementText(await readUtf8(target, 'Catalogs/Products.xml'), 'Form', 'Editor');
        assert.match(await readUtf8(target, 'Catalogs/Products/Forms/Editor.xml'), /source editor/u);
        assert.match(await readUtf8(target, 'Catalogs/Products/Forms/Editor/Ext/Form.xml'), /<Events\s*\/>/u);
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Products/Forms/Editor/Ext/Form.bin')), Buffer.from([0, 255, 17]));
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Products/Forms/Existing/Ext/Form.xml')), siblingBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('admits the supported root types across Designer XML 2.17–2.21', async function (this: Mocha.Context) {
    this.timeout(180000);
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

  test('copies all registry root types and nested artifacts in every own-transfer direction', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const directions = [
        { id: 'cf-to-cfe', leftCfe: true, rightCfe: false },
        { id: 'cfe-to-cf', leftCfe: false, rightCfe: true },
        { id: 'cfe-to-cfe', leftCfe: true, rightCfe: true },
      ] as const;

      for (const direction of directions) {
        const caseRoot = path.join(tempRoot, direction.id);
        const base = direction.id === 'cf-to-cfe' ? path.join(caseRoot, 'unrelated-base-cf') : undefined;
        const target = path.join(caseRoot, 'target');
        const source = path.join(caseRoot, 'source');
        const incomingObjects = createOwnTransferRegistryObjects(1, 'source');
        const targetObjects = direction.id === 'cfe-to-cfe'
          ? incomingObjects.map((object) => ({ ...object, propertiesXml: '<Comment>target version</Comment>' }))
          : [];
        await writeDesignerConfiguration(target, {
          ...(direction.leftCfe ? { purpose: 'Customization', namePrefix: 'Ext_' } : {}),
          objects: targetObjects,
        });
        await writeDesignerConfiguration(source, {
          ...(direction.rightCfe ? { purpose: 'Customization', namePrefix: 'Ext_' } : {}),
          objects: incomingObjects,
        });
        if (base) {
          await writeDesignerConfiguration(base);
        }
        if (targetObjects.length > 0) {
          await writeRegistrySidecars(target, targetObjects, 'target');
        }
        await writeRegistrySidecars(source, incomingObjects, 'source');
        const sourceBinarySnapshots = await snapshotBinaryRegistrySidecars(source, incomingObjects);

        const compare = await openCompare(tempRoot, target, source, {
          withRuntime: true,
          ...(base ? { extensionBaseRoots: { left: base } } : {}),
        });
        try {
          const nodeIds = mergeableTransferRowIds(compare.result);
          assert.strictEqual(nodeIds.length, ROOT_TYPES.length,
            `${direction.id}: every registered metadata root should be mergeable`);
          const preview = await createPreview(compare.result, nodeIds);
          await execute(compare.result, preview.previewId);

          for (const object of incomingObjects) {
            const descriptor = registryDescriptor(object.type);
            const descriptorXml = await readUtf8(target, `${descriptor.designerFolder}/${object.name}.xml`);
            assert.match(descriptorXml, new RegExp(`<${descriptor.designerRootTag} uuid="${object.uuid}"`, 'u'),
              `${direction.id}: ${object.type} descriptor should retain its UUID`);
            const markerPath = path.join(
              target,
              descriptor.designerFolder,
              object.name,
              'Ext',
              'Issue336',
              'marker.bin',
            );
            if (isBinaryRegistryRoot(object.type)) {
              assert.deepStrictEqual(await fs.readFile(markerPath), binaryRegistryMarker(),
                `${direction.id}: ${object.type} binary sidecar should preserve bytes`);
            } else {
              const copiedMarker = await fs.readFile(markerPath, 'utf8');
              assert.strictEqual(copiedMarker, `source:${object.type}:${object.name}`,
                `${direction.id}: ${object.type} nested sidecar should be copied`);
            }
            const registrations = await readUtf8(target, 'Configuration.xml');
            assert.strictEqual((registrations.match(new RegExp(`<${descriptor.designerRootTag}>${object.name}<\\/${descriptor.designerRootTag}>`, 'gu')) ?? []).length, 1,
              `${direction.id}: ${object.type} should have exactly one canonical root registration`);
          }
          for (const snapshot of sourceBinarySnapshots) {
            assert.strictEqual(sha256(await fs.readFile(snapshot.path)), snapshot.hash,
              `${direction.id}: source binary sidecars should remain unchanged`);
          }

          for (let index = 0; index < REGISTER_ROOT_TYPES.length; index += 1) {
            const registerType = REGISTER_ROOT_TYPES[index]!;
            const register = incomingObjects.find((object) => object.type === registerType);
            assert.ok(register, `${registerType} fixture should be present in the registry`);
            const folder = registryDescriptor(register.type).designerFolder;
            const children = registerChildFixtures(register, 1, index);
            const descriptorXml = await readUtf8(target, `${folder}/${register.name}.xml`);
            assert.match(descriptorXml, new RegExp(`<Dimension uuid="${children.dimensionUuid}"[^>]*>[\\s\\S]*?<Name>${children.dimensionName}</Name>[\\s\\S]*?<v8:Type>xs:string</v8:Type>[\\s\\S]*?</Dimension>`, 'u'),
              `${registerType}: copied inline Dimension should retain UUID, name and primitive type`);
            assert.match(descriptorXml, new RegExp(`<Resource uuid="${children.resourceUuid}"[^>]*>[\\s\\S]*?<Name>${children.resourceName}</Name>[\\s\\S]*?<v8:Type>xs:decimal</v8:Type>[\\s\\S]*?</Resource>`, 'u'),
              `${registerType}: copied inline Resource should retain UUID, name and primitive type`);
            assert.strictEqual(await fs.readFile(path.join(target, folder, register.name, 'Ext', 'RecordSetModule.bsl'), 'utf8'), `source:${registerType}:record-set-module`);
            assert.strictEqual(await fs.readFile(path.join(target, folder, register.name, 'Ext', 'ManagerModule.bsl'), 'utf8'), `source:${registerType}:manager-module`);
          }

          const role = incomingObjects.find((object) => object.type === 'Role');
          assert.ok(role);
          assert.match(await readUtf8(target, `Roles/${role.name}/Ext/Rights.xml`), /<name>Catalog\.Ext_Catalog<\/name>/u);
          const commonForm = incomingObjects.find((object) => object.type === 'CommonForm');
          assert.ok(commonForm);
          assert.deepStrictEqual(
            await fs.readFile(path.join(target, 'CommonForms', commonForm.name, 'Ext', 'Form.bin')),
            binaryRegistryMarker(),
          );
          assert.match(await readUtf8(target, `CommonForms/${commonForm.name}/Ext/Form.xml`), /<Form>/u);
          const subsystem = incomingObjects.find((object) => object.type === 'Subsystem');
          assert.ok(subsystem);
          assert.strictEqual(
            await fs.readFile(path.join(target, 'Subsystems', subsystem.name, 'Ext', 'Nested', 'Content.bin'), 'utf8'),
            `source:${subsystem.type}:nested`,
          );
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('copies adopted CFE objects for all registry root types and preserves target-local UUIDs', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const baseObjects = createRegistryObjects(1, 'base');
      const targetObjects = baseObjects.map((object, index) => adoptedRegistryObject(object, 2, index, 'target'));
      const sourceObjects = baseObjects.map((object, index) => adoptedRegistryObject(object, 3, index, 'source'));
      await writeDesignerConfiguration(base, { objects: baseObjects });
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: targetObjects });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: sourceObjects });
      // Adopted Role Rights are separately guarded; this whole-row fixture
      // covers descriptors and ordinary package files only.
      await writeRegistrySidecars(target, targetObjects, 'target', false);
      await writeRegistrySidecars(source, sourceObjects, 'source', false);

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const nodeIds = mergeableTransferRowIds(compare.result);
        assert.strictEqual(nodeIds.length, ROOT_TYPES.length, 'all adopted registry roots without Rights.xml should pass the existing guards');
        const preview = await createPreview(compare.result, nodeIds);
        await execute(compare.result, preview.previewId);

        for (let index = 0; index < sourceObjects.length; index += 1) {
          const sourceObject = sourceObjects[index]!;
          const targetObject = targetObjects[index]!;
          const descriptor = registryDescriptor(sourceObject.type);
          const xml = await readUtf8(target, `${descriptor.designerFolder}/${sourceObject.name}.xml`);
          assert.match(xml, new RegExp(`<${descriptor.designerRootTag} uuid="${targetObject.uuid}"`, 'u'),
            `${sourceObject.type} should retain the target-local UUID`);
          assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${baseObjects[index]!.uuid}<\\/ExtendedConfigurationObject>`, 'u'),
            `${sourceObject.type} should keep the shared base anchor`);
          if (sourceObject.type === 'Role') {
            assert.strictEqual(await pathExists(path.join(target, descriptor.designerFolder, sourceObject.name, 'Ext', 'Rights.xml')), false,
              'the adopted Role Rights sidecar is intentionally outside this whole-row fixture');
          }
          const copiedMarker = await fs.readFile(path.join(
            target,
            descriptor.designerFolder,
            sourceObject.name,
            'Ext',
            'Issue336',
            'marker.bin',
          ));
          if (isBinaryRegistryRoot(sourceObject.type)) {
            assert.deepStrictEqual(copiedMarker, binaryRegistryMarker(),
              `${sourceObject.type} should preserve its binary marker bytes`);
          } else {
            assert.strictEqual(copiedMarker.toString('utf8'), `source:${sourceObject.type}:${sourceObject.name}`);
          }
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('copies inline register Dimensions and Resources in adopted CFE transfers', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const baseObjects = REGISTER_ROOT_TYPES.map((type, index) => {
        const root: ExtensionCompareObjectFixture = {
          type,
          name: `Ext_${type}`,
          uuid: issue336Uuid(11, index),
          belonging: 'Own',
        };
        return { ...root, childObjectsXml: registerChildFixtures(root, 11, index).xml };
      });
      const targetObjects = baseObjects.map((baseObject, index) => {
        const root = adoptedRegistryObject(baseObject, 12, index, 'target');
        return { ...root, childObjectsXml: registerChildFixtures(baseObject, 12, index, 'adopted').xml };
      });
      const sourceObjects = baseObjects.map((baseObject, index) => {
        const root = adoptedRegistryObject(baseObject, 13, index, 'source');
        return { ...root, childObjectsXml: registerChildFixtures(baseObject, 13, index, 'source-dimension-own-resource').xml };
      });
      await writeDesignerConfiguration(base, { objects: baseObjects });
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: targetObjects });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: sourceObjects });
      await writeRegistrySidecars(target, targetObjects, 'target');
      await writeRegistrySidecars(source, sourceObjects, 'source');

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const nodeIds = mergeableTransferRowIds(compare.result);
        assert.strictEqual(nodeIds.length, REGISTER_ROOT_TYPES.length,
          'all four adopted register roots should remain selectable with inline children');
        const preview = await createPreview(compare.result, nodeIds);
        await execute(compare.result, preview.previewId);

        for (let index = 0; index < REGISTER_ROOT_TYPES.length; index += 1) {
          const type = REGISTER_ROOT_TYPES[index]!;
          const baseObject = baseObjects[index]!;
          const targetObject = targetObjects[index]!;
          const sourceObject = sourceObjects[index]!;
          const baseChildren = registerChildFixtures(baseObject, 11, index);
          const sourceChildren = registerChildFixtures(baseObject, 13, index, 'source-dimension-own-resource');
          const descriptor = registryDescriptor(type);
          const xml = await readUtf8(target, `${descriptor.designerFolder}/${sourceObject.name}.xml`);
          assert.match(xml, new RegExp(`<${descriptor.designerRootTag} uuid="${targetObject.uuid}"`, 'u'),
            `${type}: transfer should keep the target-local root UUID`);
          assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${baseObject.uuid}</ExtendedConfigurationObject>`, 'u'),
            `${type}: transfer should preserve the common root anchor`);
          assert.match(xml, new RegExp(`<Dimension uuid="${sourceChildren.dimensionUuid}"[^>]*>[\\s\\S]*?<ObjectBelonging>Adopted</ObjectBelonging>[\\s\\S]*?<ExtendedConfigurationObject>${baseChildren.dimensionUuid}</ExtendedConfigurationObject>[\\s\\S]*?<Name>${sourceChildren.dimensionName}</Name>[\\s\\S]*?</Dimension>`, 'u'),
            `${type}: adopted Dimension should keep the source local UUID and base-child anchor`);
          assert.match(xml, new RegExp(`<Resource uuid="${sourceChildren.resourceUuid}"[^>]*>[\\s\\S]*?<Name>${sourceChildren.resourceName}</Name>[\\s\\S]*?<v8:Type>xs:decimal</v8:Type>[\\s\\S]*?</Resource>`, 'u'),
            `${type}: own Resource should copy its source UUID, name and primitive type`);
          const resourceMatch = xml.match(/<Resource uuid="[^"]+">([\s\S]*?)<\/Resource>/u);
          assert.ok(resourceMatch);
          assert.doesNotMatch(resourceMatch[1]!, /<ObjectBelonging>|<ExtendedConfigurationObject>/u,
            `${type}: source-own Resource must not inherit adopted markers`);
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('executes an own Role whose structured Rights.xml references the target Configuration name', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.catalog,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, { name: 'TargetName' });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(source, 'Roles/Ext_Role/Ext/Rights.xml',
        '<rights><object><name>Configuration.TargetName</name></object></rights>');

      const compare = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        await execute(compare.result, preview.previewId);

        assert.strictEqual(await readUtf8(target, 'Roles/Ext_Role/Ext/Rights.xml'),
          '<rights><object><name>Configuration.TargetName</name></object></rights>');
        assert.match(await readUtf8(target, 'Configuration.xml'), /<Role>Ext_Role<\/Role>/u,
          'successful Rights dependency resolution should permit the target registration update');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('rejects execution if a proven base Configuration root changes after preview', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.catalog,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(base, { name: 'BaseName' });
      await writeDesignerConfiguration(target, {
        purpose: 'Customization',
        name: 'TargetName',
        namePrefix: 'Ext_',
      });
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        name: 'SourceName',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(source, 'Roles/Ext_Role/Ext/Rights.xml',
        '<rights><object><name>Configuration.BaseName</name></object></rights>');

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const nodeId = onlyMergeableNodeId(compare.result);
        const preview = await createPreview(compare.result, [nodeId]);
        const targetBefore = await snapshotFiles(target);
        const baseConfiguration = (await readUtf8(base, 'Configuration.xml')).replace('<Name>BaseName</Name>', '<Name>ChangedBaseName</Name>');
        await writeCompareBytes(base, 'Configuration.xml', baseConfiguration);

        const approved = compare.result.workspace.approvePreview(preview.previewId);
        assert.strictEqual(approved.ok, true, 'dependency drift is checked when the approved preview executes');
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, false, 'a changed witnessed Configuration root must invalidate the preview');
        assert.deepStrictEqual(await snapshotFiles(target), targetBefore,
          'dependency drift must leave the target configuration unchanged');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('applies the existing adopted property overlay to every registry root type', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const baseObjects = createRegistryObjects(1, 'base').map((object) => ({
        ...object,
        propertiesXml: `<Synonym>base ${object.type}</Synonym><Comment>preserve ${object.type}</Comment>`,
      }));
      const adoptedObjects = baseObjects.map((object, index) => ({
        ...adoptedRegistryObject(object, 2, index, 'source'),
        propertiesXml: `<Synonym>updated ${object.type}</Synonym>`,
      }));
      await writeDesignerConfiguration(target, { objects: baseObjects });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: adoptedObjects });

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { right: target },
      });
      try {
        const nodeIds = mergeableTransferRowIds(compare.result);
        assert.strictEqual(nodeIds.length, ROOT_TYPES.length, 'all registry roots should retain the existing overlay eligibility');
        const preview = await createPreview(compare.result, nodeIds);
        await execute(compare.result, preview.previewId);
        for (const object of baseObjects) {
          const descriptor = registryDescriptor(object.type);
          const xml = await readUtf8(target, `${descriptor.designerFolder}/${object.name}.xml`);
          assert.match(xml, new RegExp(`<Synonym>updated ${object.type}<\\/Synonym>`, 'u'));
          assert.match(xml, new RegExp(`<Comment>preserve ${object.type}<\\/Comment>`, 'u'));
          assert.match(xml, new RegExp(`<${descriptor.designerRootTag} uuid="${object.uuid}"`, 'u'));
        }
      } finally {
        await compare.dispose();
      }
    });
  });

  test('canonicalizes the FilterCriteria registration alias and detects duplicate canonical names', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const object: ExtensionCompareObjectFixture = {
        type: 'FilterCriterion',
        name: 'Ext_Filter',
        uuid: UUID.catalog,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target);
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [object],
        registrations: [
          { type: 'FilterCriterion', name: object.name, rootTag: 'FilterCriteria' },
          { type: 'FilterCriterion', name: object.name },
        ],
      });
      const duplicate = await openCompare(tempRoot, target, source);
      try {
        assertBlocked(duplicate.result, 'alias and canonical registrations share one qualified identity');
      } finally {
        await duplicate.dispose();
      }

      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [object],
        registrations: [{ type: 'FilterCriterion', name: object.name, rootTag: 'FilterCriteria' }],
      });
      const aliasOnly = await openCompare(tempRoot, target, source, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(aliasOnly.result);
        const preview = await createPreview(aliasOnly.result, [nodeId]);
        await execute(aliasOnly.result, preview.previewId);
        assert.strictEqual(await pathExists(path.join(target, 'FilterCriteria/Ext_Filter.xml')), true);
        assert.match(await readUtf8(target, 'Configuration.xml'), /<FilterCriterion>Ext_Filter<\/FilterCriterion>/u);
      } finally {
        await aliasOnly.dispose();
      }

      const descriptorAliasTarget = path.join(tempRoot, 'descriptor-alias-target-cf');
      const descriptorAliasSource = path.join(tempRoot, 'descriptor-alias-source-cfe');
      const descriptorAliasObject: ExtensionCompareObjectFixture = {
        ...object,
        name: 'Ext_FilterDescriptorAlias',
        uuid: UUID.catalogOther,
        descriptorRootTag: 'FilterCriteria',
      };
      await writeDesignerConfiguration(descriptorAliasTarget);
      await writeDesignerConfiguration(descriptorAliasSource, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [descriptorAliasObject],
        registrations: [{ type: 'FilterCriterion', name: descriptorAliasObject.name }],
      });
      const descriptorAliasCopy = await openCompare(tempRoot, descriptorAliasTarget, descriptorAliasSource, { withRuntime: true });
      try {
        const nodeId = onlyMergeableNodeId(descriptorAliasCopy.result);
        const preview = await createPreview(descriptorAliasCopy.result, [nodeId]);
        await execute(descriptorAliasCopy.result, preview.previewId);
        assert.match(
          await readUtf8(descriptorAliasTarget, 'FilterCriteria/Ext_FilterDescriptorAlias.xml'),
          /<FilterCriteria uuid=/u,
          'full copy preserves the registered descriptor alias bytes',
        );
      } finally {
        await descriptorAliasCopy.dispose();
      }

      const base = path.join(tempRoot, 'adopted-alias-base-cf');
      const targetCfe = path.join(tempRoot, 'adopted-alias-target-cfe');
      const sourceCfe = path.join(tempRoot, 'adopted-alias-source-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'FilterCriterion',
        name: 'Base_Filter',
        uuid: UUID.commonModule,
      };
      const targetAdopted: ExtensionCompareObjectFixture = {
        ...baseObject,
        uuid: UUID.commonModuleLocal,
        belonging: 'Adopted',
        anchorUuid: baseObject.uuid,
      };
      const sourceAdopted: ExtensionCompareObjectFixture = {
        ...targetAdopted,
        uuid: UUID.secondCatalog,
        descriptorRootTag: 'FilterCriteria',
        propertiesXml: '<Synonym>source alias</Synonym>',
      };
      await writeDesignerConfiguration(base, { objects: [baseObject] });
      await writeDesignerConfiguration(targetCfe, { purpose: 'Customization', objects: [targetAdopted] });
      await writeDesignerConfiguration(sourceCfe, { purpose: 'Customization', objects: [sourceAdopted] });
      const unsafeAliasAdoptedCopy = await openCompare(tempRoot, targetCfe, sourceCfe, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const row = collectNodes(unsafeAliasAdoptedCopy.result.projection.root)
          .find((node) => node.label === 'FilterCriterion.Base_Filter');
        assert.ok(row, 'the canonical identity should remain visible for the alias descriptor');
        assert.strictEqual(row.mergeable, false, 'analysis must block alias UUID rebinding before materialization');
        assert.ok(row.mergeState?.reason, 'the unsupported descriptor shape must have an analysis reason');
      } finally {
        await unsafeAliasAdoptedCopy.dispose();
      }

      const overlaySource = path.join(tempRoot, 'adopted-alias-overlay-cfe');
      await writeDesignerConfiguration(overlaySource, { purpose: 'Customization', objects: [sourceAdopted] });
      const unsafeAliasOverlay = await openCompare(tempRoot, base, overlaySource, {
        extensionBaseRoots: { right: base },
      });
      try {
        const row = collectNodes(unsafeAliasOverlay.result.projection.root)
          .find((node) => node.label === 'FilterCriterion.Base_Filter');
        assert.ok(row, 'the canonical identity should remain visible for the alias overlay descriptor');
        assert.strictEqual(row.mergeable, false, 'the existing property overlay must not claim an alias-root descriptor is mergeable');
        assert.ok(row.mergeState?.reason, 'the alias overlay should explain why it is blocked');
      } finally {
        await unsafeAliasOverlay.dispose();
      }
    });
  });

  test('rejects a borrowed source without InternalInfo during analysis', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const extension = path.join(tempRoot, 'extension-cfe');
      const baseReport: ExtensionCompareObjectFixture = {
        type: 'Report',
        name: 'BaseReport',
        uuid: UUID.catalog,
        descriptorXml: `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject version="2.20"><Report uuid="${UUID.catalog}"><Properties><Name>BaseReport</Name></Properties><ChildObjects/></Report></MetaDataObject>`,
      };
      await writeDesignerConfiguration(base, {
        objects: [baseReport],
      });
      await writeDesignerConfiguration(extension, { purpose: 'Customization' });

      const compare = await openCompare(tempRoot, extension, base, {
        extensionBaseRoots: { left: base },
      });
      try {
        const row = collectNodes(compare.result.projection.root).find((node) => node.label === 'Report.BaseReport');
        assert.ok(row, 'the base object should remain visible in extension analysis');
        assert.strictEqual(row.mergeable, false, 'an invalid source descriptor must not be shown as executable');
        assert.ok(row.mergeState?.reason?.includes('InternalInfo'), 'analysis should explain the invalid generated type source shape');
      } finally {
        await compare.dispose();
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

  test('CF→CFE creates a source-derived borrowed shell while omitting base children and modules', async () => {
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
        assert.match(targetDescriptor, /<Comment>base-only comment<\/Comment>/u,
          'the shell should retain the source common Comment property');
        assert.doesNotMatch(targetDescriptor, /PrivateBaseAttribute/u,
          'the source base child body should not be copied into the adopted shell');
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

  test('CF→CFE accepts an updated export against the target extension’s older proven base', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'older-base-cf');
      const source = path.join(tempRoot, 'updated-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        propertiesXml: '<Synonym>base synonym</Synonym><Comment>base comment</Comment>',
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        ...baseObject,
        propertiesXml: '<Synonym>updated from current CF</Synonym><Comment>base comment</Comment>',
      };
      const adoptedObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        propertiesXml: '<Synonym>base synonym</Synonym><Comment>local extension note</Comment>',
      };
      await writeDesignerConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeDesignerConfiguration(source, { name: 'Shared configuration', objects: [mdClassesFixture(sourceObject)] });
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: [mdClassesFixture(adoptedObject)] });
      const baseBefore = await fs.readFile(path.join(base, 'Catalogs/Products.xml'));
      const sourceBefore = await fs.readFile(path.join(source, 'Catalogs/Products.xml'));

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base },
      });
      try {
        const row = collectNodes(compare.result.projection.root)
          .find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row, 'the proven adopted object should remain visible');
        assert.strictEqual(row!.mergeable, false, 'the old whole-row transfer gate must remain closed for a stale base snapshot');
        const synonym = collectNodes(row!).find((node) => node.rightValue?.includes('updated from current CF')
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'));
        assert.ok(synonym, `the changed inherited property should be projected as a granular child: ${JSON.stringify(collectNodes(row!).map((node) => ({ label: node.label, rightValue: node.rightValue, mergeable: node.mergeable, state: node.mergeState, conflict: node.conflict })))}`);
        assert.strictEqual(synonym!.mergeable, true, synonym!.mergeState?.reason ?? synonym!.conflict?.message);
        const preview = await createPreview(compare.result, [synonym!.id]);
        await execute(compare.result, preview.previewId);

        const output = await readUtf8(target, 'Catalogs/Products.xml');
        assert.match(output, new RegExp(`<Catalog uuid="${UUID.catalogLocal}"`, 'u'));
        assert.match(output, new RegExp(`<ExtendedConfigurationObject>${UUID.catalog}</ExtendedConfigurationObject>`, 'u'));
        assertMdClassesElementText(output, 'Synonym', 'updated from current CF');
        assert.match(output, /<Comment>local extension note<\/Comment>/u,
          'the selected base update must preserve the extension’s unrelated local property');
        assert.deepStrictEqual(await fs.readFile(path.join(source, 'Catalogs/Products.xml')), sourceBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(base, 'Catalogs/Products.xml')), baseBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps adopted TemplateType and body transitions read-only while allowing an unrelated property in both directions', async () => {
    for (const direction of ['cf-to-cfe', 'cfe-to-cf', 'cfe-cfe-adopted'] as const) {
      await withTempRoot(async (tempRoot) => {
        const base = path.join(tempRoot, 'old-base-cf');
        const target = path.join(tempRoot, direction === 'cf-to-cfe' || direction === 'cfe-cfe-adopted' ? 'target-cfe' : 'current-target-cf');
        const incoming = path.join(tempRoot, direction === 'cf-to-cfe' ? 'updated-source-cf' : 'incoming-cfe');
        const oldTemplate: ExtensionCompareObjectFixture = {
          type: 'CommonTemplate', name: 'Print', uuid: UUID.catalog,
          propertiesXml: '<TemplateType>SpreadsheetDocument</TemplateType><Synonym>Base</Synonym>',
        };
        const updatedTemplate: ExtensionCompareObjectFixture = {
          ...oldTemplate,
          propertiesXml: '<TemplateType>HTMLDocument</TemplateType><Synonym>Selected synonym</Synonym>',
        };
        const adoptedTemplate: ExtensionCompareObjectFixture = {
          ...oldTemplate,
          uuid: UUID.catalogLocal,
          belonging: 'Adopted',
          anchorUuid: UUID.catalog,
          propertiesXml: '<TemplateType>SpreadsheetDocument</TemplateType><Synonym>Target-only synonym</Synonym>',
        };
        await writeDesignerConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(oldTemplate)] });
        if (direction === 'cf-to-cfe') {
          await writeDesignerConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture(adoptedTemplate)] });
          await writeDesignerConfiguration(incoming, { name: 'Shared configuration', objects: [mdClassesFixture(updatedTemplate)] });
          await writeCompareBytes(target, 'CommonTemplates/Print/Ext/Template.xml', '<spreadsheet>target old body</spreadsheet>');
          await writeCompareBytes(incoming, 'CommonTemplates/Print/Ext/Template.html', '<html>incoming new body</html>');
        } else if (direction === 'cfe-cfe-adopted') {
          const updatedAdoptedTemplate = { ...adoptedTemplate, propertiesXml: '<TemplateType>HTMLDocument</TemplateType><Synonym>Selected synonym</Synonym>' };
          await writeDesignerConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture(adoptedTemplate)] });
          await writeDesignerConfiguration(incoming, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture(updatedAdoptedTemplate)] });
          await writeCompareBytes(target, 'CommonTemplates/Print/Ext/Template.xml', '<spreadsheet>target old body</spreadsheet>');
          await writeCompareBytes(incoming, 'CommonTemplates/Print/Ext/Template.html', '<html>incoming new body</html>');
        } else {
          await writeDesignerConfiguration(target, { name: 'Shared configuration', objects: [mdClassesFixture(oldTemplate)] });
          await writeDesignerConfiguration(incoming, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture({ ...adoptedTemplate, propertiesXml: '<TemplateType>HTMLDocument</TemplateType><Synonym>Selected synonym</Synonym>' })] });
          await writeCompareBytes(target, 'CommonTemplates/Print/Ext/Template.xml', '<spreadsheet>target old body</spreadsheet>');
          await writeCompareBytes(incoming, 'CommonTemplates/Print/Ext/Template.html', '<html>incoming new body</html>');
        }

        const compare = await openCompare(tempRoot, target, incoming, {
          extensionBaseRoots: direction === 'cf-to-cfe' ? { left: base }
            : direction === 'cfe-to-cf' ? { right: base } : { left: base, right: base },
        });
        try {
          const nodes = collectNodes(compare.result.projection.root);
          const templateType = nodes.find((node) => node.kind === 'xmlProperty' && node.label === 'TemplateType'
            && node.rightValue === 'HTMLDocument'
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('CommonTemplates/Print.xml'));
          assert.ok(templateType, `${direction}: changed TemplateType should remain visible in the adopted descriptor`);
          assert.strictEqual(templateType!.mergeable, false,
            `${direction}: TemplateType must not be independently selected without a captured body bundle`);
          const synonym = nodes.find((node) => node.kind === 'xmlProperty' && node.label === 'Synonym'
            && node.rightValue === 'Selected synonym'
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('CommonTemplates/Print.xml'));
          assert.ok(synonym, `${direction}: the unrelated Synonym change should remain visible`);
          assert.strictEqual(synonym!.mergeable, true,
            `${direction}: a scoped TemplateType blocker must not disable unrelated supported properties`);
          const templateTransitions = nodes.filter((node) => node.kind === 'linkedTemplateTypeTransition'
            && (node.label.includes('SpreadsheetDocument') || node.label.includes('HTMLDocument')));
          assert.ok(templateTransitions.every((node) => node.mergeable !== true),
            `${direction}: an adopted transition must not borrow an unproven stale body bundle`);
          const bodyNodes = nodes.filter((node) => node.kind === 'fileArtifact'
            && ['Template.xml', 'Template.html'].some((name) => (node.mergeState?.targetFilePath ?? '').endsWith(name)));
          assert.ok(bodyNodes.every((node) => node.mergeable !== true),
            `${direction}: body-only changes must not bypass the blocked TemplateType transition`);
        } finally {
          await compare.dispose();
        }
      });
    }
  });

  test('applies a selected inherited metadata child reorder in CF→CFE', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'updated-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const attributeUuid = new Map([
        ['First', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        ['Second', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ]);
      const attributes = (names: readonly string[]): string => names.map((name) =>
        `<Attribute uuid="${attributeUuid.get(name)}"><Properties><Name>${name}</Name></Properties></Attribute>`,
      ).join('');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        childObjectsXml: attributes(['First', 'Second']),
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        ...baseObject,
        childObjectsXml: attributes(['Second', 'First']),
      };
      const adoptedObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        childObjectsXml: '',
      };
      await writeAdoptedProjectionConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeAdoptedProjectionConfiguration(source, { name: 'Shared configuration', objects: [mdClassesFixture(sourceObject)] });
      await writeAdoptedProjectionConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture(adoptedObject)] });
      const baseDescriptorBefore = await fs.readFile(path.join(base, 'Catalogs/Products.xml'));
      const sourceDescriptorBefore = await fs.readFile(path.join(source, 'Catalogs/Products.xml'));

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base }, withRuntime: true });
      try {
        const ordered = collectNodes(compare.result.projection.root).filter((node) =>
          node.kind === 'metadataOrderMove' && node.mergeable === true
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'),
        );
        assert.ok(ordered.length > 0,
          `the inherited reorder should be selectable: ${JSON.stringify(collectNodes(compare.result.projection.root).map((node) => ({ label: node.label, kind: node.kind, target: node.mergeState?.targetFilePath, mergeable: node.mergeable })))}`);
        const targetDescriptorBefore = await fs.readFile(path.join(target, 'Catalogs/Products.xml'));
        const preview = await createPreview(compare.result, ordered.map((node) => node.id));
        assert.ok(preview.items.some((item) => item.previewPath?.replace(/\\/gu, '/').endsWith('Catalogs/Products.xml')),
          `the selected order must produce a target descriptor write: ${JSON.stringify(preview.items)}`);
        const approved = compare.result.workspace.approvePreview(preview.previewId);
        assert.strictEqual(approved.ok, true, JSON.stringify(approved));
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));

        const output = await readUtf8(target, 'Catalogs/Products.xml');
        const snapshot = metadataChildSnapshot(output, 'Catalog');
        assert.deepStrictEqual(snapshot.children.map((child) => child.name), ['Second', 'First']);
        assert.strictEqual(snapshot.uuid, UUID.catalogLocal, 'the adopted owner keeps its target-local UUID');
        assert.strictEqual(snapshot.belonging, 'Adopted');
        assert.strictEqual(snapshot.anchorUuid, UUID.catalog, 'the adopted owner keeps its base anchor');
        assert.deepStrictEqual(snapshot.children.map((child) => child.belonging), ['Adopted', 'Adopted']);
        assert.deepStrictEqual(snapshot.children.map((child) => child.anchorUuid), [attributeUuid.get('Second'), attributeUuid.get('First')]);
        assert.ok(snapshot.children.every((child) => child.uuid !== attributeUuid.get(child.name)),
          'materialized borrowed children have local UUIDs distinct from their base anchors');
        assert.deepStrictEqual(await fs.readFile(path.join(base, 'Catalogs/Products.xml')), baseDescriptorBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(source, 'Catalogs/Products.xml')), sourceDescriptorBefore);
        assert.notDeepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Products.xml')), targetDescriptorBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('applies a selected inherited EnumValue reorder in CF→CFE', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'updated-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const values = new Map([
        ['First', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        ['Second', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ]);
      const enumValues = (names: readonly string[]): string => names.map((name) =>
        `<EnumValue uuid="${values.get(name)}"><Properties><Name>${name}</Name></Properties></EnumValue>`,
      ).join('');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Enum', name: 'Statuses', uuid: UUID.catalog,
        childObjectsXml: enumValues(['First', 'Second']),
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        ...baseObject,
        childObjectsXml: enumValues(['Second', 'First']),
      };
      const adoptedObject: ExtensionCompareObjectFixture = {
        type: 'Enum', name: 'Statuses', uuid: UUID.catalogLocal,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        childObjectsXml: '',
      };
      await writeAdoptedProjectionConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeAdoptedProjectionConfiguration(source, { name: 'Shared configuration', objects: [mdClassesFixture(sourceObject)] });
      await writeAdoptedProjectionConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture(adoptedObject)] });
      const baseDescriptorBefore = await fs.readFile(path.join(base, 'Enums/Statuses.xml'));
      const sourceDescriptorBefore = await fs.readFile(path.join(source, 'Enums/Statuses.xml'));

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base }, withRuntime: true });
      try {
        const ordered = collectNodes(compare.result.projection.root).filter((node) =>
          node.kind === 'metadataOrderMove' && node.mergeable === true
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Enums/Statuses.xml'),
        );
        assert.ok(ordered.length > 0,
          `the inherited EnumValue reorder should be selectable: ${JSON.stringify(collectNodes(compare.result.projection.root).map((node) => ({ label: node.label, kind: node.kind, target: node.mergeState?.targetFilePath, mergeable: node.mergeable })))}`);
        const targetDescriptorBefore = await fs.readFile(path.join(target, 'Enums/Statuses.xml'));
        const preview = await createPreview(compare.result, ordered.map((node) => node.id));
        assert.ok(preview.items.some((item) => item.previewPath?.replace(/\\/gu, '/').endsWith('Enums/Statuses.xml')),
          `the selected EnumValue order must produce a target descriptor write: ${JSON.stringify(preview.items)}`);
        const approved = compare.result.workspace.approvePreview(preview.previewId);
        assert.strictEqual(approved.ok, true, JSON.stringify(approved));
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));

        const output = await readUtf8(target, 'Enums/Statuses.xml');
        const snapshot = metadataChildSnapshot(output, 'Enum');
        assert.deepStrictEqual(snapshot.children.map((child) => child.name), ['Second', 'First']);
        assert.strictEqual(snapshot.uuid, UUID.catalogLocal, 'the adopted Enum keeps its target-local UUID');
        assert.strictEqual(snapshot.belonging, 'Adopted');
        assert.strictEqual(snapshot.anchorUuid, UUID.catalog, 'the adopted Enum keeps its base anchor');
        assert.deepStrictEqual(snapshot.children.map((child) => child.belonging), ['Adopted', 'Adopted']);
        assert.deepStrictEqual(snapshot.children.map((child) => child.anchorUuid), [values.get('Second'), values.get('First')]);
        assert.ok(snapshot.children.every((child) => child.uuid !== values.get(child.name)),
          'materialized EnumValues have local UUIDs distinct from their base anchors');
        assert.deepStrictEqual(await fs.readFile(path.join(base, 'Enums/Statuses.xml')), baseDescriptorBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(source, 'Enums/Statuses.xml')), sourceDescriptorBefore);
        assert.notDeepStrictEqual(await fs.readFile(path.join(target, 'Enums/Statuses.xml')), targetDescriptorBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps reordered borrowed Form sections read-only in CF→CFE semantic projection', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'updated-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const formUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const localFormUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const owner = (uuid: string, belonging?: 'Adopted', anchorUuid?: string): ExtensionCompareObjectFixture => ({
        type: 'Catalog', name: 'Products', uuid, belonging, anchorUuid,
        childObjectsXml: '<Form>Editor</Form>',
      });
      const formDescriptor = (uuid: string, belonging?: 'Adopted', anchorUuid?: string): string => {
        const ownership = belonging ? `<ObjectBelonging>${belonging}</ObjectBelonging>` : '';
        const anchor = anchorUuid ? `<ExtendedConfigurationObject>${anchorUuid}</ExtendedConfigurationObject>` : '';
        return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${uuid}"><Properties>${ownership}<Name>Editor</Name>${anchor}</Properties></Form></MetaDataObject>`;
      };
      const formIds = new Map([['First', 1], ['Second', 2]]);
      const formXml = (names: readonly string[]): string =>
        `<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><AutoCommandBar name="Auto" id="-1"/><ChildItems/><Attributes>${names.map((name) => `<Attribute name="${name}" id="${formIds.get(name)}"/>`).join('')}</Attributes><Commands/><Parameters/></Form>`;
      const writeFormPackage = async (root: string, descriptor: string, attributes: readonly string[]): Promise<void> => {
        await writeCompareBytes(root, 'Catalogs/Products/Forms/Editor.xml', descriptor);
        await writeCompareBytes(root, 'Catalogs/Products/Forms/Editor/Ext/Form.xml', formXml(attributes));
      };

      await writeDesignerConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(owner(UUID.catalog))] });
      await writeDesignerConfiguration(source, { name: 'Shared configuration', objects: [mdClassesFixture(owner(UUID.catalog))] });
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: [mdClassesFixture(owner(UUID.catalogLocal, 'Adopted', UUID.catalog))] });
      await writeFormPackage(base, formDescriptor(formUuid), ['First', 'Second']);
      await writeFormPackage(source, formDescriptor(formUuid), ['Second', 'First']);
      await writeCompareBytes(target, 'Catalogs/Products/Forms/Editor.xml', formDescriptor(localFormUuid, 'Adopted', formUuid));

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        const projected = collectNodes(compare.result.projection.root);
        const attributes = projected.find((node) => node.kind === 'formGroup' && node.label === 'Attributes');
        assert.deepStrictEqual(attributes?.children.map((node) => node.label), ['Second', 'First'],
          'the borrowed Form projection must compare the captured source sequence using stable element IDs');
        const mergeableMoves = projected.filter((node) => node.kind === 'metadataOrderMove' && node.mergeable
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products/Forms/Editor/Ext/Form.xml'));
        assert.strictEqual(mergeableMoves.length, 0,
          'the adopted Form route must not offer a reorder operation that its encoder cannot preserve');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CF applies selected adopted changes against the source extension’s older base', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'older-base-cf');
      const target = path.join(tempRoot, 'current-target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        propertiesXml: '<Synonym>old base</Synonym><Comment>old base comment</Comment>',
      };
      const targetObject: ExtensionCompareObjectFixture = {
        ...baseObject,
        propertiesXml: '<Synonym>current target</Synonym><Comment>target-only detail</Comment>',
      };
      const adoptedObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        propertiesXml: '<Synonym>extension selection</Synonym>',
      };
      await writeDesignerConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeDesignerConfiguration(target, { name: 'Shared configuration', objects: [mdClassesFixture(targetObject)] });
      await writeDesignerConfiguration(source, { purpose: 'Customization', objects: [mdClassesFixture(adoptedObject)] });
      const baseBefore = await fs.readFile(path.join(base, 'Catalogs/Products.xml'));
      const sourceBefore = await fs.readFile(path.join(source, 'Catalogs/Products.xml'));

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { right: base },
      });
      try {
        const row = collectNodes(compare.result.projection.root)
          .find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row, 'the exact target owner should remain visible');
        assert.strictEqual(row!.mergeable, false, 'the whole-row action must retain its exact-base gate');
        const synonym = collectNodes(row!).find((node) => node.rightValue?.includes('extension selection')
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'));
        assert.ok(synonym, `the adopted overlay should be compared over the captured old base: ${JSON.stringify(collectNodes(row!).map((node) => ({ label: node.label, rightValue: node.rightValue, mergeable: node.mergeable, state: node.mergeState, conflict: node.conflict })))}`);
        assert.strictEqual(synonym!.mergeable, true, synonym!.mergeState?.reason ?? synonym!.conflict?.message);
        const preview = await createPreview(compare.result, [synonym!.id]);
        await execute(compare.result, preview.previewId);

        const output = await readUtf8(target, 'Catalogs/Products.xml');
        assert.match(output, new RegExp(`<Catalog uuid="${UUID.catalog}"`, 'u'));
        assert.doesNotMatch(output, /ObjectBelonging|ExtendedConfigurationObject/u);
        assertMdClassesElementText(output, 'Synonym', 'extension selection');
        assert.match(output, /<Comment>target-only detail<\/Comment>/u,
          'the current target CF is the logical target; old base bytes must not replace its unselected properties');
        assert.deepStrictEqual(await fs.readFile(path.join(base, 'Catalogs/Products.xml')), baseBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(source, 'Catalogs/Products.xml')), sourceBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('semantic-only adopted projection rejects different CF configuration identity, wrong anchor, and ambiguous base owner', async () => {
    await withTempRoot(async (tempRoot) => {
      const cases = [
        { id: 'configuration UUID', baseUuid: UUID.targetConfiguration, sourceUuid: UUID.sourceConfiguration },
        { id: 'configuration name', baseName: 'Older name', sourceName: 'Current name' },
        { id: 'adopted anchor', anchorUuid: UUID.catalogOther },
        { id: 'ambiguous base owner', duplicate: true },
      ];
      for (const [index, item] of cases.entries()) {
        const caseRoot = path.join(tempRoot, `proof-${index}`);
        const base = path.join(caseRoot, 'base');
        const source = path.join(caseRoot, 'source');
        const target = path.join(caseRoot, 'target');
        const baseObject: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Products', uuid: UUID.catalog,
          propertiesXml: '<Synonym>base</Synonym>',
        };
        const duplicate = item.duplicate ? {
          type: 'Catalog' as const, name: 'Other', uuid: UUID.catalog,
        } : undefined;
        await writeDesignerConfiguration(base, {
          uuid: item.baseUuid,
          name: item.baseName ?? 'Shared configuration',
          objects: duplicate ? [mdClassesFixture(baseObject), mdClassesFixture(duplicate)] : [mdClassesFixture(baseObject)],
        });
        await writeDesignerConfiguration(source, {
          uuid: item.sourceUuid,
          name: item.sourceName ?? 'Shared configuration',
          objects: [mdClassesFixture({ ...baseObject, propertiesXml: '<Synonym>current</Synonym>' })],
        });
        await writeDesignerConfiguration(target, {
          purpose: 'Customization',
          objects: [mdClassesFixture({
            type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
            belonging: 'Adopted', anchorUuid: item.anchorUuid ?? UUID.catalog,
            propertiesXml: '<Synonym>base</Synonym>',
          })],
        });
        const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
        try {
          const row = collectNodes(compare.result.projection.root)
            .find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
          assert.ok(row, `${item.id}: the row remains visible for diagnosis`);
          assert.strictEqual(row!.mergeable, false, `${item.id}: whole-row transfer stays blocked`);
          assert.strictEqual(collectNodes(row!).some((node) => node.id !== row!.id && node.mergeable), false,
            `${item.id}: no semantic child may bypass a failed proof`);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('keeps a borrowed Role Rights sidecar read-only without an unambiguous Extended marker', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'rights-old-base');
      const current = path.join(tempRoot, 'rights-current-cf');
      const extension = path.join(tempRoot, 'rights-cfe');
      const baseRole = mdClassesFixture({
        type: 'Role', name: 'Sales', uuid: UUID.catalog,
        propertiesXml: '<Comment>base role</Comment>',
      });
      const currentRole = mdClassesFixture({
        type: 'Role', name: 'Sales', uuid: UUID.catalog,
        propertiesXml: '<Comment>current role</Comment>',
      });
      const adoptedRole = mdClassesFixture({
        type: 'Role', name: 'Sales', uuid: UUID.catalogLocal,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        propertiesXml: '<Comment>extension role</Comment>',
      });
      await writeAdoptedProjectionConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseRole)] });
      await writeAdoptedProjectionConfiguration(current, { name: 'Shared configuration', objects: [mdClassesFixture(currentRole)] });
      await writeAdoptedProjectionConfiguration(extension, { purpose: 'Customization', name: 'Shared configuration', objects: [mdClassesFixture(adoptedRole)] });
      await writeCompareBytes(base, 'Roles/Sales/Ext/Rights.xml', extensionRoleRightsXml('false'));
      await writeCompareBytes(current, 'Roles/Sales/Ext/Rights.xml', extensionRoleRightsXml('true'));
      await writeCompareBytes(extension, 'Roles/Sales/Ext/Rights.xml', extensionRoleRightsXml('false'));

      const cfToCfe = await openCompare(tempRoot, extension, current, {
        extensionBaseRoots: { left: base },
      });
      try {
        const row = collectNodes(cfToCfe.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Role.Sales',
        );
        assert.ok(row, 'the borrowed Role row is visible');
        const blockers = collectNodes(row!).filter((node) => node.kind === 'roleRightsProjectionBlocker');
        assert.strictEqual(blockers.length, 1, 'the changed Rights sidecar is represented by a scoped blocker');
        assert.strictEqual(blockers[0]!.mergeable, false);
        assert.strictEqual(blockers[0]!.mergeState?.reason,
          'target adopted Rights.xml присутствует без однозначного Rights=Extended PropertyState.');
        assert.strictEqual(collectNodes(row!).some((node) => node.kind === 'xmlProperty'
          && node.payloadRef?.includes('rights-right') && node.mergeable), false,
        'the raw Role Rights adapter never emits executable right patches for a borrowed owner');
        assert.strictEqual(collectNodes(row!).some((node) => node.id !== row!.id && node.mergeable), true,
          'the independent descriptor projection remains available');
      } finally {
        await cfToCfe.dispose();
      }

      const cfeToCf = await openCompare(tempRoot, current, extension, {
        extensionBaseRoots: { right: base },
      });
      try {
        const row = collectNodes(cfeToCf.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Role.Sales',
        );
        assert.ok(row, 'the reverse borrowed Role row is visible');
        const blockers = collectNodes(row!).filter((node) => node.kind === 'roleRightsProjectionBlocker');
        assert.strictEqual(blockers.length, 1);
        assert.strictEqual(blockers[0]!.mergeable, false);
        assert.strictEqual(blockers[0]!.mergeState?.reason,
          'source adopted Rights.xml присутствует без однозначного Rights=Extended PropertyState.');
        assert.strictEqual(collectNodes(row!).some((node) => node.kind === 'xmlProperty'
          && node.payloadRef?.includes('rights-right') && node.mergeable), false);
      } finally {
        await cfeToCf.dispose();
      }
    });
  });

  test('semantic-only proof rejects unsupported selected owners and duplicate qualified base identities', async () => {
    const baseObject = semanticIndexedObject({
      sourceId: 'base-cf', side: 'left', ownership: 'own', uuid: UUID.catalog,
      descriptorRelativePath: 'Catalogs/Products.xml',
    });
    const currentObject = semanticIndexedObject({
      sourceId: 'current-cf', side: 'right', ownership: 'own', uuid: UUID.catalog,
      descriptorRelativePath: 'Catalogs/Products.xml',
    });
    const targetObject = semanticIndexedObject({
      sourceId: 'target-cfe', side: 'left', ownership: 'adopted', uuid: UUID.catalogLocal,
      anchorUuid: UUID.catalog, descriptorRelativePath: 'Catalogs/Products.xml',
    });
    const incomingObject = semanticIndexedObject({
      sourceId: 'current-cf', side: 'right', ownership: 'own', uuid: UUID.catalog,
      descriptorRelativePath: 'Catalogs/Products.xml',
    });
    const baseRoot = semanticIndex('base-cf', 'left', 'cf', [baseObject]);
    const currentRoot = semanticIndex('current-cf', 'right', 'cf', [currentObject]);
    const targetRoot = semanticIndex('target-cfe', 'left', 'cfe', [targetObject]);
    const incomingRoot = semanticIndex('current-cf', 'right', 'cf', [incomingObject]);

    const unsupportedTargetRoot = semanticIndex('target-cfe', 'left', 'cfe', [
      { ...targetObject, unsupportedReason: 'Unsupported selected target descriptor shape.' },
    ]);
    const unsupportedAnalysis = await analyzeExtensionTransfers({
      target: unsupportedTargetRoot,
      incoming: incomingRoot,
      targetBase: baseRoot,
      targetBaseIsIncoming: false,
      incomingBaseIsTarget: false,
    });
    assert.strictEqual(unsupportedAnalysis.rows[0]!.semanticAction, undefined,
      'an otherwise valid target with an unsupported descriptor must not receive the semantic-only capability');

    const duplicateBaseObject = semanticIndexedObject({
      sourceId: 'base-cf', side: 'left', ownership: 'own', uuid: UUID.catalogOther,
      descriptorRelativePath: 'Catalogs/ProductsDuplicate.xml',
    });
    const duplicateBaseRoot = semanticIndex('base-cf', 'left', 'cf', [baseObject, duplicateBaseObject]);
    const duplicateAnalysis = await analyzeExtensionTransfers({
      target: targetRoot,
      incoming: incomingRoot,
      targetBase: duplicateBaseRoot,
      targetBaseIsIncoming: false,
      incomingBaseIsTarget: false,
    });
    assert.strictEqual(duplicateAnalysis.rows[0]!.semanticAction, undefined,
      'a second own descriptor with the same qualified name but another UUID makes the selected base identity ambiguous');
  });

  test('an unselected source-only object cannot satisfy an adopted Type reference in the target', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'older-base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'current-cf');
      const baseDimensionUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const targetDimensionUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const baseProduct: ExtensionCompareObjectFixture = {
        type: 'Catalog',
        name: 'Products',
        uuid: UUID.catalog,
        childObjectsXml: `<Dimension uuid="${baseDimensionUuid}"><Properties><Name>Length</Name><Type xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><v8:Type>xs:string</v8:Type></Type></Properties></Dimension>`,
      };
      const sourceProduct: ExtensionCompareObjectFixture = {
        ...baseProduct,
        childObjectsXml: `<Dimension uuid="${baseDimensionUuid}"><Properties><Name>Length</Name><Type xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"><v8:Type>cfg:CatalogRef.SourceOnly</v8:Type></Type></Properties></Dimension>`,
      };
      const targetProduct: ExtensionCompareObjectFixture = {
        ...baseProduct,
        uuid: UUID.catalogLocal,
        belonging: 'Adopted',
        anchorUuid: UUID.catalog,
        childObjectsXml: `<Dimension uuid="${targetDimensionUuid}"><Properties><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${baseDimensionUuid}</ExtendedConfigurationObject><Name>Length</Name><Type xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><v8:Type>xs:string</v8:Type></Type></Properties></Dimension>`,
      };
      await writeDesignerConfiguration(base, { objects: [mdClassesFixture(baseProduct)] });
      await writeDesignerConfiguration(target, { purpose: 'Customization', objects: [mdClassesFixture(targetProduct)] });
      await writeDesignerConfiguration(source, {
        objects: [
          mdClassesFixture(sourceProduct),
          mdClassesFixture({ type: 'Catalog', name: 'SourceOnly', uuid: UUID.catalogOther }),
        ],
      });

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        const row = collectNodes(compare.result.projection.root)
          .find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row, 'the adopted owner remains visible');
        const matchingType = collectNodes(row!).filter((node) => node.rightValue?.includes('CatalogRef.SourceOnly'));
        assert.strictEqual(matchingType.some((node) => node.mergeable), false,
          'the incoming-only Catalog.SourceOnly registration is not present in the target or its captured base');
        const blockedFile = collectNodes(row!).find((node) => node.kind === 'extensionSemanticFile'
          && node.mergeState?.state === 'blocked');
        assert.ok(blockedFile, 'the descriptor-level reference error should remain visible as a blocking file diagnostic');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('cross-boundary adopted Rights materialize CF omission as an explicit CFE deny', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'older-base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'current-cf');
      const roleUuid = UUID.commonModule;
      const roleLocalUuid = UUID.commonModuleLocal;
      const baseCatalog: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
      };
      const targetCatalog: ExtensionCompareObjectFixture = {
        ...baseCatalog, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog,
      };
      const baseRole: ExtensionCompareObjectFixture = {
        type: 'Role', name: 'Ext_Role', uuid: roleUuid, propertiesXml: '<Comment>base</Comment>',
      };
      const targetRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        uuid: roleLocalUuid,
        belonging: 'Adopted',
        anchorUuid: roleUuid,
        descriptorXml: `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20"><Role uuid="${roleLocalUuid}"><InternalInfo><xr:GeneratedType name="RoleRef" uuid="${roleUuid}"/><xr:PropertyState><xr:Property>Rights</xr:Property><xr:State>Extended</xr:State></xr:PropertyState></InternalInfo><Properties><Name>Ext_Role</Name><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${roleUuid}</ExtendedConfigurationObject></Properties><ChildObjects/></Role></MetaDataObject>`,
      };
      const sourceRole: ExtensionCompareObjectFixture = {
        ...baseRole,
        propertiesXml: '<Comment>current</Comment>',
      };
      const rightsXml = (right?: string) => `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><setForNewObjects>false</setForNewObjects><setForAttributesByDefault>true</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects><object><name>Catalog.Products</name>${right ?? ''}</object></Rights>`;
      const readRight = '<right><name>Read</name><value>true</value></right>';

      await writeAdoptedProjectionConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseCatalog), mdClassesFixture(baseRole)] });
      await writeAdoptedProjectionConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', namePrefix: 'Ext_', objects: [mdClassesFixture(targetCatalog), mdClassesFixture(targetRole)] });
      await writeAdoptedProjectionConfiguration(source, { name: 'Shared configuration', objects: [mdClassesFixture(baseCatalog), mdClassesFixture(sourceRole)] });
      await writeCompareBytes(base, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(readRight));
      await writeCompareBytes(target, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml(readRight));
      // In Rights.xml 2.20, omission resolves to setForNewObjects=false. A raw delete in the CFE overlay would instead inherit the proven base's true value.
      await writeCompareBytes(source, 'Roles/Ext_Role/Ext/Rights.xml', rightsXml());

      const sourceRights = rightsXml();
      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base },
        withRuntime: true,
      });
      try {
        const owner = collectNodes(compare.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Role.Ext_Role');
        assert.ok(owner, 'the Role row remains visible');
        assert.ok(collectNodes(owner!).some((node) => node.kind === 'xmlProperty' && node.label === 'Comment' && node.mergeable === true),
          `the valid adopted descriptor delta remains independently selectable: ${JSON.stringify(collectNodes(owner!).map((node) => ({ id: node.id, label: node.label, kind: node.kind, mergeable: node.mergeable, mergeState: node.mergeState, conflict: node.conflict })))}`);
        const right = collectNodes(owner!).find((node) => (node.kind === 'xmlProperty' || node.kind === 'roleRight')
          && node.payloadRef && decodeURIComponent(node.payloadRef).toLowerCase().includes('rights-object=catalog.products')
          && decodeURIComponent(node.payloadRef).toLowerCase().includes('rights-right=read'));
        assert.ok(right?.mergeable, `CF omission is projected as the effective deny and remains selectable: ${JSON.stringify(collectNodes(owner!).map((node) => ({ id: node.id, label: node.label, kind: node.kind, mergeable: node.mergeable, mergeState: node.mergeState, conflict: node.conflict, payloadRef: node.payloadRef })))}`);
        const preview = await createPreview(compare.result, [right!.id]);
        assert.strictEqual(compare.result.workspace.approvePreview(preview.previewId).ok, true);
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
        assert.match(await readUtf8(target, 'Roles/Ext_Role/Ext/Rights.xml'), /<right><name>Read<\/name><value>false<\/value><\/right>/u,
          'the deny remains explicit in the CFE overlay instead of deleting the override');
        const materializedRoleDescriptor = await readUtf8(target, 'Roles/Ext_Role.xml');
        assert.doesNotMatch(materializedRoleDescriptor, /<Comment>current<\/Comment>/u,
          'the unselected source Comment is not materialized into the CFE overlay');
        assert.match(await readUtf8(base, 'Roles/Ext_Role.xml'), /<Comment>base<\/Comment>/u,
          'the target continues to inherit its unchanged base Comment');
        assert.match(await readUtf8(target, 'Roles/Ext_Role.xml'), /<xr:Property>Rights<\/xr:Property><xr:State>Extended<\/xr:State>/u);
        assert.strictEqual(await readUtf8(source, 'Roles/Ext_Role/Ext/Rights.xml'), sourceRights,
          'the source CF Rights file is only read and remains byte-for-byte unchanged');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('an older captured CF base changing after preview invalidates adopted semantic execution', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'older-base-cf');
      const source = path.join(tempRoot, 'updated-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        propertiesXml: '<Synonym>base</Synonym>',
      };
      await writeDesignerConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeDesignerConfiguration(source, {
        name: 'Shared configuration',
        objects: [mdClassesFixture({ ...baseObject, propertiesXml: '<Synonym>updated source</Synonym>' })],
      });
      await writeDesignerConfiguration(target, {
        purpose: 'Customization',
        objects: [mdClassesFixture({
          type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
          belonging: 'Adopted', anchorUuid: UUID.catalog,
          propertiesXml: '<Synonym>base</Synonym>',
        })],
      });
      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base },
      });
      try {
        const row = collectNodes(compare.result.projection.root)
          .find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row);
        const synonym = collectNodes(row!).find((node) => node.rightValue?.includes('updated source')
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'));
        assert.ok(synonym, 'the supported property should be available before dependency drift');
        const preview = await createPreview(compare.result, [synonym!.id]);
        const targetBefore = await fs.readFile(path.join(target, 'Catalogs/Products.xml'));
        await writeCompareBytes(base, 'Catalogs/Products.xml', (await readUtf8(base, 'Catalogs/Products.xml')).replace('>base<', '>edited after preview<'));

        const approved = compare.result.workspace.approvePreview(preview.previewId);
        assert.strictEqual(approved.ok, true);
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, false);
        assert.ok(executed.result?.failed.some((item) => item.code === 'MERGE_WITNESS_MISMATCH'),
          JSON.stringify(executed.result?.failed));
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Products.xml')), targetBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('an older CF Configuration.xml witness is rechecked before adopted semantic execution', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'older-base-cf');
      const source = path.join(tempRoot, 'updated-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        propertiesXml: '<Synonym>base</Synonym>',
      };
      await writeDesignerConfiguration(base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeDesignerConfiguration(source, {
        name: 'Shared configuration',
        objects: [mdClassesFixture({ ...baseObject, propertiesXml: '<Synonym>current source</Synonym>' })],
      });
      await writeDesignerConfiguration(target, {
        purpose: 'Customization',
        objects: [mdClassesFixture({
          type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
          belonging: 'Adopted', anchorUuid: UUID.catalog,
          propertiesXml: '<Synonym>base</Synonym>',
        })],
      });
      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base },
      });
      try {
        const row = collectNodes(compare.result.projection.root)
          .find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row);
        const synonym = collectNodes(row!).find((node) => node.rightValue?.includes('current source')
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'));
        assert.ok(synonym, 'the source update should be selectable before configuration drift');
        const preview = await createPreview(compare.result, [synonym!.id]);
        const targetBefore = await fs.readFile(path.join(target, 'Catalogs/Products.xml'));
        const config = await readUtf8(base, 'Configuration.xml');
        await writeCompareBytes(base, 'Configuration.xml', config.replace('Shared configuration', 'Changed after preview'));

        assert.strictEqual(compare.result.workspace.approvePreview(preview.previewId).ok, true);
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, false);
        assert.ok(executed.result?.failed.some((item) => item.code === 'MERGE_WITNESS_MISMATCH'),
          JSON.stringify(executed.result?.failed));
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Products.xml')), targetBefore);
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

  test('CFE→CFE adopted granular merge preserves target-only properties and rejects stale source, target, or second base', async () => {
    await withTempRoot(async (tempRoot) => {
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        propertiesXml: '<Comment>Base comment</Comment><Synonym>Base synonym</Synonym>',
      };
      const targetObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalogLocal,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        propertiesXml: '<Comment>Target comment</Comment><Synonym>Target-only synonym</Synonym>',
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalogOther,
        belonging: 'Adopted', anchorUuid: UUID.catalog,
        propertiesXml: '<Comment>Source comment</Comment>',
      };
      const paths = {
        target: path.join(tempRoot, 'target-cfe'),
        source: path.join(tempRoot, 'source-cfe'),
        targetBase: path.join(tempRoot, 'target-base-cf'),
        sourceBase: path.join(tempRoot, 'source-base-cf'),
      };
      const writeFixture = async (): Promise<void> => {
        await writeAdoptedProjectionConfiguration(paths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await writeAdoptedProjectionConfiguration(paths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await writeAdoptedProjectionConfiguration(paths.target, { purpose: 'Customization', objects: [mdClassesFixture(targetObject)] });
        await writeAdoptedProjectionConfiguration(paths.source, { purpose: 'Customization', objects: [mdClassesFixture(sourceObject)] });
      };
      await writeFixture();
      await fs.copyFile(
        path.join(paths.targetBase, 'Configuration.xml'),
        path.join(paths.sourceBase, 'Configuration.xml'),
      );
      await fs.copyFile(
        path.join(paths.targetBase, 'Catalogs/Products.xml'),
        path.join(paths.sourceBase, 'Catalogs/Products.xml'),
      );
      const [targetIndex, sourceIndex, targetBaseIndex, sourceBaseIndex] = await Promise.all([
        indexExtensionMetadataRoot({ rootPath: paths.target, sourceId: 'left-source', side: 'left' }),
        indexExtensionMetadataRoot({ rootPath: paths.source, sourceId: 'right-source', side: 'right' }),
        indexExtensionMetadataRoot({ rootPath: paths.targetBase, sourceId: 'left-base', side: 'left' }),
        indexExtensionMetadataRoot({ rootPath: paths.sourceBase, sourceId: 'right-base', side: 'right' }),
      ]);
      const transfer = await analyzeExtensionTransfers({
        target: targetIndex,
        incoming: sourceIndex,
        targetBase: targetBaseIndex,
        incomingBase: sourceBaseIndex,
        targetBaseIsIncoming: false,
        incomingBaseIsTarget: false,
      });
      const analyzedRow = transfer.rows.find((row) => row.qualifiedName === 'Catalog.Products');
      assert.strictEqual(analyzedRow?.sameProvenBase, true, `the fixture has separately captured exact common bases: ${JSON.stringify({ configuration: [targetBaseIndex.configurationUuid, sourceBaseIndex.configurationUuid, targetBaseIndex.configurationHash, sourceBaseIndex.configurationHash], format: [targetBaseIndex.formatVersion, sourceBaseIndex.formatVersion], owner: [targetBaseIndex.objects[0]?.descriptorHash, sourceBaseIndex.objects[0]?.descriptorHash], row: { semanticAction: analyzedRow?.semanticAction, reason: analyzedRow?.reason } })}`);

      const targetBaseBefore = await fs.readFile(path.join(paths.targetBase, 'Catalogs/Products.xml'));
      const sourceBaseBefore = await fs.readFile(path.join(paths.sourceBase, 'Catalogs/Products.xml'));
      const sourceBefore = await fs.readFile(path.join(paths.source, 'Catalogs/Products.xml'));
      const compare = await openCompare(tempRoot, paths.target, paths.source, {
        withRuntime: true,
        extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
      });
      try {
        const owner = collectNodes(compare.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(owner, 'the adopted row is matched across CFE roots');
        const comment = owner && collectNodes(owner).find((node) => node.kind === 'xmlProperty'
          && node.label === 'Comment' && node.mergeable && node.rightValue?.includes('Source comment'));
        assert.ok(comment, `the separately proven host projection exposes the source Comment as a granular leaf; children=${JSON.stringify(owner && collectNodes(owner).map((node) => ({ kind: node.kind, label: node.label, status: node.status, mergeable: node.mergeable, conflict: node.conflict, mergeState: node.mergeState, rightValue: node.rightValue })))}`);
        if (!comment) { return; }
        const preview = await createPreview(compare.result, [comment.id]);
        await execute(compare.result, preview.previewId);

        const targetXml = await readUtf8(paths.target, 'Catalogs/Products.xml');
        assert.match(targetXml, new RegExp(`<Catalog uuid="${UUID.catalogLocal}"`, 'u'));
        assert.match(targetXml, new RegExp(`<ExtendedConfigurationObject>${UUID.catalog}</ExtendedConfigurationObject>`, 'u'));
        assertMdClassesElementText(targetXml, 'Comment', 'Source comment');
        assertMdClassesElementText(targetXml, 'Synonym', 'Target-only synonym');
        assert.deepStrictEqual(await fs.readFile(path.join(paths.source, 'Catalogs/Products.xml')), sourceBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.targetBase, 'Catalogs/Products.xml')), targetBaseBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.sourceBase, 'Catalogs/Products.xml')), sourceBaseBefore);
      } finally {
        await compare.dispose();
      }

      for (const staleSide of ['source', 'target', 'sourceBase'] as const) {
        const caseRoot = path.join(tempRoot, `stale-${staleSide}`);
        const casePaths = {
          target: path.join(caseRoot, 'target-cfe'),
          source: path.join(caseRoot, 'source-cfe'),
          targetBase: path.join(caseRoot, 'target-base-cf'),
          sourceBase: path.join(caseRoot, 'source-base-cf'),
        };
        await writeAdoptedProjectionConfiguration(casePaths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await writeAdoptedProjectionConfiguration(casePaths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await fs.copyFile(
          path.join(casePaths.targetBase, 'Configuration.xml'),
          path.join(casePaths.sourceBase, 'Configuration.xml'),
        );
        await fs.copyFile(
          path.join(casePaths.targetBase, 'Catalogs/Products.xml'),
          path.join(casePaths.sourceBase, 'Catalogs/Products.xml'),
        );
        await writeAdoptedProjectionConfiguration(casePaths.target, { purpose: 'Customization', objects: [mdClassesFixture(targetObject)] });
        await writeAdoptedProjectionConfiguration(casePaths.source, { purpose: 'Customization', objects: [mdClassesFixture(sourceObject)] });
        const staleCompare = await openCompare(tempRoot, casePaths.target, casePaths.source, {
          withRuntime: true,
          extensionBaseRoots: { left: casePaths.targetBase, right: casePaths.sourceBase },
        });
        try {
          const owner = collectNodes(staleCompare.result.projection.root).find((node) =>
            node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
          const comment = owner && collectNodes(owner).find((node) => node.kind === 'xmlProperty'
            && node.label === 'Comment' && node.mergeable && node.rightValue?.includes('Source comment'));
          assert.ok(comment, `${staleSide}: semantic Comment should be available before drift`);
          if (!comment) { continue; }
          const preview = await createPreview(staleCompare.result, [comment.id]);
          const targetBefore = await fs.readFile(path.join(casePaths.target, 'Catalogs/Products.xml'));
          const driftRoot = casePaths[staleSide];
          const staleText = staleSide === 'target' ? 'Target comment' : staleSide === 'source' ? 'Source comment' : 'Base comment';
          const driftedPath = await writeCompareBytes(driftRoot, 'Catalogs/Products.xml',
            (await readUtf8(driftRoot, 'Catalogs/Products.xml')).replace(staleText, 'drift after preview'));
          const driftedBytes = await fs.readFile(driftedPath);
          assert.strictEqual(staleCompare.result.workspace.approvePreview(preview.previewId).ok, true);
          const executed = await staleCompare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, false, `${staleSide} drift must invalidate the approved semantic operation`);
          assert.ok(executed.result?.failed.some((item) => item.code === 'MERGE_WITNESS_MISMATCH'),
            `${staleSide}: ${JSON.stringify(executed.result?.failed)}`);
          assert.deepStrictEqual(await fs.readFile(path.join(casePaths.target, 'Catalogs/Products.xml')),
            staleSide === 'target' ? driftedBytes : targetBefore,
            `${staleSide} drift must not be overwritten by a partial semantic write`);
        } finally {
          await staleCompare.dispose();
        }
      }
    });
  });

  test('CFE→CFE selected Form execution rejects drift in the second captured base body', async () => {
    await withTempRoot(async (tempRoot) => {
      const paths = {
        target: path.join(tempRoot, 'target-cfe'),
        source: path.join(tempRoot, 'source-cfe'),
        targetBase: path.join(tempRoot, 'target-base-cf'),
        sourceBase: path.join(tempRoot, 'source-base-cf'),
      };
      const formBaseUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const formTargetUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const formSourceUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const formDescriptor = (uuid: string, adopted = false): string =>
        `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20"><Form uuid="${uuid}"><Properties><Name>Main</Name>${adopted ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${formBaseUuid}</ExtendedConfigurationObject>` : ''}</Properties><InternalInfo><xr:GeneratedType name="FormRef.Main" category="Ref"><xr:TypeId>dddddddd-dddd-4ddd-8ddd-dddddddddddd</xr:TypeId></xr:GeneratedType></InternalInfo></Form></MetaDataObject>`;
      const formBody = (title: string, baseSnapshot?: string): string =>
        `<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><AutoCommandBar name="FormCommandBar" id="-1"/><ChildItems><Button name="Apply" id="1"><Title>${title}</Title></Button></ChildItems><Attributes/><Commands/><Parameters/>${baseSnapshot === undefined ? '' : `<BaseForm version="2.20"><ChildItems><Button name="Apply" id="1"><Title>${baseSnapshot}</Title></Button></ChildItems></BaseForm>`}</Form>`;
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog, childObjectsXml: '<Form>Main</Form>',
      };
      const targetObject: ExtensionCompareObjectFixture = {
        ...baseObject, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog,
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        ...baseObject, uuid: UUID.catalogOther, belonging: 'Adopted', anchorUuid: UUID.catalog,
      };
      await writeAdoptedProjectionConfiguration(paths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeAdoptedProjectionConfiguration(paths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
      await writeAdoptedProjectionConfiguration(paths.target, { purpose: 'Customization', objects: [mdClassesFixture(targetObject)] });
      await writeAdoptedProjectionConfiguration(paths.source, { purpose: 'Customization', objects: [mdClassesFixture(sourceObject)] });
      for (const root of [paths.targetBase, paths.sourceBase]) {
        await writeCompareBytes(root, 'Catalogs/Products/Forms/Main.xml', formDescriptor(formBaseUuid));
        await writeCompareBytes(root, 'Catalogs/Products/Forms/Main/Ext/Form.xml', formBody('Base form'));
      }
      await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Main.xml', formDescriptor(formTargetUuid, true));
      await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Main/Ext/Form.xml', formBody('Target form', 'Target base snapshot'));
      await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Main.xml', formDescriptor(formSourceUuid, true));
      await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Main/Ext/Form.xml', formBody('Source form', 'Source base snapshot'));

      const compare = await openCompare(tempRoot, paths.target, paths.source, {
        withRuntime: true,
        extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
      });
      try {
        const owner = collectNodes(compare.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(owner);
        const form = owner && collectNodes(owner).find((node) => node.mergeable
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products/Forms/Main/Ext/Form.xml')
          && node.rightValue?.includes('Source form'));
        assert.ok(form, `the proven source Form body is available as a granular artifact; nodes=${JSON.stringify(owner && collectNodes(owner).map((node) => ({ kind: node.kind, label: node.label, mergeable: node.mergeable, conflict: node.conflict, mergeState: node.mergeState, rightValue: node.rightValue })))}`);
        if (!form) { return; }
        const preview = await createPreview(compare.result, [form.id]);
        const targetBefore = await fs.readFile(path.join(paths.target, 'Catalogs/Products/Forms/Main/Ext/Form.xml'));
        await writeCompareBytes(paths.sourceBase, 'Catalogs/Products/Forms/Main/Ext/Form.xml', formBody('Changed after preview'));

        assert.strictEqual(compare.result.workspace.approvePreview(preview.previewId).ok, true);
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, false, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
        assert.ok(executed.result?.failed.some((item) => item.code === 'MERGE_WITNESS_MISMATCH'),
          JSON.stringify(executed.result?.failed));
        assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Catalogs/Products/Forms/Main/Ext/Form.xml')), targetBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CFE copies a registered own Form package under a matched adopted owner', async () => {
    await withTempRoot(async (tempRoot) => {
      const paths = {
        target: path.join(tempRoot, 'target-cfe'),
        source: path.join(tempRoot, 'source-cfe'),
        targetBase: path.join(tempRoot, 'target-base-cf'),
        sourceBase: path.join(tempRoot, 'source-base-cf'),
      };
      const formUuid = '99999999-9999-4999-8999-999999999999';
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog, childObjectsXml: '',
      };
      const targetObject: ExtensionCompareObjectFixture = {
        ...baseObject, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog,
        childObjectsXml: '<Form>Keep</Form>',
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        ...baseObject, uuid: UUID.catalogOther, belonging: 'Adopted', anchorUuid: UUID.catalog,
        childObjectsXml: '<Form>Added</Form>',
      };
      await writeAdoptedProjectionConfiguration(paths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeAdoptedProjectionConfiguration(paths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
      await writeAdoptedProjectionConfiguration(paths.target, { purpose: 'Customization', objects: [mdClassesFixture(targetObject)] });
      await writeAdoptedProjectionConfiguration(paths.source, { purpose: 'Customization', objects: [mdClassesFixture(sourceObject)] });
      const formDescriptor = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${formUuid}"><Properties><Name>Added</Name></Properties></Form></MetaDataObject>`;
      await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added.xml', formDescriptor);
      await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added/Ext/Form.xml', '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>source own form</WindowTitle></Form>');
      const keepUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Keep.xml', `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${keepUuid}"><Properties><Name>Keep</Name></Properties></Form></MetaDataObject>`);
      await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Keep/Ext/Form.xml', '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>target own sibling</WindowTitle></Form>');

      const compare = await openCompare(tempRoot, paths.target, paths.source, {
        withRuntime: true,
        extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
      });
      try {
        const owner = collectNodes(compare.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(owner, 'the matched adopted owner should be visible');
        const registration = owner && collectNodes(owner).find((node) => node.kind === 'xmlElement'
          && node.label === 'Форма: Added' && node.status === 'rightOnly');
        assert.ok(registration?.mergeable, `the own Form registration should be selectable with its complete package: ${JSON.stringify(owner && collectNodes(owner).map((node) => ({ kind: node.kind, label: node.label, status: node.status, leftValue: node.leftValue, rightValue: node.rightValue, mergeable: node.mergeable, reason: node.mergeState?.reason })))}`);
        if (!registration) { return; }
        const preview = await createPreview(compare.result, [registration.id]);
        await execute(compare.result, preview.previewId);

        const targetOwnerXml = await readUtf8(paths.target, 'Catalogs/Products.xml');
        assertMdClassesElementTexts(targetOwnerXml, 'Form', ['Keep', 'Added']);
        assert.strictEqual(await readUtf8(paths.target, 'Catalogs/Products/Forms/Added.xml'), formDescriptor);
        assert.match(await readUtf8(paths.target, 'Catalogs/Products/Forms/Added/Ext/Form.xml'), /source own form/u);
        assert.match(await readUtf8(paths.target, 'Catalogs/Products/Forms/Keep/Ext/Form.xml'), /target own sibling/u);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.targetBase, 'Catalogs/Products.xml')),
          await fs.readFile(path.join(paths.sourceBase, 'Catalogs/Products.xml')));
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CF↔CFE copies registered own Form packages without changing the captured base', async () => {
    await withTempRoot(async (tempRoot) => {
      const cases = [
        { id: 'cf-to-cfe', targetKind: 'cfe' as const, sourceKind: 'cf' as const, baseSide: 'left' as const },
        { id: 'cfe-to-cf', targetKind: 'cf' as const, sourceKind: 'cfe' as const, baseSide: 'right' as const },
      ];
      const formUuid = '99999999-9999-4999-8999-999999999999';
      const keepUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const formDescriptor = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${formUuid}"><Properties><Name>Added</Name></Properties></Form></MetaDataObject>`;
      const keepDescriptor = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${keepUuid}"><Properties><Name>Keep</Name></Properties></Form></MetaDataObject>`;
      const formBody = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>standalone own form</WindowTitle></Form>';
      const keepBody = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>target-only own sibling</WindowTitle></Form>';

      for (const item of cases) {
        const caseRoot = path.join(tempRoot, item.id);
        const paths = {
          base: path.join(caseRoot, 'base-cf'),
          target: path.join(caseRoot, `target-${item.targetKind}`),
          source: path.join(caseRoot, `source-${item.sourceKind}`),
        };
        const baseObject: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Products', uuid: UUID.catalog, childObjectsXml: '',
        };
        const targetObject: ExtensionCompareObjectFixture = item.targetKind === 'cfe'
          ? { ...baseObject, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog, childObjectsXml: '<Form>Keep</Form>' }
          : { ...baseObject, childObjectsXml: '<Form>Keep</Form>' };
        const sourceObject: ExtensionCompareObjectFixture = item.sourceKind === 'cfe'
          ? { ...baseObject, uuid: UUID.catalogOther, belonging: 'Adopted', anchorUuid: UUID.catalog, childObjectsXml: '<Form>Added</Form>' }
          : { ...baseObject, childObjectsXml: '<Form>Added</Form>' };

        await writeAdoptedProjectionConfiguration(paths.base, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await writeAdoptedProjectionConfiguration(paths.target, {
          ...(item.targetKind === 'cfe' ? { purpose: 'Customization' } : {}),
          objects: [mdClassesFixture(targetObject)],
        });
        await writeAdoptedProjectionConfiguration(paths.source, {
          ...(item.sourceKind === 'cfe' ? { purpose: 'Customization' } : {}),
          objects: [mdClassesFixture(sourceObject)],
        });
        if (item.targetKind === 'cf') {
          await fs.copyFile(path.join(paths.base, 'Configuration.xml'), path.join(paths.target, 'Configuration.xml'));
        }
        if (item.sourceKind === 'cf') {
          await fs.copyFile(path.join(paths.base, 'Configuration.xml'), path.join(paths.source, 'Configuration.xml'));
        }
        await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Keep.xml', keepDescriptor);
        await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Keep/Ext/Form.xml', keepBody);
        await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added.xml', formDescriptor);
        await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added/Ext/Form.xml', formBody);

        const baseBefore = await fs.readFile(path.join(paths.base, 'Catalogs/Products.xml'));
        const sourceBefore = await fs.readFile(path.join(paths.source, 'Catalogs/Products.xml'));
        const compare = await openCompare(tempRoot, paths.target, paths.source, {
          withRuntime: true,
          extensionBaseRoots: item.baseSide === 'left' ? { left: paths.base } : { right: paths.base },
        });
        try {
          const owner = collectNodes(compare.result.projection.root).find((node) =>
            node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
          const registration = owner && collectNodes(owner).find((node) => node.kind === 'xmlElement'
            && node.label === 'Форма: Added' && node.status === 'rightOnly');
          assert.ok(registration?.mergeable, `${item.id}: new own Form should be a selectable registration with a validated package`);
          if (!registration) { continue; }
          const preview = await createPreview(compare.result, [registration.id]);
          await execute(compare.result, preview.previewId);

          const targetOwnerXml = await readUtf8(paths.target, 'Catalogs/Products.xml');
          assertMdClassesElementTexts(targetOwnerXml, 'Form', ['Keep', 'Added']);
          assert.strictEqual(await readUtf8(paths.target, 'Catalogs/Products/Forms/Added.xml'), formDescriptor);
          assert.strictEqual(await readUtf8(paths.target, 'Catalogs/Products/Forms/Added/Ext/Form.xml'), formBody);
          assert.strictEqual(await readUtf8(paths.target, 'Catalogs/Products/Forms/Keep/Ext/Form.xml'), keepBody);
          assert.deepStrictEqual(await fs.readFile(path.join(paths.source, 'Catalogs/Products.xml')), sourceBefore,
            `${item.id}: source owner descriptor is unchanged`);
          assert.deepStrictEqual(await fs.readFile(path.join(paths.base, 'Catalogs/Products.xml')), baseBefore,
            `${item.id}: captured base owner descriptor is unchanged`);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('CFE→CFE updates a matched own Form body as a standalone form', async () => {
    await withTempRoot(async (tempRoot) => {
      const paths = {
        target: path.join(tempRoot, 'target-cfe'),
        source: path.join(tempRoot, 'source-cfe'),
        targetBase: path.join(tempRoot, 'target-base-cf'),
        sourceBase: path.join(tempRoot, 'source-base-cf'),
      };
      const formUuid = '99999999-9999-4999-8999-999999999999';
      const baseObject: ExtensionCompareObjectFixture = {
        type: 'Catalog', name: 'Products', uuid: UUID.catalog,
      };
      const targetObject: ExtensionCompareObjectFixture = {
        ...baseObject, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog,
        childObjectsXml: '<Form>Existing</Form>',
      };
      const sourceObject: ExtensionCompareObjectFixture = {
        ...baseObject, uuid: UUID.catalogOther, belonging: 'Adopted', anchorUuid: UUID.catalog,
        childObjectsXml: '<Form>Existing</Form>',
      };
      const descriptor = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${formUuid}"><Properties><Name>Existing</Name></Properties></Form></MetaDataObject>`;
      const targetBody = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>target own form</WindowTitle></Form>';
      const sourceBody = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>source own form</WindowTitle></Form>';
      await writeAdoptedProjectionConfiguration(paths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await writeAdoptedProjectionConfiguration(paths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
      await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
      await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
      await writeAdoptedProjectionConfiguration(paths.target, { purpose: 'Customization', objects: [mdClassesFixture(targetObject)] });
      await writeAdoptedProjectionConfiguration(paths.source, { purpose: 'Customization', objects: [mdClassesFixture(sourceObject)] });
      await fs.copyFile(path.join(paths.target, 'Configuration.xml'), path.join(paths.source, 'Configuration.xml'));
      for (const root of [paths.target, paths.source]) {
        await writeCompareBytes(root, 'Catalogs/Products/Forms/Existing.xml', descriptor);
      }
      await writeCompareBytes(paths.target, 'Catalogs/Products/Forms/Existing/Ext/Form.xml', targetBody);
      await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Existing/Ext/Form.xml', sourceBody);
      const sourceOwnerBefore = await fs.readFile(path.join(paths.source, 'Catalogs/Products.xml'));
      const baseOwnerBefore = await fs.readFile(path.join(paths.targetBase, 'Catalogs/Products.xml'));

      const compare = await openCompare(tempRoot, paths.target, paths.source, {
        withRuntime: true,
        extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
      });
      try {
        const owner = collectNodes(compare.result.projection.root).find((node) =>
          node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        const formChange = owner && collectNodes(owner).find((node) => node.mergeable
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products/Forms/Existing/Ext/Form.xml')
          && node.rightValue?.includes('source own form'));
        assert.ok(formChange, `a matched outside-base own Form should use the standalone form adapter: ${JSON.stringify(owner && collectNodes(owner).map((node) => ({ kind: node.kind, label: node.label, mergeable: node.mergeable, mergeState: node.mergeState, rightValue: node.rightValue })))}`);
        if (!formChange) { return; }
        const preview = await createPreview(compare.result, [formChange.id]);
        await execute(compare.result, preview.previewId);

        const writtenBody = await readUtf8(paths.target, 'Catalogs/Products/Forms/Existing/Ext/Form.xml');
        assert.match(writtenBody, /source own form/u);
        assert.doesNotMatch(writtenBody, /<BaseForm\b/u, 'a matched own Form must remain standalone');
        assert.strictEqual(await readUtf8(paths.target, 'Catalogs/Products/Forms/Existing.xml'), descriptor);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.source, 'Catalogs/Products.xml')), sourceOwnerBefore);
        assert.deepStrictEqual(await fs.readFile(path.join(paths.targetBase, 'Catalogs/Products.xml')), baseOwnerBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('CFE→CFE keeps own Form packages read-only when nested descriptor ChildObjects has unsafe UUIDs', async () => {
    await withTempRoot(async (tempRoot) => {
      const formUuid = '99999999-9999-4999-8999-999999999999';
      const childUuid = '88888888-8888-4888-8888-888888888888';
      const cases = [
        {
          id: 'colliding child UUID',
          childObjects: `<Attribute uuid="${childUuid}"><Properties><Name>Nested</Name></Properties></Attribute>`,
        },
        {
          id: 'invalid child UUID',
          childObjects: '<Attribute uuid="invalid-uuid"><Properties><Name>Nested</Name></Properties></Attribute>',
        },
        {
          id: 'duplicate child UUID',
          childObjects: `<Attribute uuid="${childUuid}"><Properties><Name>First</Name></Properties></Attribute><Attribute uuid="${childUuid}"><Properties><Name>Second</Name></Properties></Attribute>`,
        },
      ];

      for (const item of cases) {
        const caseRoot = path.join(tempRoot, item.id.replace(/\s/gu, '-'));
        const paths = {
          target: path.join(caseRoot, 'target-cfe'),
          source: path.join(caseRoot, 'source-cfe'),
          targetBase: path.join(caseRoot, 'target-base-cf'),
          sourceBase: path.join(caseRoot, 'source-base-cf'),
        };
        const baseObject: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Products', uuid: UUID.catalog,
        };
        const targetObject: ExtensionCompareObjectFixture = {
          ...baseObject, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog,
        };
        const sourceObject: ExtensionCompareObjectFixture = {
          ...baseObject, uuid: UUID.catalogOther, belonging: 'Adopted', anchorUuid: UUID.catalog,
          childObjectsXml: '<Form>Added</Form>',
        };
        const otherOwner: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Other', uuid: childUuid,
        };
        await writeAdoptedProjectionConfiguration(paths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await writeAdoptedProjectionConfiguration(paths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
        await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
        await writeAdoptedProjectionConfiguration(paths.target, { purpose: 'Customization', objects: [mdClassesFixture(targetObject), mdClassesFixture(otherOwner)] });
        await writeAdoptedProjectionConfiguration(paths.source, { purpose: 'Customization', objects: [mdClassesFixture(sourceObject)] });
        const sourceFormDescriptor = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${formUuid}"><Properties><Name>Added</Name></Properties><ChildObjects>${item.childObjects}</ChildObjects></Form></MetaDataObject>`;
        await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added.xml', sourceFormDescriptor);
        await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added/Ext/Form.xml', '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>source own form</WindowTitle></Form>');

        const targetBefore = await fs.readFile(path.join(paths.target, 'Catalogs/Products.xml'));
        const compare = await openCompare(tempRoot, paths.target, paths.source, {
          withRuntime: true,
          extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
        });
        try {
          const owner = collectNodes(compare.result.projection.root).find((node) =>
            node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
          const addedRegistration = owner && collectNodes(owner).find((node) =>
            node.kind === 'xmlElement' && node.label === 'Форма: Added' && node.status === 'rightOnly');
          assert.ok(addedRegistration, `${item.id}: own Form remains visible for review`);
          assert.strictEqual(addedRegistration?.mergeable, false,
            `${item.id}: an unproven nested metadata UUID cannot authorize the Form package`);
          assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Catalogs/Products.xml')), targetBefore);
        } finally {
          await compare.dispose();
        }
      }
    });
  });

  test('CFE→CFE own Form UUID proof rejects target collisions before and after approval', async () => {
    await withTempRoot(async (tempRoot) => {
      const formUuid = '99999999-9999-4999-8999-999999999999';
      const otherUuid = '77777777-7777-4777-8777-777777777777';
      for (const phase of ['before-compare', 'after-approval'] as const) {
        const caseRoot = path.join(tempRoot, phase);
        const paths = {
          target: path.join(caseRoot, 'target-cfe'),
          source: path.join(caseRoot, 'source-cfe'),
          targetBase: path.join(caseRoot, 'target-base-cf'),
          sourceBase: path.join(caseRoot, 'source-base-cf'),
        };
        const baseObject: ExtensionCompareObjectFixture = { type: 'Catalog', name: 'Products', uuid: UUID.catalog };
        const targetObject: ExtensionCompareObjectFixture = {
          ...baseObject, uuid: UUID.catalogLocal, belonging: 'Adopted', anchorUuid: UUID.catalog,
        };
        const sourceObject: ExtensionCompareObjectFixture = {
          ...baseObject, uuid: UUID.catalogOther, belonging: 'Adopted', anchorUuid: UUID.catalog,
          childObjectsXml: '<Form>Added</Form>',
        };
        const otherOwner: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Other', uuid: phase === 'before-compare' ? formUuid : otherUuid, belonging: 'Own',
        };
        const sourceOtherOwner: ExtensionCompareObjectFixture = {
          type: 'Catalog', name: 'Other', uuid: otherUuid, belonging: 'Own',
        };
        await writeAdoptedProjectionConfiguration(paths.targetBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await writeAdoptedProjectionConfiguration(paths.sourceBase, { name: 'Shared configuration', objects: [mdClassesFixture(baseObject)] });
        await fs.copyFile(path.join(paths.targetBase, 'Configuration.xml'), path.join(paths.sourceBase, 'Configuration.xml'));
        await fs.copyFile(path.join(paths.targetBase, 'Catalogs/Products.xml'), path.join(paths.sourceBase, 'Catalogs/Products.xml'));
        await writeAdoptedProjectionConfiguration(paths.target, {
          purpose: 'Customization', objects: [mdClassesFixture(targetObject), mdClassesFixture(otherOwner)],
        });
        await writeAdoptedProjectionConfiguration(paths.source, {
          purpose: 'Customization', objects: [mdClassesFixture(sourceObject), mdClassesFixture(sourceOtherOwner)],
        });
        await fs.copyFile(path.join(paths.target, 'Configuration.xml'), path.join(paths.source, 'Configuration.xml'));
        const formDescriptor = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${formUuid}"><Properties><Name>Added</Name></Properties></Form></MetaDataObject>`;
        await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added.xml', formDescriptor);
        await writeCompareBytes(paths.source, 'Catalogs/Products/Forms/Added/Ext/Form.xml', '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>source own form</WindowTitle></Form>');

        const targetOwnerBefore = await fs.readFile(path.join(paths.target, 'Catalogs/Products.xml'));
        const targetFormDescriptorPath = path.join(paths.target, 'Catalogs/Products/Forms/Added.xml');
        const compare = await openCompare(tempRoot, paths.target, paths.source, {
          withRuntime: true,
          extensionBaseRoots: { left: paths.targetBase, right: paths.sourceBase },
        });
        try {
          const owner = collectNodes(compare.result.projection.root).find((node) =>
            node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
          const registration = owner && collectNodes(owner).find((node) => node.kind === 'xmlElement'
            && node.label === 'Форма: Added' && node.status === 'rightOnly');
          assert.ok(registration, `${phase}: source own Form registration remains visible`);
          assert.strictEqual(registration?.mergeable, phase === 'after-approval',
            `${phase}: only an absent target UUID may authorize the package`);
          if (phase === 'before-compare' || !registration) {
            assert.strictEqual(await pathExists(targetFormDescriptorPath), false);
            assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Catalogs/Products.xml')), targetOwnerBefore);
            continue;
          }

          const preview = await createPreview(compare.result, [registration.id]);
          assert.strictEqual(compare.result.workspace.approvePreview(preview.previewId).ok, true);
          const driftedOther = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Catalog uuid="${formUuid}"><Properties><Name>Other</Name><ObjectBelonging>Own</ObjectBelonging></Properties></Catalog></MetaDataObject>`;
          await writeCompareBytes(paths.target, 'Catalogs/Other.xml', driftedOther);
          const driftedOtherBytes = await fs.readFile(path.join(paths.target, 'Catalogs/Other.xml'));
          const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, false, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));
          assert.ok(executed.result?.failed.some((item) => item.code === 'MERGE_WITNESS_MISMATCH'),
            JSON.stringify(executed.result?.failed));
          assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Catalogs/Products.xml')), targetOwnerBefore,
            'a newly introduced target UUID collision must not partially write the owner descriptor');
          assert.deepStrictEqual(await fs.readFile(path.join(paths.target, 'Catalogs/Other.xml')), driftedOtherBytes,
            'the intervening target owner remains untouched by the failed write');
          assert.strictEqual(await pathExists(targetFormDescriptorPath), false,
            'the package descriptor remains absent after the transaction is rejected');
          assert.strictEqual(await pathExists(path.join(paths.target, 'Catalogs/Products/Forms/Added/Ext/Form.xml')), false,
            'the package body remains absent after the transaction is rejected');
        } finally {
          await compare.dispose();
        }
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

  test('applies one selected form from multiple own and adopted CFE forms without replacing sibling files', async () => {
    await withTempRoot(async (tempRoot) => {
      const cases = [
        {
          id: 'own',
          type: 'Catalog' as const,
          name: 'Ext_Orders',
          localUuid: UUID.catalog,
          anchorUuid: undefined,
          base: undefined,
          relativeFolder: 'Catalogs/Ext_Orders',
        },
        {
          id: 'adopted',
          type: 'CommonModule' as const,
          name: 'Shared',
          localUuid: UUID.commonModuleLocal,
          anchorUuid: UUID.commonModule,
          base: path.join(tempRoot, 'base-cf'),
          relativeFolder: 'CommonModules/Shared',
        },
      ];

      for (const item of cases) {
        const caseRoot = path.join(tempRoot, item.id);
        const target = path.join(caseRoot, 'target-cfe');
        const source = path.join(caseRoot, 'source-cfe');
        const formPath = (form: string): string => `${item.relativeFolder}/Forms/${form}/Ext/Form.xml`;
        const adopted = item.anchorUuid ? { belonging: 'Adopted' as const, anchorUuid: item.anchorUuid } : {};
        const targetObject: ExtensionCompareObjectFixture = {
          type: item.type,
          name: item.name,
          uuid: item.localUuid,
          ...adopted,
        };
        const sourceObject: ExtensionCompareObjectFixture = {
          ...targetObject,
          uuid: item.anchorUuid ? UUID.catalogOther : item.localUuid,
        };
        if (item.base) {
          await writeDesignerConfiguration(item.base, {
            objects: [
              { type: item.type, name: item.name, uuid: item.anchorUuid! },
              ...(item.id === 'adopted' ? [{ type: 'Catalog', name: 'Known', uuid: UUID.catalog }] : []),
            ],
          });
        }
        await writeDesignerConfiguration(target, {
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [targetObject],
        });
        await writeDesignerConfiguration(source, {
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [sourceObject],
        });
        const formXml = (title: string, addBaseReference = false): string =>
          `<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"><Attributes>${addBaseReference ? '<Attribute name="Object" id="1"><Type><v8:Type>cfg:CatalogRef.Known</v8:Type></Type></Attribute>' : ''}</Attributes><Commands/><ChildItems/><WindowTitle>${title}</WindowTitle></Form>`;
        await writeCompareBytes(target, formPath('Main'), formXml('target Main'));
        await writeCompareBytes(source, formPath('Main'), formXml('source Main', item.id === 'adopted'));
        await writeCompareBytes(target, formPath('Secondary'), '<Form><WindowTitle>target Secondary</WindowTitle></Form>');
        await writeCompareBytes(source, formPath('Secondary'), '<Form><WindowTitle>source Secondary</WindowTitle></Form>');
        const predefinedPath = `${item.relativeFolder}/Ext/Predefined.xml`;
        await writeCompareBytes(target, predefinedPath, '<PredefinedData><Item id="33333333-3333-4333-8333-333333333333"><Name>One</Name><Description>target predefined</Description></Item></PredefinedData>');
        await writeCompareBytes(source, predefinedPath, '<PredefinedData><Item id="33333333-3333-4333-8333-333333333333"><Name>One</Name><Description>source predefined</Description></Item></PredefinedData>');

        const compare = await withPlatform('linux', () => openCompare(tempRoot, target, source, {
          extensionBaseRoots: item.base ? { left: item.base, right: item.base } : undefined,
        }));
        try {
          const row = collectNodes(compare.result.projection.root).find((node) => node.label === `${item.type}.${item.name}`);
          assert.ok(row, `${item.id}: transfer row should be visible`);
          assert.ok(compare.result.workspace.listMergeableNodeIds().includes(row!.id), `${item.id}: parent transfer must remain selectable`);
          const mainForm = collectNodes(row!).find((node) => node.mergeable
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Forms/Main/Ext/Form.xml')
            && node.rightValue?.includes('source Main'));
          assert.ok(mainForm, `${item.id}: Main Form.xml should have a selectable semantic node`);
          const secondaryForm = collectNodes(row!).find((node) => node.mergeable
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Forms/Secondary/Ext/Form.xml')
            && node.rightValue?.includes('source Secondary'));
          assert.ok(secondaryForm, `${item.id}: Secondary Form.xml should remain a distinct selectable node`);
          const predefined = collectNodes(row!).find((node) => node.mergeable
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Ext/Predefined.xml')
            && node.rightValue?.includes('source predefined'));
          assert.ok(predefined, `${item.id}: Predefined.xml should have a selectable semantic node`);

          const preview = await createPreview(compare.result, [mainForm!.id]);
          await execute(compare.result, preview.previewId);

          assert.match(await readUtf8(target, formPath('Main')), /source Main/u);
          assert.match(await readUtf8(target, formPath('Secondary')), /target Secondary/u);
          assert.match(await readUtf8(target, `${item.relativeFolder}/Ext/Predefined.xml`), /target predefined/u);
          assert.match(await readUtf8(target, `${item.relativeFolder}.xml`), /<MetaDataObject/u);
          if (item.id === 'adopted' && item.base) {
            await writeCompareBytes(source, formPath('Main'), formXml('source Main after compare', true));
            const staleBaseCompare = await openCompare(tempRoot, target, source, {
              extensionBaseRoots: { left: item.base, right: item.base },
            });
            try {
              const staleRow = collectNodes(staleBaseCompare.result.projection.root)
                .find((node) => node.kind === 'extensionMetadataObject' && node.label === `${item.type}.${item.name}`);
              assert.ok(staleRow);
              const changedForm = collectNodes(staleRow!).find((node) => node.mergeable
                && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Forms/Main/Ext/Form.xml')
                && node.rightValue?.includes('source Main after compare'));
              assert.ok(changedForm, 'the modified source form should remain selectively mergeable');
              const stalePreview = await createPreview(staleBaseCompare.result, [changedForm!.id]);
              const targetFormBeforeStaleExecution = await fs.readFile(path.join(target, formPath('Main')));
              const baseDescriptor = await readUtf8(item.base, 'Catalogs/Known.xml');
              await writeCompareBytes(item.base, 'Catalogs/Known.xml', baseDescriptor.replace(
                '</Properties>', '<Comment>changed after preview</Comment></Properties>'
              ));
              const approved = staleBaseCompare.result.workspace.approvePreview(stalePreview.previewId);
              assert.strictEqual(approved.ok, true);
              const staleExecution = await staleBaseCompare.result.workspace.executeApprovedPreview(stalePreview.previewId, { destructiveConfirmed: true });
              assert.strictEqual(staleExecution.ok, false);
              assert.ok(staleExecution.result?.failed.some((item) => item.code === 'MERGE_WITNESS_MISMATCH'), JSON.stringify(staleExecution.result?.failed));
              assert.deepStrictEqual(await fs.readFile(path.join(target, formPath('Main'))), targetFormBeforeStaleExecution);
            } finally {
              await staleBaseCompare.dispose();
            }
          }
        } finally {
          await compare.dispose();
        }
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
      const cases = [
        { purpose: 'AddOn' as const, type: 'Catalog' as const, mergeable: true },
        { purpose: 'Customization' as const, type: 'Catalog' as const, mergeable: true },
        { purpose: 'Patch' as const, type: 'CommonModule' as const, mergeable: true },
        { purpose: 'Patch' as const, type: 'Catalog' as const, mergeable: true },
      ];
      for (const [index, item] of cases.entries()) {
        const caseRoot = path.join(tempRoot, `${item.purpose}-${item.type}-${index}`);
        const base = path.join(caseRoot, 'base-cf');
        const incoming = path.join(caseRoot, 'incoming-cf');
        const target = path.join(caseRoot, 'target-cfe');
        const object: ExtensionCompareObjectFixture = {
          type: item.type,
          name: 'Ext_New',
          uuid: UUID.catalog,
        };
        await writeDesignerConfiguration(base);
        await writeDesignerConfiguration(incoming, { objects: [object] });
        await writeDesignerConfiguration(target, { purpose: item.purpose, namePrefix: 'Ext_' });
        const compare = await openCompare(tempRoot, target, incoming, {
          extensionBaseRoots: { left: base },
        });
        try {
          const mergeable = mergeableTransferRowIds(compare.result).length === 1;
          assert.strictEqual(mergeable, item.mergeable, `${item.purpose} ${item.type} own-object creation policy`);
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

async function writeAdoptedProjectionConfiguration(
  rootPath: string,
  fixture: ExtensionCompareConfigurationFixture,
): Promise<void> {
  await writeDesignerConfiguration(rootPath, fixture);
  const configurationPath = path.join(rootPath, 'Configuration.xml');
  const xml = await fs.readFile(configurationPath, 'utf8');
  const qualified = xml.replace('<MetaDataObject ', '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" ');
  assert.notStrictEqual(qualified, xml, 'the adopted projection fixture must qualify Configuration.xml in MDClasses');
  await fs.writeFile(configurationPath, qualified, 'utf8');
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot();
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function withPlatform<T>(platform: NodeJS.Platform, callback: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function indexedSidecarOwner(
  sourceId: string,
  side: 'left' | 'right',
  sidecarFiles: ExtensionIndexedObject['sidecarFiles'],
): ExtensionIndexedObject {
  return {
    side,
    sourceId,
    metadataType: 'Catalog',
    name: 'Owner',
    qualifiedName: 'Catalog.Owner',
    descriptorRelativePath: 'Catalogs/Owner.xml',
    sidecarRelativePath: 'Catalogs/Owner',
    sidecarFiles,
    supportedRootType: true,
    valid: true,
  };
}

function semanticIndex(
  rootPath: string,
  side: 'left' | 'right',
  rootKind: 'cf' | 'cfe',
  objects: ExtensionIndexedObject[],
): ExtensionMetadataIndex {
  const configurationContent = Buffer.from('<Configuration/>', 'utf8');
  return {
    rootPath,
    canonicalRootPath: rootPath,
    sourceId: rootPath,
    side,
    rootKind,
    hasConfigurationXml: true,
    configurationContent,
    configurationHash: createHash('sha256').update(configurationContent).digest('hex'),
    formatVersion: '2.20',
    configurationUuid: UUID.targetConfiguration,
    configurationName: 'Shared configuration',
    objectBelonging: rootKind === 'cfe' ? 'Own' : undefined,
    purpose: rootKind === 'cfe' ? 'Customization' : undefined,
    objects,
    diagnostics: [],
    cfeMarkerSeen: rootKind === 'cfe',
  };
}

function semanticIndexedObject(input: {
  sourceId: string;
  side: 'left' | 'right';
  ownership: 'own' | 'adopted';
  uuid: string;
  anchorUuid?: string;
  descriptorRelativePath: string;
}): ExtensionIndexedObject {
  const markerXml = input.ownership === 'adopted'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${input.anchorUuid}</ExtendedConfigurationObject>`
    : '';
  const descriptorContent = Buffer.from(
    `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Catalog uuid="${input.uuid}"><Properties><Name>Products</Name>${markerXml}</Properties><ChildObjects/></Catalog></MetaDataObject>`,
    'utf8',
  );
  return {
    side: input.side,
    sourceId: input.sourceId,
    metadataType: 'Catalog',
    name: 'Products',
    qualifiedName: 'Catalog.Products',
    descriptorRelativePath: input.descriptorRelativePath,
    identity: {
      ownership: input.ownership,
      type: 'Catalog',
      name: 'Products',
      uuid: input.uuid,
      path: input.descriptorRelativePath,
      ...(input.anchorUuid ? { sourceUuid: input.anchorUuid } : {}),
    },
    descriptorContent,
    descriptorHash: createHash('sha256').update(descriptorContent).digest('hex'),
    sidecarFiles: [],
    supportedRootType: true,
    valid: true,
  };
}

function extensionRoleRightsXml(read: 'true' | 'false'): string {
  return `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">` +
    '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>true</setForAttributesByDefault>' +
    '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
    `<object><name>Catalog.Products</name><right><name>Read</name><value>${read}</value></right></object></Rights>`;
}

function extensionDcsXml(query: 'SELECT 1' | 'SELECT 2'): string {
  return `<d:DataCompositionSchema xmlns:d="http://v8.1c.ru/8.1/data-composition-system/schema" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings">` +
    '<d:dataSource><d:name>Source</d:name><d:dataSourceType>Local</d:dataSourceType></d:dataSource>' +
    `<d:dataSet xsi:type="d:DataSetQuery"><d:name>Query</d:name><d:dataSource>Source</d:dataSource><d:query>${query}</d:query></d:dataSet>` +
    '<d:settingsVariant><dcsset:name>Default</dcsset:name><d:settings/></d:settingsVariant>' +
    '</d:DataCompositionSchema>';
}

function assertMdClassesElementText(xml: string, localName: string, expectedText: string): void {
  assertMdClassesElementTexts(xml, localName, [expectedText]);
}

function assertMdClassesElementTexts(xml: string, localName: string, expectedTexts: readonly string[]): void {
  const values: string[] = [];
  const visit = (element: XmlElement): void => {
    if (element.localName === localName && namespaceUriForName(element) === 'http://v8.1c.ru/8.3/MDClasses') {
      values.push(textContent(element));
    }
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(parseXmlDocument(xml).root);
  assert.deepStrictEqual(values, [...expectedTexts], `Expected MDClasses:${localName} registrations`);
}

function onlyMergeableNodeId(result: ConfigurationCompareResult): string {
  const nodeIds = mergeableTransferRowIds(result);
  assert.strictEqual(nodeIds.length, 1, `Expected one mergeable object row, got ${nodeIds.length}: ${JSON.stringify({
    nodeIds,
    rows: collectNodes(result.projection.root).map((node) => ({ label: node.label, kind: node.kind, state: node.mergeState, conflict: node.conflict })),
    messages: result.session.state.messages,
  })}`);
  const selected = result.workspace.selectNodeIds(nodeIds);
  assert.strictEqual(selected.canCreatePreview, true);
  return nodeIds[0]!;
}

function mergeableTransferRowIds(result: ConfigurationCompareResult): string[] {
  return collectNodes(result.projection.root)
    .filter((node) => node.kind === 'extensionMetadataObject' && node.mergeable === true)
    .map((node) => node.id);
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
  assert.strictEqual(executed.ok, true, `Preview execution failed: ${JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed })}`);
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

function metadataChildSnapshot(xml: string, ownerType: string): {
  readonly uuid?: string;
  readonly belonging?: string;
  readonly anchorUuid?: string;
  readonly children: readonly {
    readonly name: string;
    readonly uuid?: string;
    readonly belonging?: string;
    readonly anchorUuid?: string;
  }[];
} {
  const owner = elementChildren(parseXmlDocument(xml).root).find((element) => element.localName === ownerType);
  assert.ok(owner, `Expected ${ownerType} in metadata descriptor`);
  const readProperty = (element: XmlElement | undefined, name: string): string | undefined => {
    if (!element) {return undefined;}
    const property = elementChildren(element).find((child) => child.localName === name);
    return property ? textContent(property).trim() : undefined;
  };
  const ownerProperties = elementChildren(owner!).find((element) => element.localName === 'Properties');
  const childObjects = elementChildren(owner!).find((element) => element.localName === 'ChildObjects');
  return {
    uuid: owner!.attributes.find((attribute) => attribute.localName === 'uuid')?.value,
    belonging: readProperty(ownerProperties, 'ObjectBelonging'),
    anchorUuid: readProperty(ownerProperties, 'ExtendedConfigurationObject'),
    children: (childObjects ? elementChildren(childObjects) : []).map((child) => {
      const properties = elementChildren(child).find((element) => element.localName === 'Properties');
      return {
        name: readProperty(properties, 'Name') ?? '',
        uuid: child.attributes.find((attribute) => attribute.localName === 'uuid')?.value,
        belonging: readProperty(properties, 'ObjectBelonging'),
        anchorUuid: readProperty(properties, 'ExtendedConfigurationObject'),
      };
    }),
  };
}

function registryDescriptor(type: ExtensionCompareRootType) {
  const descriptor = METADATA_TYPE_DESCRIPTORS.find((item) => item.designerRootTag === type);
  assert.ok(descriptor, `Expected ${type} to exist in the metadata type registry`);
  return descriptor;
}

function mdClassesFixture(fixture: ExtensionCompareObjectFixture): ExtensionCompareObjectFixture {
  if (fixture.descriptorXml) {return fixture;}
  const descriptorXml = metadataObjectXml(fixture)
    .replace('<MetaDataObject', '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"');
  return { ...fixture, descriptorXml };
}

function createRegistryObjects(uuidScope: number, comment: string): ExtensionCompareObjectFixture[] {
  return METADATA_TYPE_DESCRIPTORS.map((descriptor, index) => ({
    type: descriptor.designerRootTag,
    name: `Ext_${descriptor.designerRootTag}`,
    uuid: issue336Uuid(uuidScope, index),
    belonging: 'Own',
    propertiesXml: `<Comment>${comment} ${descriptor.designerRootTag}</Comment>`,
  }));
}

function createOwnTransferRegistryObjects(uuidScope: number, comment: string): ExtensionCompareObjectFixture[] {
  return createRegistryObjects(uuidScope, comment).map((object) => {
    const registerChildren = isRegisterRootType(object.type)
      ? registerChildFixtures(object, uuidScope, REGISTER_ROOT_TYPES.indexOf(object.type), 'own').xml
      : undefined;
    const recorderReferences = object.type === 'Document'
      ? '<RegisterRecords xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Ext_AccumulationRegister</xr:Item>'
        + '<xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.Ext_AccountingRegister</xr:Item>'
        + '<xr:Item xsi:type="xr:MDObjectRef">CalculationRegister.Ext_CalculationRegister</xr:Item>'
        + '</RegisterRecords>'
      : '';
    const rootReferenceProperties = object.type === 'AccountingRegister'
      ? '<ChartOfAccounts>ChartOfAccounts.Ext_ChartOfAccounts</ChartOfAccounts>'
      : object.type === 'CalculationRegister'
        ? '<ChartOfCalculationTypes>ChartOfCalculationTypes.Ext_ChartOfCalculationTypes</ChartOfCalculationTypes>'
        : object.type === 'ChartOfAccounts'
          ? '<ExtDimensionTypes>ChartOfCharacteristicTypes.Ext_ChartOfCharacteristicTypes</ExtDimensionTypes>'
          : '';
    return {
      ...object,
      ...(registerChildren === undefined ? {} : { childObjectsXml: registerChildren }),
      propertiesXml: `${object.propertiesXml ?? ''}${recorderReferences}${rootReferenceProperties}`,
    };
  });
}

function isRegisterRootType(type: ExtensionCompareRootType): type is typeof REGISTER_ROOT_TYPES[number] {
  return REGISTER_ROOT_TYPES.some((registerType) => registerType === type);
}

type RegisterChildMode = 'own' | 'adopted' | 'source-dimension-own-resource';

interface RegisterChildFixtures {
  readonly dimensionUuid: string;
  readonly resourceUuid: string;
  readonly dimensionName: string;
  readonly resourceName: string;
  readonly xml: string;
}

function registerChildFixtures(
  register: Pick<ExtensionCompareObjectFixture, 'type'>,
  uuidScope: number,
  registerIndex: number,
  mode: RegisterChildMode = 'own',
): RegisterChildFixtures {
  if (!isRegisterRootType(register.type)) {
    throw new Error(`Expected a register root type, got ${register.type}`);
  }
  const dimensionUuid = issue336Uuid(uuidScope + 30, registerIndex * 2);
  const resourceUuid = issue336Uuid(uuidScope + 30, registerIndex * 2 + 1);
  const baseDimensionUuid = issue336Uuid(41, registerIndex * 2);
  const baseResourceUuid = issue336Uuid(41, registerIndex * 2 + 1);
  const dimensionName = `Dimension_${register.type}`;
  const resourceName = `Resource_${register.type}`;
  const dimensionOwnership = mode === 'adopted' || mode === 'source-dimension-own-resource'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${baseDimensionUuid}</ExtendedConfigurationObject>`
    : '';
  const resourceOwnership = mode === 'adopted'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${baseResourceUuid}</ExtendedConfigurationObject>`
    : '';
  const dimension = `<Dimension uuid="${dimensionUuid}"><Properties>${dimensionOwnership}<Name>${dimensionName}</Name><Type xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:Type>xs:string</v8:Type></Type></Properties></Dimension>`;
  const resource = `<Resource uuid="${resourceUuid}"><Properties>${resourceOwnership}<Name>${resourceName}</Name><Type xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:Type>xs:decimal</v8:Type></Type></Properties></Resource>`;
  return { dimensionUuid, resourceUuid, dimensionName, resourceName, xml: `${dimension}${resource}` };
}

function adoptedRegistryObject(
  baseObject: ExtensionCompareObjectFixture,
  uuidScope: number,
  index: number,
  synonym: string,
): ExtensionCompareObjectFixture {
  return {
    ...baseObject,
    uuid: issue336Uuid(uuidScope, index),
    belonging: 'Adopted',
    anchorUuid: baseObject.uuid,
    propertiesXml: `<Synonym>${synonym} ${baseObject.type}</Synonym>`,
  };
}

async function writeRegistrySidecars(
  rootPath: string,
  objects: readonly ExtensionCompareObjectFixture[],
  variant: 'target' | 'source',
  includeRoleRights = true,
): Promise<void> {
  for (const object of objects) {
    const folder = registryDescriptor(object.type).designerFolder;
    const objectPath = `${folder}/${object.name}`;
    await writeCompareBytes(
      rootPath,
      `${objectPath}/Ext/Issue336/marker.bin`,
      isBinaryRegistryRoot(object.type)
        ? binaryRegistryMarker()
        : `${variant}:${object.type}:${object.name}`,
    );
    if (isRegisterRootType(object.type)) {
      await writeCompareBytes(rootPath, `${objectPath}/Ext/RecordSetModule.bsl`, `${variant}:${object.type}:record-set-module`);
      await writeCompareBytes(rootPath, `${objectPath}/Ext/ManagerModule.bsl`, `${variant}:${object.type}:manager-module`);
    }
    if (object.type === 'Role' && includeRoleRights) {
      await writeCompareBytes(
        rootPath,
        `${objectPath}/Ext/Rights.xml`,
        '<rights><object><name>Catalog.Ext_Catalog</name></object></rights>',
      );
    }
    if (object.type === 'CommonForm') {
      await writeCompareBytes(rootPath, `${objectPath}/Ext/Form.bin`, binaryRegistryMarker());
      await writeCompareBytes(rootPath, `${objectPath}/Ext/Form.xml`, '<Form><WindowTitle>issue336</WindowTitle></Form>');
    }
    if (object.type === 'Subsystem') {
      await writeCompareBytes(rootPath, `${objectPath}/Ext/Nested/Content.bin`, `${variant}:Subsystem:nested`);
      await writeCompareBytes(rootPath, `${objectPath}/Ext/ChildSubsystems.xml`, '<ChildSubsystems><Subsystem>Nested</Subsystem></ChildSubsystems>');
    }
    if (object.type === 'Report' || object.type === 'DataProcessor') {
      await writeCompareBytes(rootPath, `${objectPath}/Templates/PrintTemplate/Template.xml`, `<Template>${variant}</Template>`);
    }
    if (object.type === 'Constant') {
      await writeCompareBytes(rootPath, `${objectPath}/Ext/ValueStorage.bin`, Buffer.from([0x43, 0x4f, 0x4e, 0x53, 0x54]));
    }
  }
}

function isBinaryRegistryRoot(type: ExtensionCompareRootType): boolean {
  return type === 'CommonPicture' || type === 'CommonTemplate' || type === 'CommonForm';
}

function binaryRegistryMarker(): Buffer {
  return Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28]);
}

async function snapshotBinaryRegistrySidecars(
  rootPath: string,
  objects: readonly ExtensionCompareObjectFixture[],
): Promise<readonly { readonly path: string; readonly hash: string }[]> {
  const paths = objects
    .filter((object) => isBinaryRegistryRoot(object.type))
    .flatMap((object) => {
      const folder = registryDescriptor(object.type).designerFolder;
      const markerPath = path.join(rootPath, folder, object.name, 'Ext', 'Issue336', 'marker.bin');
      return object.type === 'CommonForm'
        ? [markerPath, path.join(rootPath, folder, object.name, 'Ext', 'Form.bin')]
        : [markerPath];
    });
  return Promise.all(paths.map(async (filePath) => ({ path: filePath, hash: sha256(await fs.readFile(filePath)) })));
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function issue336Uuid(scope: number, index: number): string {
  const first = `${String(scope).padStart(2, '0')}${String(index + 1).padStart(6, '0')}`;
  const last = `${String(scope).padStart(4, '0')}${String(index + 1).padStart(8, '0')}`;
  return `${first}-1111-4111-8111-${last}`;
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
