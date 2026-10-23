import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import {
  METADATA_TYPE_DESCRIPTORS,
  getMetadataTypeDescriptorByType,
  supportsMetadataCrud,
  type MetadataGenericRootChildObjectKind,
} from '../../src/constants/metadataTypeDescriptors';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { extractChildSubsystems, findChildObjects } from '../../src/parsers/xmlChildObjects';
import { metadataConverter, rulesRegistry } from '../../src/rules';
import { normalizeEmptyPlaceholderTree } from '../../src/utils/treeNormalization';
import { ROOT_TAGS_WITHOUT_CHILDOBJECTS, XMLWriter } from '../../src/utils/XMLWriter';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';

suite('Metadata type registry completeness', () => {
  let restoreMutationEngine: (() => void) | undefined;

  suiteSetup(() => {
    restoreMutationEngine = installDirectConfigurationMutationEngineForTests();
  });

  suiteTeardown(() => {
    restoreMutationEngine?.();
    restoreMutationEngine = undefined;
  });

  test('canonical descriptors and XML rules cover the same root type set', () => {
    const descriptorRootTags = METADATA_TYPE_DESCRIPTORS.map((descriptor) => descriptor.designerRootTag).sort();
    assert.deepStrictEqual([...rulesRegistry.allRootTags()].sort(), descriptorRootTags);

    const expectedGenericChildren = new Map<MetadataType, readonly MetadataGenericRootChildObjectKind[]>([
      [MetadataType.Catalog, ['Attribute', 'TabularSection']],
      [MetadataType.Document, ['Attribute', 'TabularSection']],
      [MetadataType.Report, ['Attribute', 'TabularSection']],
      [MetadataType.DataProcessor, ['Attribute', 'TabularSection']],
      [MetadataType.BusinessProcess, ['Attribute', 'TabularSection']],
      [MetadataType.Task, ['Attribute', 'TabularSection']],
      [MetadataType.ExchangePlan, ['Attribute', 'TabularSection']],
      [MetadataType.ChartOfCharacteristicTypes, ['Attribute', 'TabularSection']],
      [MetadataType.ChartOfAccounts, ['Attribute', 'TabularSection']],
      [MetadataType.ChartOfCalculationTypes, ['Attribute', 'TabularSection']],
      [MetadataType.InformationRegister, ['Attribute']],
      [MetadataType.AccumulationRegister, ['Attribute']],
      [MetadataType.AccountingRegister, ['Attribute']],
      [MetadataType.CalculationRegister, ['Attribute']],
    ]);

    for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
      const rules = rulesRegistry.get(descriptor.designerRootTag);
      assert.ok(rules, `missing XML rules for ${descriptor.designerRootTag}`);

      assert.strictEqual(typeof descriptor.structure.hasChildObjects, 'boolean');
      assert.deepStrictEqual(
        descriptor.genericRootChildObjectKinds,
        expectedGenericChildren.get(descriptor.type) ?? [],
        `${descriptor.designerRootTag}: generic child admission must match the explicit support matrix`,
      );
      if (descriptor.genericRootChildObjectKinds.length > 0) {
        assert.strictEqual(descriptor.structure.hasChildObjects, true);
      }
    }

    for (const type of [
      MetadataType.Enum,
      MetadataType.Sequence,
      MetadataType.WebService,
      MetadataType.HTTPService,
      MetadataType.IntegrationService,
      MetadataType.Subsystem,
    ]) {
      const descriptor = getMetadataTypeDescriptorByType(type)!;
      assert.strictEqual(descriptor.structure.hasChildObjects, true, `${String(type)} retains its structural ChildObjects`);
      assert.deepStrictEqual(descriptor.genericRootChildObjectKinds, [], `${String(type)} does not admit generic children`);
    }

    const subsystem = getMetadataTypeDescriptorByType(MetadataType.Subsystem)!;
    assert.strictEqual(subsystem.structure.hasChildObjects, true);

    const parsedSubsystem = new XMLParser({ ignoreAttributes: false }).parse(
      '<MetaDataObject><Subsystem><ChildObjects><Subsystem>Child</Subsystem></ChildObjects></Subsystem></MetaDataObject>',
    );
    assert.deepStrictEqual(
      extractChildSubsystems(findChildObjects(parsedSubsystem)),
      ['Child'],
      'the existing subsystem read path recognizes the structural Subsystem child kind',
    );
  });

  test('XML writer output and omission adapter match every registered XML rule', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-type-registry-'));
    try {
      const mismatches: string[] = [];
      const omittedByDescriptors = METADATA_TYPE_DESCRIPTORS
        .filter((descriptor) => !descriptor.structure.hasChildObjects)
        .map((descriptor) => descriptor.designerRootTag);
      const expectedOmittedTags = [...omittedByDescriptors, 'Form'].sort();
      const actualOmittedTags = [...ROOT_TAGS_WITHOUT_CHILDOBJECTS].sort();
      if (JSON.stringify(actualOmittedTags) !== JSON.stringify(expectedOmittedTags)) {
        mismatches.push(`ROOT_TAGS_WITHOUT_CHILDOBJECTS expected [${expectedOmittedTags.join(', ')}], actual [${actualOmittedTags.join(', ')}]`);
      }

      for (const [index, descriptor] of METADATA_TYPE_DESCRIPTORS.entries()) {
        const expected = descriptor.structure.hasChildObjects;
        const filePath = path.join(tempRoot, `${index}.xml`);
        await XMLWriter.createMinimalElementFile(filePath, descriptor.designerRootTag, `RegistryObject${index}`, '2.20');
        const xml = await fs.promises.readFile(filePath, 'utf8');
        const actual = /<ChildObjects\b/.test(xml);
        if (actual !== expected) {
          mismatches.push(`${descriptor.designerRootTag}: XMLWriter expected=${expected}, generated=${actual}`);
        }

        const rules = rulesRegistry.get(descriptor.designerRootTag)!;
        const ir = metadataConverter.createDefaultIR(rules, {
          name: `RegistryObject${index}`,
          uuid: `registry-${index}`,
        });
        const convertedXml = metadataConverter.irToXml(ir, rules);
        const convertedHasChildObjects = /<ChildObjects\b/.test(convertedXml);
        if (convertedHasChildObjects !== expected) {
          mismatches.push(`${descriptor.designerRootTag}: MetadataConverter expected=${expected}, generated=${convertedHasChildObjects}`);
        }
      }
      assert.deepStrictEqual(mismatches, [], 'XML generation and its omission adapter must follow the registered ChildObjects policy');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('tree normalization projects every descriptor folder with canonical path and type', () => {
    const formats = [ConfigFormat.Designer, ConfigFormat.EDT];
    for (const format of formats) {
      const configPath = path.join(os.tmpdir(), `metadata-registry-${format}`);
      const root: TreeNode = {
        id: 'root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [],
      };
      const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format });
      const common = normalized.children?.find((child) => child.id === 'Common');
      const projectedFolders = [...(normalized.children ?? []), ...(common?.children ?? [])];

      for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
        const node = projectedFolders.find((child) => child.id === descriptor.designerFolder);
        assert.ok(node, `${format}: missing tree folder ${descriptor.designerFolder}`);
        assert.strictEqual(node!.type, descriptor.type, `${format}: wrong type for ${descriptor.designerFolder}`);
        assert.strictEqual(
          node!.filePath,
          path.join(configPath, ...(format === ConfigFormat.EDT ? ['src'] : []), descriptor.designerFolder),
          `${format}: wrong path for ${descriptor.designerFolder}`,
        );
      }

      const interfaceNode = common?.children?.find((child) => child.id === 'Interfaces');
      assert.ok(interfaceNode, `${format}: the supported Interface metadata folder belongs under «Общие»`);
      assert.strictEqual(interfaceNode!.type, MetadataType.Interface);
      assert.strictEqual(
        getMetadataTypeDescriptorByType(MetadataType.Interface)?.structure.designerRootObject,
        true,
        'Interface is an explicit Designer root metadata type',
      );
      assert.strictEqual(
        getMetadataTypeDescriptorByType(MetadataType.Interface)?.structure.hasChildObjects,
        false,
        'Interface root XML omits ChildObjects',
      );
      for (const operation of ['create', 'rename', 'duplicate', 'delete'] as const) {
        assert.strictEqual(supportsMetadataCrud(MetadataType.Interface, operation), true);
      }
    }
  });
});
