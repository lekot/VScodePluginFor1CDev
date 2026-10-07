import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  generateChartOfAccountsXml,
  generatePredefinedAccountsXml,
  collectAvailableSubcontoTypes,
  planCreateChartOfAccounts,
  type ChartOfAccountsWizardParams,
} from '../../src/services/chartOfAccountsWizardService';
import { XmlParser } from '../../src/parsers/xmlParser';
import { buildInternalInfoXml } from '../../src/utils/xml/internalInfoGenerator';
import { MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';

suite('ChartOfAccountsWizardService Test Suite', () => {
  test('internalInfoGenerator creates all 7 platform-required GeneratedTypes for ChartOfAccounts', () => {
    const xml = buildInternalInfoXml('ChartOfAccounts', 'Хозрасчетный', '  ');
    assert.ok(xml.includes('name="ChartOfAccountsObject.Хозрасчетный" category="Object"'));
    assert.ok(xml.includes('name="ChartOfAccountsRef.Хозрасчетный" category="Ref"'));
    assert.ok(xml.includes('name="ChartOfAccountsSelection.Хозрасчетный" category="Selection"'));
    assert.ok(xml.includes('name="ChartOfAccountsList.Хозрасчетный" category="List"'));
    assert.ok(xml.includes('name="ChartOfAccountsManager.Хозрасчетный" category="Manager"'));
    assert.ok(xml.includes('name="ChartOfAccountsExtDimensionTypes.Хозрасчетный" category="ExtDimensionTypes"'));
    assert.ok(xml.includes('name="ChartOfAccountsExtDimensionTypesRow.Хозрасчетный" category="ExtDimensionTypesRow"'));
  });

  test('generateChartOfAccountsXml creates valid 1C Designer XML with all 7 GeneratedTypes and subconto settings', () => {
    const params: ChartOfAccountsWizardParams = {
      name: 'Бухгалтерский',
      synonym: 'Бухгалтерский учет & аудит',
      comment: 'Основной план счетов <2026>',
      codeMask: '@@@.@@.@',
      codeLength: 8,
      descriptionLength: 120,
      orderLength: 5,
      extDimensionTypes: 'ChartOfCharacteristicTypes.ВидыСубконто',
      maxExtDimensionCount: 3,
      accountingFlags: [
        { name: 'Валютный', synonym: 'Валютный учет' },
        { name: 'Количественный', synonym: 'Количественный учет' },
      ],
      extDimensionAccountingFlags: [
        { name: 'Суммовой', synonym: 'Суммовой учет субконто' },
      ],
    };

    const xml = generateChartOfAccountsXml(params, '2.20');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<MetaDataObject'));
    assert.ok(xml.includes('<ChartOfAccounts uuid="'));

    // Check InternalInfo types
    assert.ok(xml.includes('name="ChartOfAccountsObject.Бухгалтерский" category="Object"'));
    assert.ok(xml.includes('name="ChartOfAccountsRef.Бухгалтерский" category="Ref"'));
    assert.ok(xml.includes('name="ChartOfAccountsSelection.Бухгалтерский" category="Selection"'));
    assert.ok(xml.includes('name="ChartOfAccountsList.Бухгалтерский" category="List"'));
    assert.ok(xml.includes('name="ChartOfAccountsManager.Бухгалтерский" category="Manager"'));
    assert.ok(xml.includes('name="ChartOfAccountsExtDimensionTypes.Бухгалтерский" category="ExtDimensionTypes"'));
    assert.ok(xml.includes('name="ChartOfAccountsExtDimensionTypesRow.Бухгалтерский" category="ExtDimensionTypesRow"'));

    // Check properties and XML escaping
    assert.ok(xml.includes('<Name>Бухгалтерский</Name>'));
    assert.ok(xml.includes('Бухгалтерский учет &amp; аудит'));
    assert.ok(xml.includes('Основной план счетов &lt;2026&gt;'));
    assert.ok(xml.includes('<CodeMask>@@@.@@.@</CodeMask>'));
    assert.ok(xml.includes('<CodeLength>8</CodeLength>'));
    assert.ok(xml.includes('<DescriptionLength>120</DescriptionLength>'));
    assert.ok(xml.includes('<OrderLength>5</OrderLength>'));
    assert.ok(xml.includes('<ExtDimensionTypes>ChartOfCharacteristicTypes.ВидыСубконто</ExtDimensionTypes>'));
    assert.ok(xml.includes('<MaxExtDimensionCount>3</MaxExtDimensionCount>'));
    assert.ok(xml.includes('<Characteristics/>') || xml.includes('<Characteristics />'));
    assert.ok(xml.includes('<BasedOn/>') || xml.includes('<BasedOn />'));

    // Verify catalog-only properties are absent
    assert.ok(!xml.includes('<Hierarchical>'), 'ChartOfAccounts must not have Hierarchical tag');
    assert.ok(!xml.includes('<FoldersOnTop>'), 'ChartOfAccounts must not have FoldersOnTop tag');
    assert.ok(!xml.includes('<CodeAllowedLength>'), 'ChartOfAccounts must not have CodeAllowedLength tag');
    assert.ok(!xml.includes('<Autonumbering>'), 'ChartOfAccounts must not have Autonumbering tag');
    assert.ok(!xml.includes('<DefaultFolderForm>'), 'ChartOfAccounts must not have DefaultFolderForm tag');
    assert.ok(!xml.includes('<DefaultFolderChoiceForm>'), 'ChartOfAccounts must not have DefaultFolderChoiceForm tag');
    assert.ok(!xml.includes('<AuxiliaryFolderForm>'), 'ChartOfAccounts must not have AuxiliaryFolderForm tag');
    assert.ok(!xml.includes('<AuxiliaryFolderChoiceForm>'), 'ChartOfAccounts must not have AuxiliaryFolderChoiceForm tag');

    // Check ChildObjects
    assert.ok(xml.includes('<AccountingFlag uuid="'));
    assert.ok(xml.includes('<Name>Валютный</Name>'));
    assert.ok(xml.includes('<Name>Количественный</Name>'));
    assert.ok(xml.includes('<ExtDimensionAccountingFlag uuid="'));
    assert.ok(xml.includes('<Name>Суммовой</Name>'));

    // Verify it parses without error
    const parsed = XmlParser.parseString(xml) as Record<string, unknown>;
    const coa = parsed.MetaDataObject as Record<string, unknown>;
    assert.ok(coa.ChartOfAccounts);
  });

  test('generateChartOfAccountsXml with no subconto sets MaxExtDimensionCount to 0 and empty ExtDimensionTypes', () => {
    const params: ChartOfAccountsWizardParams = {
      name: 'Простой',
      synonym: 'Простой план',
    };

    const xml = generateChartOfAccountsXml(params);
    assert.ok(xml.includes('<ExtDimensionTypes/>') || xml.includes('<ExtDimensionTypes />'));
    assert.ok(xml.includes('<MaxExtDimensionCount>0</MaxExtDimensionCount>'));
  });

  test('generatePredefinedAccountsXml creates valid PredefinedData with initial accounts and empty tag fallback', () => {
    const paramsWithAccounts: ChartOfAccountsWizardParams = {
      name: 'План1',
      predefinedAccounts: [
        {
          name: 'Вспомогательный',
          code: '000',
          description: 'Вспомогательный счет',
          accountType: 'ActivePassive',
          offBalance: false,
          order: '000',
        },
        {
          name: 'Касса',
          code: '50',
          description: 'Касса предприятия',
          accountType: 'Active',
          offBalance: false,
        },
      ],
    };

    const xml = generatePredefinedAccountsXml(paramsWithAccounts, '2.20');
    assert.ok(xml.includes('xsi:type="ChartOfAccountsPredefinedItems"'));
    assert.ok(xml.includes('<Name>Вспомогательный</Name>'));
    assert.ok(xml.includes('<Code>000</Code>'));
    assert.ok(xml.includes('<AccountType>ActivePassive</AccountType>'));
    assert.ok(xml.includes('<Name>Касса</Name>'));
    assert.ok(xml.includes('<Code>50</Code>'));
    assert.ok(xml.includes('<AccountType>Active</AccountType>'));

    // Empty predefined accounts
    const emptyParams: ChartOfAccountsWizardParams = {
      name: 'Пустой',
    };
    const emptyXml = generatePredefinedAccountsXml(emptyParams, '2.20');
    assert.ok(emptyXml.includes('xsi:type="ChartOfAccountsPredefinedItems"'));
    assert.ok(!emptyXml.includes('<Item '));
  });

  test('collectAvailableSubcontoTypes finds existing ChartOfCharacteristicTypes', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-coa-subconto-test-'));
    try {
      const cotDir = path.join(tmpDir, 'ChartsOfCharacteristicTypes');
      await fs.promises.mkdir(cotDir, { recursive: true });
      await fs.promises.writeFile(path.join(cotDir, 'ВидыСубконто.xml'), '<MetaDataObject/>', 'utf8');
      await fs.promises.writeFile(path.join(cotDir, 'СтатьиЗатрат.xml'), '<MetaDataObject/>', 'utf8');

      const result = await collectAvailableSubcontoTypes(tmpDir);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'ВидыСубконто');
      assert.strictEqual(result[0].ref, 'ChartOfCharacteristicTypes.ВидыСубконто');
      assert.strictEqual(result[1].name, 'СтатьиЗатрат');
      assert.strictEqual(result[1].ref, 'ChartOfCharacteristicTypes.СтатьиЗатрат');
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('planCreateChartOfAccounts creates all files, directories and updates Configuration.xml', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-coa-plan-test-'));
    try {
      const initialConfigXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
\t<Configuration uuid="11111111-1111-1111-1111-111111111111">
\t\t<Properties>
\t\t\t<Name>ТестКонф</Name>
\t\t</Properties>
\t\t<ChildObjects>
\t\t\t<Catalog>Товары</Catalog>
\t\t</ChildObjects>
\t</Configuration>
</MetaDataObject>`;
      await fs.promises.writeFile(path.join(tmpDir, 'Configuration.xml'), initialConfigXml, 'utf8');

      const params: ChartOfAccountsWizardParams = {
        name: 'Хозрасчетный',
        synonym: 'План счетов бухгалтерского учета',
        codeMask: '@@@.@@.@',
        codeLength: 8,
        descriptionLength: 120,
        predefinedAccounts: [
          {
            name: 'Вспомогательный',
            code: '000',
            description: 'Вспомогательный счет',
          },
        ],
      };

      const plan = await planCreateChartOfAccounts({
        configPath: tmpDir,
        params,
      });

      assert.strictEqual(plan.steps.length, 6); // coasDir, coa.xml, coaChildDir, extDir, predefined.xml, Configuration.xml

      const executor = new MutationPlanExecutor(tmpDir);
      const execResult = await executor.execute(plan);
      assert.strictEqual(execResult.success, true);

      // Verify files on disk
      const coaXmlPath = path.join(tmpDir, 'ChartsOfAccounts', 'Хозрасчетный.xml');
      assert.ok(fs.existsSync(coaXmlPath));
      const coaContent = await fs.promises.readFile(coaXmlPath, 'utf8');
      assert.ok(coaContent.includes('ChartOfAccountsExtDimensionTypes.Хозрасчетный'));

      const predefinedPath = path.join(tmpDir, 'ChartsOfAccounts', 'Хозрасчетный', 'Ext', 'Predefined.xml');
      assert.ok(fs.existsSync(predefinedPath));
      const predefContent = await fs.promises.readFile(predefinedPath, 'utf8');
      assert.ok(predefContent.includes('<Name>Вспомогательный</Name>'));

      const updatedConfigXml = await fs.promises.readFile(path.join(tmpDir, 'Configuration.xml'), 'utf8');
      assert.ok(updatedConfigXml.includes('<ChartOfAccounts>Хозрасчетный</ChartOfAccounts>'));
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('planCreateChartOfAccounts throws error if object already exists or name is invalid', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-coa-validation-test-'));
    try {
      const initialConfigXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
\t<Configuration uuid="11111111-1111-1111-1111-111111111111">
\t\t<Properties><Name>ТестКонф</Name></Properties>
\t\t<ChildObjects/>
\t</Configuration>
</MetaDataObject>`;
      await fs.promises.writeFile(path.join(tmpDir, 'Configuration.xml'), initialConfigXml, 'utf8');

      // Invalid name
      await assert.rejects(
        planCreateChartOfAccounts({
          configPath: tmpDir,
          params: { name: '123НевалидноеИмя' },
        }),
        /неверно/i
      );

      // Create existing
      const coaDir = path.join(tmpDir, 'ChartsOfAccounts');
      await fs.promises.mkdir(coaDir, { recursive: true });
      await fs.promises.writeFile(path.join(coaDir, 'Существующий.xml'), '<MetaDataObject/>', 'utf8');

      await assert.rejects(
        planCreateChartOfAccounts({
          configPath: tmpDir,
          params: { name: 'Существующий' },
        }),
        /уже существует/i
      );
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
