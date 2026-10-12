import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveBslPathFromRdbgModule,
  resolveModuleId,
  clearDumpMetadataCache,
  clearExtensionNameCache,
} from '../../src/debug/moduleIdResolver';
import {
  getStandardModuleByFileName,
  getStandardModuleFileName,
  METADATA_STANDARD_MODULE_DESCRIPTORS,
} from '../../src/constants/metadataModuleDescriptors';
import { STANDARD_MODULES } from '../../src/constants/moduleTypes';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { DesignerParser } from '../../src/parsers/designerParser';
import { EdtParser } from '../../src/parsers/edtParser';
import { getMetadataTypeDescriptorByType } from '../../src/constants/metadataTypeDescriptors';
import { locateMetadataFile } from '../../src/services/metadataFileLocator';
import { MetadataTypeMapper } from '../../src/utils/metadataTypeMapper';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const CONSTANT_UUID = '87ab34a6-19ab-4df0-92ca-a6e09c43b65a';
const OBJECT_MODULE = {
  kind: 'ObjectModule',
  fileName: 'ObjectModule.bsl',
  label: 'Модуль объекта',
} as const;
const MANAGER_MODULE = {
  kind: 'ManagerModule',
  fileName: 'ManagerModule.bsl',
  label: 'Модуль менеджера',
} as const;
const RECORD_SET_MODULE = {
  kind: 'RecordSetModule',
  fileName: 'RecordSetModule.bsl',
  label: 'Модуль набора записей',
} as const;
const VALUE_MANAGER_MODULE = {
  kind: 'ValueManagerModule',
  fileName: 'ValueManagerModule.bsl',
  label: 'Модуль менеджера значений',
} as const;
const COMMON_MODULE = { kind: 'CommonModule', fileName: 'Module.bsl', label: 'Модуль' } as const;

const EXPECTED_MODULES: Partial<
  Record<
    MetadataType,
    readonly (
      | typeof OBJECT_MODULE
      | typeof MANAGER_MODULE
      | typeof RECORD_SET_MODULE
      | typeof VALUE_MANAGER_MODULE
      | typeof COMMON_MODULE
      | {
          readonly kind: 'ManagedApplicationModule';
          readonly fileName: 'ManagedApplicationModule.bsl';
          readonly label: 'Модуль управляемого приложения';
        }
    )[]
  >
> = {
  [MetadataType.Catalog]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.Document]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.Report]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.DataProcessor]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.BusinessProcess]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.Task]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.ChartOfAccounts]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.ChartOfCharacteristicTypes]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.ChartOfCalculationTypes]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.ExchangePlan]: [OBJECT_MODULE, MANAGER_MODULE],
  [MetadataType.Enum]: [MANAGER_MODULE],
  [MetadataType.Constant]: [VALUE_MANAGER_MODULE],
  [MetadataType.InformationRegister]: [RECORD_SET_MODULE, MANAGER_MODULE],
  [MetadataType.AccumulationRegister]: [RECORD_SET_MODULE, MANAGER_MODULE],
  [MetadataType.AccountingRegister]: [RECORD_SET_MODULE, MANAGER_MODULE],
  [MetadataType.CalculationRegister]: [RECORD_SET_MODULE, MANAGER_MODULE],
  [MetadataType.Sequence]: [RECORD_SET_MODULE, MANAGER_MODULE],
  [MetadataType.CommonModule]: [COMMON_MODULE],
  [MetadataType.Configuration]: [
    {
      kind: 'ManagedApplicationModule',
      fileName: 'ManagedApplicationModule.bsl',
      label: 'Модуль управляемого приложения',
    },
  ],
};

function findNode(
  node: TreeNode,
  predicate: (candidate: TreeNode) => boolean
): TreeNode | undefined {
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children ?? []) {
    const match = findNode(child, predicate);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function hasModulePath(node: TreeNode, fileName: string): boolean {
  return (
    findNode(node, (candidate) => path.basename(candidate.filePath ?? '') === fileName) !==
    undefined
  );
}

suite('canonical standard module integration', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await createTempDir('1cviewer-standard-modules-');
  });

  teardown(async () => {
    clearDumpMetadataCache();
    clearExtensionNameCache();
    await cleanupTempDir(tempRoot);
  });

  test('registry preserves the complete standard module descriptor matrix and tree projection', () => {
    const expectedDescriptors = Object.entries(EXPECTED_MODULES).flatMap(
      ([metadataType, modules]) =>
        modules!.map((module) => ({ metadataType: metadataType as MetadataType, ...module }))
    );
    assert.deepStrictEqual(METADATA_STANDARD_MODULE_DESCRIPTORS, expectedDescriptors);

    const expectedTreeProjection = Object.fromEntries(
      Object.entries(EXPECTED_MODULES).map(([metadataType, modules]) => [
        metadataType,
        modules!.map(({ fileName, label }) => ({ fileName, label })),
      ])
    );
    assert.deepStrictEqual(STANDARD_MODULES, expectedTreeProjection);

    const seenKinds = new Set<string>();
    const seenFiles = new Set<string>();
    for (const descriptor of METADATA_STANDARD_MODULE_DESCRIPTORS) {
      const kindKey = `${descriptor.metadataType}\u0000${descriptor.kind}`;
      const fileKey = `${descriptor.metadataType}\u0000${descriptor.fileName}`;
      assert.strictEqual(seenKinds.has(kindKey), false, `duplicate module kind ${kindKey}`);
      assert.strictEqual(seenFiles.has(fileKey), false, `duplicate module filename ${fileKey}`);
      seenKinds.add(kindKey);
      seenFiles.add(fileKey);
      assert.strictEqual(
        getStandardModuleByFileName(descriptor.metadataType, descriptor.fileName),
        descriptor
      );
      assert.strictEqual(
        getStandardModuleFileName(descriptor.metadataType, descriptor.kind),
        descriptor.fileName
      );
    }

    assert.strictEqual(
      getStandardModuleFileName(MetadataType.Constant, 'ManagerModule'),
      undefined
    );
    assert.strictEqual(
      getStandardModuleByFileName(MetadataType.Constant, 'ManagerModule.bsl'),
      undefined
    );
  });

  test('every object standard module descriptor resolves through Designer index and path locator', async () => {
    const moduleKindToLocationKind: Record<string, string> = {
      ObjectModule: 'objectModule',
      ManagerModule: 'managerModule',
      RecordSetModule: 'recordSetModule',
      ValueManagerModule: 'valueManagerModule',
      CommonModule: 'commonModule',
    };
    const debugPropertyIds: Record<string, string> = {
      ObjectModule: 'a637f77f-3840-441d-a1c3-699c8c5cb7e0',
      ManagerModule: 'd1b64a2c-8078-4982-8190-8f81aefda192',
      RecordSetModule: '9f36fd70-4bf4-47f6-b235-935f73aab43f',
      ValueManagerModule: '3e58c91f-9aaa-4f42-8999-4baf33907b75',
      CommonModule: 'd5963243-262e-4398-b4d7-fb16d06484f6',
    };
    const typeNames = new Map<MetadataType, string>();
    const objectNames = new Map<MetadataType, string>();

    await fs.promises.writeFile(
      path.join(tempRoot, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="11111111-1111-4111-8111-111111111111" /></MetaDataObject>',
      'utf8'
    );

    for (const descriptor of METADATA_STANDARD_MODULE_DESCRIPTORS) {
      if (descriptor.metadataType === MetadataType.Configuration) {
        continue;
      }
      const folder = MetadataTypeMapper.getDesignerFolderIdForMetadataType(descriptor.metadataType);
      assert.ok(folder, `Designer folder must exist for ${descriptor.metadataType}`);
      const metadataTypeDescriptor = getMetadataTypeDescriptorByType(descriptor.metadataType);
      assert.ok(
        metadataTypeDescriptor,
        `metadata descriptor must exist for ${descriptor.metadataType}`
      );
      const objectName = `Registry${descriptor.metadataType}`;
      typeNames.set(descriptor.metadataType, folder!);
      objectNames.set(descriptor.metadataType, objectName);
      const objectDirectory = path.join(tempRoot, folder!, objectName);
      const modulePath = path.join(objectDirectory, 'Ext', descriptor.fileName);
      await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempRoot, folder!, `${objectName}.xml`),
        `<MetaDataObject><${metadataTypeDescriptor!.designerRootTag} uuid="${CONSTANT_UUID}" /></MetaDataObject>`,
        'utf8'
      );
      await fs.promises.writeFile(modulePath, '// module', 'utf8');
    }

    for (const [metadataType, folder] of typeNames) {
      const objectName = objectNames.get(metadataType)!;
      const indexed = await DesignerParser.parseTypeIndex(tempRoot, folder);
      const objectNode = indexed.find((candidate) => candidate.name === objectName);
      assert.ok(objectNode, `${folder} should index ${objectName}`);
      const extNode = objectNode!.children?.find((candidate) => candidate.name === 'Extensions');
      assert.ok(extNode, `${folder}/${objectName} should expose the Ext node`);

      for (const descriptor of METADATA_STANDARD_MODULE_DESCRIPTORS.filter(
        (item) => item.metadataType === metadataType
      )) {
        const moduleFileNode: TreeNode | undefined = extNode!.children?.find(
          (candidate) => candidate.name === descriptor.fileName
        );
        assert.ok(moduleFileNode, `${folder}/${objectName} should expose ${descriptor.fileName}`);
        assert.strictEqual(
          moduleFileNode!.properties.isVirtual,
          undefined,
          `${descriptor.fileName} should be physical`
        );

        const location = locateMetadataFile(moduleFileNode!.filePath!, [tempRoot]);
        assert.ok(location, `${descriptor.fileName} should be locatable`);
        assert.strictEqual(location!.objectName, objectName);
        assert.deepStrictEqual(location!.subPath, {
          kind: moduleKindToLocationKind[descriptor.kind],
        });

        const debugResult: Awaited<ReturnType<typeof resolveModuleId>> = await resolveModuleId(
          moduleFileNode!.filePath!,
          tempRoot
        );
        assert.ok(debugResult, `${descriptor.fileName} should resolve through the debug adapter`);
        assert.strictEqual(debugResult!.moduleId.objectId, CONSTANT_UUID);
        assert.strictEqual(debugResult!.moduleId.propertyId, debugPropertyIds[descriptor.kind]);
      }
    }
  });

  test('Designer Constant ValueManagerModule flows through parsed tree, locator, and debug resolver', async () => {
    const modulePath = path.join(tempRoot, 'Constants', 'Rate', 'Ext', 'ValueManagerModule.bsl');
    await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempRoot, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="11111111-1111-4111-8111-111111111111" /></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tempRoot, 'Constants', 'Rate.xml'),
      `<MetaDataObject><Constant uuid="${CONSTANT_UUID}"><Properties><Name>Rate</Name></Properties></Constant></MetaDataObject>`,
      'utf8'
    );
    await fs.promises.writeFile(modulePath, '// value manager module', 'utf8');
    await fs.promises.writeFile(
      path.join(tempRoot, 'ConfigDumpInfo.xml'),
      `<ConfigDumpInfo><ConfigVersions><Metadata name="Constant.Rate" id="${CONSTANT_UUID}"/><Metadata name="Constant.Rate.ValueManager" id="${CONSTANT_UUID}.0"/></ConfigVersions></ConfigDumpInfo>`,
      'utf8'
    );

    const tree = await DesignerParser.parse(tempRoot);
    const constant = findNode(
      tree,
      (node) => node.type === MetadataType.Constant && node.name === 'Rate'
    );
    assert.ok(constant, 'Designer parser should build the Constant tree node');
    const module = findNode(
      constant!,
      (node) => path.basename(node.filePath ?? '') === 'ValueManagerModule.bsl'
    );
    assert.ok(module, 'the existing ValueManagerModule must be visible in the parsed tree');
    assert.strictEqual(
      module!.properties.isVirtual,
      undefined,
      'the existing module must not be marked virtual'
    );
    assert.strictEqual(module!.filePath, modulePath);
    const location = locateMetadataFile(modulePath, [tempRoot]);
    assert.ok(location, 'the existing module path must be locatable');
    assert.strictEqual(location!.objectType, 'Constants');
    assert.strictEqual(location!.objectName, 'Rate');
    assert.deepStrictEqual(location!.subPath, { kind: 'valueManagerModule' });

    const resolved = await resolveModuleId(modulePath, tempRoot);
    assert.ok(resolved, 'the existing module path must resolve for debugging');
    assert.strictEqual(resolved!.moduleId.objectId, CONSTANT_UUID);
    assert.strictEqual(resolved!.moduleId.propertyId, '3e58c91f-9aaa-4f42-8999-4baf33907b75');
    assert.strictEqual(
      await resolveBslPathFromRdbgModule(resolved!.moduleId, tempRoot),
      modulePath
    );
    assert.strictEqual(
      hasModulePath(constant!, 'ManagerModule.bsl'),
      false,
      'Constant must not expose a nonexistent virtual ManagerModule'
    );
  });

  test('EDT Constant tree exposes the real ValueManagerModule and no virtual ManagerModule', async () => {
    const sourceRoot = path.join(tempRoot, 'src');
    const elementPath = path.join(sourceRoot, 'Constants', 'Rate');
    const modulePath = path.join(elementPath, 'Ext', 'ValueManagerModule.bsl');
    await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.promises.writeFile(
      path.join(elementPath, 'Constant.mdo'),
      `<MetaDataObject><Constant uuid="${CONSTANT_UUID}"><Properties><Name>Rate</Name></Properties></Constant></MetaDataObject>`,
      'utf8'
    );
    await fs.promises.writeFile(modulePath, '// value manager module', 'utf8');

    const tree = await EdtParser.parse(tempRoot);
    const constant = findNode(
      tree,
      (node) => node.type === MetadataType.Constant && node.name === 'Rate'
    );
    assert.ok(constant, 'EDT parser should build the Constant tree node');
    assert.ok(
      findNode(
        constant!,
        (node) => path.basename(node.filePath ?? '') === 'ValueManagerModule.bsl'
      ),
      'the existing EDT ValueManagerModule must be visible in the parsed tree'
    );
    const location = locateMetadataFile(modulePath, [sourceRoot]);
    assert.ok(location, 'the EDT source path must be locatable relative to its src root');
    assert.strictEqual(location!.objectType, 'Constants');
    assert.strictEqual(location!.objectName, 'Rate');
    assert.deepStrictEqual(location!.subPath, { kind: 'valueManagerModule' });
    assert.strictEqual(
      hasModulePath(constant!, 'ManagerModule.bsl'),
      false,
      'EDT Constant must not expose a nonexistent virtual ManagerModule'
    );
  });
});
