import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  appendRegisterReferenceToRecorderDocument,
  removeRegisterReferenceFromRecorderDocument,
  appendRegisterReferenceToRecorderDocumentXml,
  removeRegisterReferenceFromRecorderDocumentXml,
} from '../../src/services/registerRecorderDocumentLinker';
import { SMOKE_EMPTY_CONF_RECORDER_DOCUMENT } from '../helpers/smokeIbcmdConstants';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import { MutationReceiptError } from '../../src/services/configurationSession/mutationReceiptError';
import { MutationPlanError } from '../../src/services/configurationSession/mutationPlan';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';

function parseRecorderProperties(xml: string): Record<string, any> {
  const parsed = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(xml);
  return parsed?.MetaDataObject?.Document?.Properties ?? {};
}

function isTypedRecorderConflict(error: unknown): boolean {
  return (error instanceof MutationReceiptError && error.status === 'conflict')
    || (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT');
}

suite('registerRecorderDocumentLinker', () => {
  let tmpDir: string;
  let restoreTestEngine: (() => void) | undefined;

  suiteSetup(() => {
    restoreTestEngine = installDirectConfigurationMutationEngineForTests();
  });

  suiteTeardown(() => {
    restoreTestEngine?.();
  });

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-rrd-');
    const documentsDir = path.join(tmpDir, 'Documents');
    await fs.promises.mkdir(documentsDir, { recursive: true });
    const docPath = path.join(documentsDir, 'ДокументТестРаботает.xml');
    await fs.promises.writeFile(
      docPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
<Document uuid="6736af77-cdfd-4fc3-92a4-9a9a35fe2a08">
<Properties><Name>ДокументТестРаботает</Name><RegisterRecords/></Properties>
<ChildObjects/>
</Document>
</MetaDataObject>
`,
      'utf-8'
    );
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('is no-op when recorder document name is missing', async () => {
    const p = path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml');
    const before = await fs.promises.readFile(p, 'utf-8');
    await appendRegisterReferenceToRecorderDocument(tmpDir, 'AccumulationRegister', 'Orphan', undefined);
    await appendRegisterReferenceToRecorderDocument(tmpDir, 'AccumulationRegister', 'Orphan', '  ');
    assert.strictEqual(await fs.promises.readFile(p, 'utf-8'), before);
  });

  test('is no-op when recorder document file is missing', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'X',
      'NoSuchDocument'
    );
    await assert.rejects(
      fs.promises.access(path.join(tmpDir, 'Documents', 'NoSuchDocument.xml')),
      { code: 'ENOENT' },
      'the legacy missing-recorder no-op must not create an empty recorder file',
    );
  });

  test('skips append when ref is already present', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    const mid = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'), 'utf-8'),
      mid
    );
  });

  test('remove is no-op when ref is absent', async () => {
    const p = path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml');
    const before = await fs.promises.readFile(p, 'utf-8');
    await removeRegisterReferenceFromRecorderDocument(
      tmpDir,
      'InformationRegister',
      'NotThere',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    assert.strictEqual(await fs.promises.readFile(p, 'utf-8'), before);
  });

  test('uses IBCMD_RECORDER_DOCUMENT when recorder name arg omitted', async () => {
    const prev = process.env.IBCMD_RECORDER_DOCUMENT;
    try {
      process.env.IBCMD_RECORDER_DOCUMENT = SMOKE_EMPTY_CONF_RECORDER_DOCUMENT;
      await appendRegisterReferenceToRecorderDocument(tmpDir, 'InformationRegister', 'EnvLinkedReg');
      const xml = await fs.promises.readFile(
        path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
        'utf-8'
      );
      assert.ok(xml.includes('InformationRegister.EnvLinkedReg'));
    } finally {
      if (prev === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = prev;
      }
    }
  });

  test('append then remove clears RegisterRecords to self-closing', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    let xml = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    assert.ok(xml.includes('AccumulationRegister.Matrix_TestReg'));
    await removeRegisterReferenceFromRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    xml = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    assert.ok(!xml.includes('Matrix_TestReg'));
    assert.ok(xml.includes('<RegisterRecords/>'));
  });

  test('inserts before closing RegisterRecords when block is non-empty', async () => {
    const d = await createTempDir('1cviewer-rrd-closing-');
    try {
      const documentsDir = path.join(d, 'Documents');
      await fs.promises.mkdir(documentsDir, { recursive: true });
      const docPath = path.join(documentsDir, 'RecDoc.xml');
      await fs.promises.writeFile(
        docPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
<Document uuid="11111111-1111-1111-1111-111111111111">
<Properties><Name>RecDoc</Name>
<RegisterRecords>
\t\t\t<xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Existing</xr:Item>
\t\t</RegisterRecords></Properties>
<ChildObjects/>
</Document>
</MetaDataObject>
`,
        'utf-8'
      );
      await appendRegisterReferenceToRecorderDocument(d, 'AccumulationRegister', 'Extra', 'RecDoc');
      const xml = await fs.promises.readFile(docPath, 'utf-8');
      assert.ok(xml.includes('InformationRegister.Existing'));
      assert.ok(xml.includes('AccumulationRegister.Extra'));
    } finally {
      await cleanupTempDir(d);
    }
  });

  test('append is no-op when RegisterRecords section is absent', async () => {
    const d = await createTempDir('1cviewer-rrd-none-');
    try {
      const documentsDir = path.join(d, 'Documents');
      await fs.promises.mkdir(documentsDir, { recursive: true });
      const docPath = path.join(documentsDir, 'Bare.xml');
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
<Document uuid="22222222-2222-2222-2222-222222222222">
<Properties><Name>Bare</Name></Properties>
<ChildObjects/>
</Document>
</MetaDataObject>
`;
      await fs.promises.writeFile(docPath, body, 'utf-8');
      await appendRegisterReferenceToRecorderDocument(d, 'AccumulationRegister', 'Orphan', 'Bare');
      assert.strictEqual(await fs.promises.readFile(docPath, 'utf-8'), body);
    } finally {
      await cleanupTempDir(d);
    }
  });

  test('pure removal targets exact xr:Item children of RegisterRecords and is idempotent', () => {
    const xml = `<MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Document><Properties><Name>Recorder</Name>
<RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.TargetExtra</xr:Item><xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Target</xr:Item></RegisterRecords>
</Properties>
<ChildObjects><Wrapper><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item></Wrapper></ChildObjects>
</Document></MetaDataObject>`;
    const result = removeRegisterReferenceFromRecorderDocumentXml(xml, 'AccumulationRegister', 'Target');
    const records = result.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/)?.[1] ?? '';
    assert.doesNotMatch(records, /<xr:Item[^>]*>AccumulationRegister\.Target<\/xr:Item>/);
    assert.match(records, /AccumulationRegister\.TargetExtra/);
    assert.match(records, /InformationRegister\.Target/);
    assert.match(result, /<Wrapper><xr:Item[^>]*>AccumulationRegister\.Target<\/xr:Item><\/Wrapper>/);
    assert.strictEqual(removeRegisterReferenceFromRecorderDocumentXml(result, 'AccumulationRegister', 'Target'), result);
  });

  test('decodes hexadecimal and decimal entities while preserving adjacent and nested references', () => {
    const xml = `<MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Document><Properties><Name>Recorder</Name>
<RegisterRecords>
<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister&#x2E;Target</xr:Item>
<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister&#46;Target</xr:Item>
<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister&#x2e;TargetExtra</xr:Item>
<xr:Item xsi:type="xr:MDObjectRef">InformationRegister&#x2e;Target</xr:Item>
		</RegisterRecords>
<ChildObjects/>
</Properties>
<ChildObjects><Wrapper><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister&#46;Target</xr:Item></Wrapper></ChildObjects>
</Document></MetaDataObject>`;

    const result = removeRegisterReferenceFromRecorderDocumentXml(xml, 'AccumulationRegister', 'Target');
    const records = result.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/)?.[1] ?? '';
    assert.doesNotMatch(records, /AccumulationRegister&#(?:x2E|46);Target/);
    assert.match(records, /AccumulationRegister&#x2e;TargetExtra/);
    assert.match(records, /InformationRegister&#x2e;Target/);
    assert.match(result, /<Wrapper><xr:Item[^>]*>AccumulationRegister&#46;Target<\/xr:Item><\/Wrapper>/);
    assert.strictEqual(removeRegisterReferenceFromRecorderDocumentXml(result, 'AccumulationRegister', 'Target'), result);
  });

  test('pure append updates the direct recorder section when a nested lookalike already has the same identity', () => {
    const xml = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Document><Properties><Name>Recorder</Name><Comment>Keep &amp; preserve</Comment>
<ExtensionPayload><RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item></RegisterRecords><Value marker="A &amp; B">Nested &lt;payload&gt;</Value></ExtensionPayload>
<RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Existing</xr:Item></RegisterRecords>
</Properties><ChildObjects/></Document></MetaDataObject>`;

    const result = appendRegisterReferenceToRecorderDocumentXml(xml, 'AccumulationRegister', 'Target');
    const properties = parseRecorderProperties(result);
    const directItems = properties.RegisterRecords?.Item;
    const nestedItems = properties.ExtensionPayload?.RegisterRecords?.Item;
    assert.strictEqual(XMLValidator.validate(result), true, 'the contribution must leave well-formed XML');
    assert.ok((Array.isArray(directItems) ? directItems : [directItems]).includes('AccumulationRegister.Target'),
      'the direct Document/RegisterRecords section must receive the new reference');
    assert.deepStrictEqual(Array.isArray(nestedItems) ? nestedItems : [nestedItems], ['AccumulationRegister.Target'],
      'the nested lookalike remains intact and does not suppress the direct contribution');
    assert.ok(result.includes('<Comment>Keep &amp; preserve</Comment>'));
    assert.ok(result.includes('<Value marker="A &amp; B">Nested &lt;payload&gt;</Value>'));
  });

  test('pure removal removes only the direct recorder item, preserving nested lookalikes and adjacent references', () => {
    const xml = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Document><Properties><Name>Recorder</Name>
<ExtensionPayload><RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item><Value>keep &amp; preserve</Value></RegisterRecords></ExtensionPayload>
<RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.TargetExtra</xr:Item><xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Target</xr:Item></RegisterRecords>
</Properties><ChildObjects/></Document></MetaDataObject>`;

    const result = removeRegisterReferenceFromRecorderDocumentXml(xml, 'AccumulationRegister', 'Target');
    const properties = parseRecorderProperties(result);
    const directItems = properties.RegisterRecords?.Item;
    const nestedItems = properties.ExtensionPayload?.RegisterRecords?.Item;
    assert.strictEqual(XMLValidator.validate(result), true, 'the removal must leave well-formed XML');
    assert.deepStrictEqual(Array.isArray(directItems) ? directItems : [directItems], [
      'AccumulationRegister.TargetExtra',
      'InformationRegister.Target',
    ]);
    assert.deepStrictEqual(Array.isArray(nestedItems) ? nestedItems : [nestedItems], ['AccumulationRegister.Target']);
    assert.ok(result.includes('<Value>keep &amp; preserve</Value>'));
  });

  for (const scenario of [
    {
      name: 'append',
      seed: async (_docPath: string) => undefined,
      mutate: (root: string) => appendRegisterReferenceToRecorderDocument(root, 'AccumulationRegister', 'Raced', 'ДокументТестРаботает'),
    },
    {
      name: 'remove',
      seed: async (docPath: string) => {
        const original = await fs.promises.readFile(docPath, 'utf8');
        await fs.promises.writeFile(docPath, original.replace('<RegisterRecords/>', '<RegisterRecords><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Raced</xr:Item></RegisterRecords>'), 'utf8');
      },
      mutate: (root: string) => removeRegisterReferenceFromRecorderDocument(root, 'AccumulationRegister', 'Raced', 'ДокументТестРаботает'),
    },
  ] as const) {
    test(`${scenario.name} rejects a recorder deleted after admission without recreating it`, async () => {
      const docPath = path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml');
      await scenario.seed(docPath);
      const previousEngine = getConfigurationMutationEngine();
      let admitted = 0;
      let snapshotCaptured = false;
      setConfigurationMutationEngine(new ConfigurationMutationEngine({
        runMutation: async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => {
          admitted++;
          return operation();
        },
      }));
      const mutableFsPromises = fs.promises as unknown as { readFile: (...args: any[]) => Promise<any> };
      const originalReadFile = mutableFsPromises.readFile;
      mutableFsPromises.readFile = async (...args: any[]) => {
        const content = await originalReadFile.apply(fs.promises, args);
        if (!snapshotCaptured && path.resolve(String(args[0])) === path.resolve(docPath)) {
          snapshotCaptured = true;
          await fs.promises.unlink(docPath);
        }
        return content;
      };

      try {
        let failure: unknown;
        try {
          await scenario.mutate(tmpDir);
        } catch (error) {
          failure = error;
        }
        assert.strictEqual(snapshotCaptured, true, 'the recorder snapshot must be read before the injected deletion');
        assert.deepStrictEqual(
          {
            admitted,
            typedConflict: failure !== undefined && isTypedRecorderConflict(failure),
            recreated: await fs.promises.access(docPath).then(() => true, () => false),
          },
          { admitted: 1, typedConflict: true, recreated: false },
          'the admitted exact-snapshot mutation must conflict without resurrecting a recorder deleted after its read',
        );
      } finally {
        mutableFsPromises.readFile = originalReadFile;
        setConfigurationMutationEngine(previousEngine);
      }
    });
  }
});
