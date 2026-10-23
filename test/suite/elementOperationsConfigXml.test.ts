import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  createElement,
  deleteElement,
} from '../../src/services/elementOperations';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { MutationPlanExecutor, type MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  createTempDir,
  cleanupTempDir,
  createConfigNode,
  fileExists,
  dirExists,
  readFileContent,
} from '../helpers/testHelpers';

/**
 * Tests for elementOperations that verify Configuration.xml after operations.
 * Validates: createElement adds to Configuration.xml, deleteElement removes from it.
 *
 * Would have caught:
 * - Configuration.xml not updated after createElement (BUG from this session)
 * - Configuration.xml not updated after deleteElement (BUG from this session)
 */

function createTypeNode(type: MetadataType, parentNode: TreeNode, filePath: string): TreeNode {
  return {
    id: `type-${String(type)}`,
    name: String(type),
    type,
    properties: {},
    filePath,
    parent: parentNode,
  };
}

function createElementNode(name: string, type: MetadataType, parentNode: TreeNode, filePath: string): TreeNode {
  return {
    id: `el-${name}`,
    name,
    type,
    properties: {},
    filePath,
    parent: parentNode,
  };
}

function parseRecorderXml(xml: string): Record<string, any> {
  const parsed = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(xml);
  return parsed?.MetaDataObject?.Document?.Properties ?? {};
}

function valuesAsArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).map(String);
}

const EDT_RECORDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
  <Document uuid="6736af77-cdfd-4fc3-92a4-9a9a35fe2a08">
    <Properties>
      <Name>Recorder</Name>
      <Comment>Keep &amp; preserve this text</Comment>
      <ExtensionPayload>
        <RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.NestedLookalike</xr:Item></RegisterRecords>
        <Value marker="A &amp; B">Nested &lt;payload&gt;</Value>
      </ExtensionPayload>
      <RegisterRecords>
        <xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Existing</xr:Item>
        <xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Existing</xr:Item>
      </RegisterRecords>
    </Properties>
    <ChildObjects/>
  </Document>
</MetaDataObject>`;

suite('elementOperations Configuration.xml integration', () => {
  let tmpDir: string;
  let configNode: TreeNode;
  let restoreMutationEngine: (() => void) | undefined;
  const configXmlPath = () => path.join(tmpDir, 'Configuration.xml');

  suiteSetup(() => {
    restoreMutationEngine = installDirectConfigurationMutationEngineForTests();
  });

  suiteTeardown(() => {
    restoreMutationEngine?.();
    restoreMutationEngine = undefined;
  });

  const BASE_CONFIG_XML = (childObjects: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects>
${childObjects}
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-elcfg-');
    configNode = createConfigNode();
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  // --- createElement updates Configuration.xml ---

  test('createElement adds <Catalog> entry to Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML(''), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    await createElement(typeNode, 'NewCatalog');

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Catalog>NewCatalog</Catalog>'),
      'Configuration.xml must contain the new Catalog entry');
  });

  test('createElement adds <Document> entry to Configuration.xml', async () => {
    const docsPath = path.join(tmpDir, 'Documents');
    await fs.promises.mkdir(docsPath, { recursive: true });
    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML(''), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Document, configNode, docsPath);
    await createElement(typeNode, 'NewDocument');

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Document>NewDocument</Document>'),
      'Configuration.xml must contain the new Document entry');
  });

  test('createElement adds EDT Sequence recorder participation only when a document is selected', async () => {
    const previousRecorder = process.env.IBCMD_RECORDER_DOCUMENT;
    const sourceDocuments = path.join(tmpDir, 'src', 'Documents');
    const sourceSequences = path.join(tmpDir, 'src', 'Sequences');
    const recorderPath = path.join(sourceDocuments, 'Recorder.xml');
    await fs.promises.mkdir(sourceDocuments, { recursive: true });
    await fs.promises.mkdir(sourceSequences, { recursive: true });
    await XMLWriter.createMinimalElementFile(recorderPath, 'Document', 'Recorder', '2.20');
    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Document>Recorder</Document>'), 'utf-8');

    try {
      process.env.IBCMD_RECORDER_DOCUMENT = 'Recorder';
      await createElement(createTypeNode(MetadataType.Sequence, configNode, sourceSequences), 'WithRecorder');
      const withRecorder = fs.readFileSync(path.join(sourceSequences, 'WithRecorder.xml'), 'utf-8');
      assert.match(withRecorder, /<Documents>\s*<xr:Item\s+xsi:type="xr:MDObjectRef">Document\.Recorder<\/xr:Item>\s*<\/Documents>/);

      delete process.env.IBCMD_RECORDER_DOCUMENT;
      await createElement(createTypeNode(MetadataType.Sequence, configNode, sourceSequences), 'WithoutRecorder');
      const withoutRecorder = fs.readFileSync(path.join(sourceSequences, 'WithoutRecorder.xml'), 'utf-8');
      assert.ok(!withoutRecorder.includes('Document.Recorder'), 'an unselected recorder must not be injected');
    } finally {
      if (previousRecorder === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = previousRecorder;
      }
    }
  });

  test('EDT AccumulationRegister adds recorder contribution to the same plan and preserves nested XML data', async () => {
    const previousRecorder = process.env.IBCMD_RECORDER_DOCUMENT;
    const sourceDocuments = path.join(tmpDir, 'src', 'Documents');
    const sourceRegisters = path.join(tmpDir, 'src', 'AccumulationRegisters');
    const recorderPath = path.join(sourceDocuments, 'Recorder.xml');
    const configurationBefore = BASE_CONFIG_XML('      <Document>Recorder</Document>');
    await fs.promises.mkdir(sourceDocuments, { recursive: true });
    await fs.promises.mkdir(sourceRegisters, { recursive: true });
    await fs.promises.writeFile(recorderPath, EDT_RECORDER_XML, 'utf8');
    fs.writeFileSync(configXmlPath(), configurationBefore, 'utf-8');

    let planCount = 0;
    let recorderWasInPlan = false;
    const gateway = configureConfigurationMutationGateway(
      async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
      async <T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> => {
        planCount++;
        recorderWasInPlan = plan.steps.some((step) =>
          step.type === 'writeFile' && path.resolve(step.targetPath) === path.resolve(recorderPath));
        return new MutationPlanExecutor(resourcePath).execute(plan);
      },
    );

    try {
      process.env.IBCMD_RECORDER_DOCUMENT = 'Recorder';
      await createElement(createTypeNode(MetadataType.AccumulationRegister, configNode, sourceRegisters), 'NewRegister');

      const recorderAfter = await fs.promises.readFile(recorderPath, 'utf8');
      const recorderProperties = parseRecorderXml(recorderAfter);
      const directItems = valuesAsArray(recorderProperties.RegisterRecords?.Item);
      const nestedItems = valuesAsArray(recorderProperties.ExtensionPayload?.RegisterRecords?.Item);
      assert.strictEqual(XMLValidator.validate(recorderAfter), true, 'the changed recorder remains well-formed XML');
      assert.strictEqual(planCount, 1, 'register and recorder are committed by one plan');
      assert.strictEqual(recorderWasInPlan, true, 'the recorder write is part of the register plan');
      assert.ok(directItems.includes('InformationRegister.Existing'));
      assert.ok(directItems.includes('AccumulationRegister.Existing'));
      assert.ok(directItems.includes('AccumulationRegister.NewRegister'));
      assert.deepStrictEqual(nestedItems, ['AccumulationRegister.NestedLookalike'],
        'a nested RegisterRecords lookalike must remain unchanged');
      assert.ok(recorderAfter.includes('<Comment>Keep &amp; preserve this text</Comment>'));
      assert.ok(recorderAfter.includes('<Value marker="A &amp; B">Nested &lt;payload&gt;</Value>'));
      assert.ok((await fs.promises.readFile(configXmlPath(), 'utf8')).includes('<AccumulationRegister>NewRegister</AccumulationRegister>'));
      assert.ok(await fileExists(path.join(sourceRegisters, 'NewRegister.xml')));
    } finally {
      gateway.dispose();
      if (previousRecorder === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = previousRecorder;
      }
    }
  });

  for (const scenario of [
    {
      name: 'foreign edit',
      mutateRecorder: async (recorderPath: string) => {
        const current = await fs.promises.readFile(recorderPath, 'utf8');
        await fs.promises.writeFile(
          recorderPath,
          current.replace('</Properties>', '<Comment>Foreign &amp; newer</Comment>\n    </Properties>'),
          'utf8',
        );
      },
      assertRecorder: async (recorderPath: string, foreignContent: string) => {
        assert.strictEqual(await fs.promises.readFile(recorderPath, 'utf8'), foreignContent,
          'the competing edit must survive the rejected plan');
      },
    },
    {
      name: 'foreign delete',
      mutateRecorder: async (recorderPath: string) => fs.promises.unlink(recorderPath),
      assertRecorder: async (recorderPath: string, _foreignContent: string) => {
        await assert.rejects(fs.promises.readFile(recorderPath), { code: 'ENOENT' },
          'the plan must not recreate a recorder deleted by another writer');
      },
    },
  ] as const) {
    test(`EDT register creation rejects a recorder ${scenario.name} before any plan file is committed`, async () => {
      const previousRecorder = process.env.IBCMD_RECORDER_DOCUMENT;
      const sourceDocuments = path.join(tmpDir, 'src', 'Documents');
      const sourceRegisters = path.join(tmpDir, 'src', 'AccumulationRegisters');
      const recorderPath = path.join(sourceDocuments, 'Recorder.xml');
      const configurationBefore = BASE_CONFIG_XML('      <Document>Recorder</Document>');
      await fs.promises.mkdir(sourceDocuments, { recursive: true });
      await fs.promises.mkdir(sourceRegisters, { recursive: true });
      await fs.promises.writeFile(recorderPath, EDT_RECORDER_XML, 'utf8');
      fs.writeFileSync(configXmlPath(), configurationBefore, 'utf-8');

      let recorderWasPlanned = false;
      let recorderRaceBarrierRan = false;
      let recorderExpectedHash: string | undefined;
      let planCount = 0;
      const gateway = configureConfigurationMutationGateway(
        async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
        async <T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> => {
          planCount++;
          const recorderStep = plan.steps.find((step) =>
            step.type === 'writeFile' && path.resolve(step.targetPath) === path.resolve(recorderPath));
          recorderWasPlanned = recorderStep?.type === 'writeFile';
          if (recorderStep?.type === 'writeFile' && recorderStep.expected.state === 'file') {
            recorderExpectedHash = recorderStep.expected.hash;
          }
          recorderRaceBarrierRan = true;
          await scenario.mutateRecorder(recorderPath);
          return new MutationPlanExecutor(resourcePath).execute(plan);
        },
      );

      try {
        process.env.IBCMD_RECORDER_DOCUMENT = 'Recorder';
        const foreignContent = scenario.name === 'foreign edit'
          ? (await fs.promises.readFile(recorderPath, 'utf8'))
              .replace('</Properties>', '<Comment>Foreign &amp; newer</Comment>\n    </Properties>')
          : '';
        let failure: unknown;
        try {
          await createElement(createTypeNode(MetadataType.AccumulationRegister, configNode, sourceRegisters), 'RacedRegister');
        } catch (error) {
          failure = error;
        }

        assert.strictEqual(planCount, 1, 'the one plan runner must be reached');
        assert.strictEqual(recorderRaceBarrierRan, true, 'the foreign edit/delete must happen after plan admission and before execution');
        assert.strictEqual(recorderWasPlanned, true, 'recorder snapshot must be a write target in the single plan');
        assert.strictEqual(recorderExpectedHash, hashContent(EDT_RECORDER_XML),
          'the plan compares against the exact recorder bytes used by the contribution');
        assert.ok(failure, 'a changed or deleted recorder snapshot must reject the plan');
        await scenario.assertRecorder(recorderPath, foreignContent);
        assert.strictEqual(await fs.promises.readFile(configXmlPath(), 'utf8'), configurationBefore,
          'Configuration.xml remains unchanged when the recorder expectation fails');
        assert.strictEqual(await fileExists(path.join(sourceRegisters, 'RacedRegister.xml')), false,
          'the register remains absent when the recorder expectation fails');
      } finally {
        gateway.dispose();
        if (previousRecorder === undefined) {
          delete process.env.IBCMD_RECORDER_DOCUMENT;
        } else {
          process.env.IBCMD_RECORDER_DOCUMENT = previousRecorder;
        }
      }
    });
  }

  test('EDT create rejects an unregistered recorder before writing the register or Configuration.xml', async () => {
    const previousRecorder = process.env.IBCMD_RECORDER_DOCUMENT;
    const sourceDocuments = path.join(tmpDir, 'src', 'Documents');
    const sourceRegisters = path.join(tmpDir, 'src', 'AccumulationRegisters');
    const recorderPath = path.join(sourceDocuments, 'Recorder.xml');
    const configurationBefore = BASE_CONFIG_XML('      <Document>OtherDocument</Document>');
    await fs.promises.mkdir(sourceDocuments, { recursive: true });
    await fs.promises.mkdir(sourceRegisters, { recursive: true });
    await fs.promises.writeFile(recorderPath, EDT_RECORDER_XML, 'utf8');
    fs.writeFileSync(configXmlPath(), configurationBefore, 'utf-8');

    let planCount = 0;
    const gateway = configureConfigurationMutationGateway(
      async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
      async <T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> => {
        planCount++;
        return new MutationPlanExecutor(resourcePath).execute(plan);
      },
    );

    try {
      process.env.IBCMD_RECORDER_DOCUMENT = 'Recorder';
      let failure: unknown;
      try {
        await createElement(createTypeNode(MetadataType.AccumulationRegister, configNode, sourceRegisters), 'InvalidRecorderRegister');
      } catch (error) {
        failure = error;
      }
      assert.deepStrictEqual(
        { planCount, rejected: failure !== undefined },
        { planCount: 0, rejected: true },
        'an unregistered recorder must fail before the plan runner is entered',
      );
      assert.strictEqual(planCount, 0, 'invalid recorder validation must finish before plan execution');
      assert.strictEqual(await fs.promises.readFile(configXmlPath(), 'utf8'), configurationBefore);
      assert.strictEqual(await fileExists(path.join(sourceRegisters, 'InvalidRecorderRegister.xml')), false);
      assert.strictEqual(await fs.promises.readFile(recorderPath, 'utf8'), EDT_RECORDER_XML);
    } finally {
      gateway.dispose();
      if (previousRecorder === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = previousRecorder;
      }
    }
  });

  test('EDT recorder contributor failure occurs before the main plan commits', async () => {
    const previousRecorder = process.env.IBCMD_RECORDER_DOCUMENT;
    const sourceDocuments = path.join(tmpDir, 'src', 'Documents');
    const sourceRegisters = path.join(tmpDir, 'src', 'AccumulationRegisters');
    const recorderPath = path.join(sourceDocuments, 'Recorder.xml');
    const directRegisterRecords = `      <RegisterRecords>
        <xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Existing</xr:Item>
        <xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Existing</xr:Item>
      </RegisterRecords>`;
    const invalidRecorderXml = EDT_RECORDER_XML.replace(directRegisterRecords, '');
    const invalidRecorderProperties = parseRecorderXml(invalidRecorderXml);
    assert.strictEqual(invalidRecorderProperties.RegisterRecords, undefined,
      'the fixture must have no direct RegisterRecords section');
    assert.deepStrictEqual(
      valuesAsArray(invalidRecorderProperties.ExtensionPayload?.RegisterRecords?.Item),
      ['AccumulationRegister.NestedLookalike'],
      'the nested lookalike must remain in the invalid recorder fixture',
    );
    const configurationBefore = BASE_CONFIG_XML('      <Document>Recorder</Document>');
    await fs.promises.mkdir(sourceDocuments, { recursive: true });
    await fs.promises.mkdir(sourceRegisters, { recursive: true });
    await fs.promises.writeFile(recorderPath, invalidRecorderXml, 'utf8');
    fs.writeFileSync(configXmlPath(), configurationBefore, 'utf-8');

    let planCount = 0;
    const gateway = configureConfigurationMutationGateway(
      async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
      async <T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> => {
        planCount++;
        return new MutationPlanExecutor(resourcePath).execute(plan);
      },
    );

    try {
      process.env.IBCMD_RECORDER_DOCUMENT = 'Recorder';
      let failure: unknown;
      try {
        await createElement(createTypeNode(MetadataType.AccumulationRegister, configNode, sourceRegisters), 'ContributorFailure');
      } catch (error) {
        failure = error;
      }
      assert.deepStrictEqual(
        { planCount, rejected: failure !== undefined },
        { planCount: 0, rejected: true },
        'contribution validation must reject before the plan runner is entered',
      );
      assert.strictEqual(planCount, 0, 'contribution validation must complete before the write-ahead plan is committed');
      assert.strictEqual(await fs.promises.readFile(configXmlPath(), 'utf8'), configurationBefore);
      assert.strictEqual(await fileExists(path.join(sourceRegisters, 'ContributorFailure.xml')), false);
      assert.strictEqual(await fs.promises.readFile(recorderPath, 'utf8'), invalidRecorderXml);
    } finally {
      gateway.dispose();
      if (previousRecorder === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = previousRecorder;
      }
    }
  });

  test('createElement preserves existing entries in Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const existingCatalog = path.join(catalogsPath, 'ExistingCatalog.xml');
    await XMLWriter.createMinimalElementFile(existingCatalog, 'Catalog', 'ExistingCatalog', '2.20');

    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Catalog>ExistingCatalog</Catalog>'), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    await createElement(typeNode, 'AnotherCatalog');

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Catalog>ExistingCatalog</Catalog>'),
      'Existing entry must remain');
    assert.ok(configXml.includes('<Catalog>AnotherCatalog</Catalog>'),
      'New entry must be added');
  });

  // --- deleteElement removes from Configuration.xml ---

  test('deleteElement removes <Catalog> entry from Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const catalogPath = path.join(catalogsPath, 'TestCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'TestCatalog', '2.20');

    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Catalog>TestCatalog</Catalog>'), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    const catalogNode = createElementNode('TestCatalog', MetadataType.Catalog, typeNode, catalogPath);

    await deleteElement(catalogNode);

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(!configXml.includes('<Catalog>TestCatalog</Catalog>'),
      'Deleted catalog entry must be removed from Configuration.xml');
  });

  test('deleteElement removes only the deleted entry, preserves others', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const catalogPath = path.join(catalogsPath, 'TestCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'TestCatalog', '2.20');

    fs.writeFileSync(
      configXmlPath(),
      BASE_CONFIG_XML('      <Catalog>KeepCatalog</Catalog>\n      <Catalog>TestCatalog</Catalog>\n      <Language>Русский</Language>'),
      'utf-8'
    );

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    const catalogNode = createElementNode('TestCatalog', MetadataType.Catalog, typeNode, catalogPath);

    await deleteElement(catalogNode);

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(!configXml.includes('<Catalog>TestCatalog</Catalog>'),
      'Deleted entry must be removed');
    assert.ok(configXml.includes('<Catalog>KeepCatalog</Catalog>'),
      'Other catalog entry must remain');
    assert.ok(configXml.includes('<Language>Русский</Language>'),
      'Language entry must remain');
  });

  // --- deleteElement for nested elements does NOT touch Configuration.xml ---

  test('deleteElement for Attribute does not modify Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const catalogPath = path.join(catalogsPath, 'CatWithAttr.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'CatWithAttr', '2.20');
    await XMLWriter.addNestedElement(catalogPath, 'Attribute', 'TestAttr');

    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Catalog>CatWithAttr</Catalog>'), 'utf-8');

    // Create attribute node with parentFilePath
    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    const catalogNode = createElementNode('CatWithAttr', MetadataType.Catalog, typeNode, catalogPath);
    const attrNode: TreeNode = {
      id: 'attr-TestAttr',
      name: 'TestAttr',
      type: MetadataType.Attribute,
      properties: {},
      parent: catalogNode,
      parentFilePath: catalogPath,
    };

    await deleteElement(attrNode);

    // Config.xml must be unchanged
    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Catalog>CatWithAttr</Catalog>'),
      'Configuration.xml must not be modified when deleting nested element');

    // Nested delete should remove only nested attribute from parent XML.
    const catalogXml = fs.readFileSync(catalogPath, 'utf-8');
    assert.ok(!catalogXml.includes('<Name>TestAttr</Name>'),
      'Parent XML should remove nested attribute on delete operation');
  });
});
