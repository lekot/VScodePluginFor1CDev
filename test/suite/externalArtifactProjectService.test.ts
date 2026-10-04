import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ExternalArtifactProjectService,
} from '../../src/services/externalProcessor/externalArtifactProjectService';

suite('ExternalArtifactProjectService', () => {
  let temporaryRoot: string;
  let workspaceRoot: string;
  let service: ExternalArtifactProjectService;

  setup(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-external-artifact-'));
    workspaceRoot = path.join(temporaryRoot, 'workspace');
    fs.mkdirSync(workspaceRoot);
    service = new ExternalArtifactProjectService(
      path.resolve(process.cwd(), 'resources/external-artifacts')
    );
  });

  teardown(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  for (const scenario of [
    {
      kind: 'ExternalDataProcessor' as const,
      name: 'NewProcessor',
      classId: 'c3831ec8-d8d5-4f93-8a22-f9bfae07327f',
      extension: '.epf',
    },
    {
      kind: 'ExternalReport' as const,
      name: 'NewReport',
      classId: 'e41aff26-25cf-4bb6-b6c1-3f478a75f374',
      extension: '.erf',
    },
  ]) {
    test(`creates an empty ${scenario.extension} project with unique platform identifiers`, async () => {
      const result = await service.create({
        workspaceRoot,
        name: scenario.name,
        kind: scenario.kind,
        language: 'ru',
        synonym: 'Объект & <новый>',
      });

      assert.strictEqual(result.kind, scenario.kind);
      assert.strictEqual(path.basename(result.projectDirectory), `${scenario.name}_src`);
      assert.ok(fs.existsSync(path.join(result.projectDirectory, `${scenario.name}.xml`)));
      assert.strictEqual(result.rootXmlPath, path.join(result.projectDirectory, `${scenario.name}.xml`));
      assert.deepStrictEqual(fs.readdirSync(path.join(result.projectDirectory, scenario.name)), []);

      const xml = fs.readFileSync(result.rootXmlPath, 'utf8');
      assert.ok(xml.includes(`<${scenario.kind} uuid="`));
      assert.ok(xml.includes(`<xr:ClassId>${scenario.classId}</xr:ClassId>`));
      assert.ok(xml.includes(`<Name>${scenario.name}</Name>`));
      assert.ok(xml.includes('<v8:content>Объект &amp; &lt;новый&gt;</v8:content>'));
      assert.ok(xml.includes('<ChildObjects/>'));
      const identifiers = [...xml.matchAll(/(?:uuid="|<xr:(?:ObjectId|TypeId|ValueId)>)([0-9a-f-]{36})/giu)]
        .map((match) => match[1].toLowerCase());
      assert.strictEqual(identifiers.length, 4);
      assert.strictEqual(new Set(identifiers).size, 4);
    });
  }

  test('rejects an existing destination without changing its contents', async () => {
    const destination = path.join(workspaceRoot, 'Existing_src');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'keep.txt'), 'keep');

    await assert.rejects(
      service.create({
        workspaceRoot,
        name: 'Existing',
        kind: 'ExternalDataProcessor',
        language: 'en',
      }),
      /уже существует/u
    );
    assert.strictEqual(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'keep');
  });

  test('rejects names that are not 1C identifiers before creating a project', async () => {
    await assert.rejects(
      service.create({
        workspaceRoot,
        name: '../Escaped',
        kind: 'ExternalDataProcessor',
        language: 'ru',
      }),
      /идентификатором 1С/u
    );
    assert.deepStrictEqual(fs.readdirSync(workspaceRoot), []);
  });

  for (const version of ['2.17', '2.18', '2.19', '2.20', '2.21']) {
    test(`exports an embedded data processor with its tree and rewrites self references for ${version}`, async () => {
      const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'DataProcessors');
      const objectDirectory = path.join(sourceDirectory, 'Processor');
      const destinationParent = path.join(workspaceRoot, 'external');
      const destinationDirectory = path.join(destinationParent, 'Processor_src');
      fs.mkdirSync(objectDirectory, { recursive: true });
      fs.mkdirSync(destinationParent);
      fs.mkdirSync(path.join(objectDirectory, 'Forms', 'Main', 'Ext'), { recursive: true });
      fs.mkdirSync(path.join(objectDirectory, 'Forms', 'Main', 'Ext', 'Form'), { recursive: true });
      fs.mkdirSync(path.join(objectDirectory, 'Templates', 'Layout', 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, 'Processor.xml'), embeddedObjectXml(version), 'utf8');
      fs.writeFileSync(
        path.join(objectDirectory, 'Forms', 'Main.xml'),
        '<MetaDataObject><Form uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Main</Name></Properties></Form></MetaDataObject>',
        'utf8'
      );
      fs.writeFileSync(
        path.join(objectDirectory, 'Templates', 'Layout.xml'),
        '<MetaDataObject><Template uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Layout</Name></Properties></Template></MetaDataObject>',
        'utf8'
      );
      const formXmlPath = path.join(objectDirectory, 'Forms', 'Main', 'Ext', 'Form.xml');
      const formXml = '<Form><Attributes><Attribute><Type><v8:Type>cfg:DataProcessorObject.Processor</v8:Type></Type></Attribute></Attributes></Form>';
      fs.writeFileSync(formXmlPath, formXml, 'utf8');
      fs.writeFileSync(path.join(objectDirectory, 'Templates', 'Layout', 'Ext', 'Template.xml'), '<Template>DataProcessor.Processor.Template.Layout</Template>', 'utf8');
      fs.writeFileSync(path.join(objectDirectory, 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl'), 'Функция ТипОбъекта()\n Возврат "DataProcessorObject.Processor";\nКонецФункции', 'utf8');
      fs.writeFileSync(path.join(objectDirectory, 'Templates', 'Layout', 'Ext', 'Template.html'), '<div>DataProcessor.Processor</div>', 'utf8');
      fs.writeFileSync(path.join(objectDirectory, 'Templates', 'Layout', 'Ext', 'Template.bin'), Buffer.from([0, 1, 255]));

      const result = await service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory,
      });

      assert.strictEqual(result.kind, 'ExternalDataProcessor');
      assert.strictEqual(path.basename(result.projectDirectory), 'Processor_src');
      assert.ok(fs.existsSync(result.projectDirectory));
      const rootXml = fs.readFileSync(result.rootXmlPath, 'utf8');
      assert.ok(rootXml.includes('<ExternalDataProcessor uuid='));
      assert.ok(rootXml.includes('<xr:ClassId>c3831ec8-d8d5-4f93-8a22-f9bfae07327f</xr:ClassId>'));
      assert.ok(rootXml.includes('name="ExternalDataProcessorObject.Processor"'));
      assert.ok(rootXml.includes('<DefaultForm>ExternalDataProcessor.Processor.Form.Main</DefaultForm>'));
      assert.ok(!rootXml.includes('DataProcessorManager.Processor'));
      assert.ok(!rootXml.includes('<UseStandardCommands>'));
      assert.ok(rootXml.includes('uuid="11111111-1111-4111-8111-111111111111"'));
      assert.strictEqual(
        fs.readFileSync(path.join(result.projectDirectory, 'Processor', 'Forms', 'Main', 'Ext', 'Form.xml'), 'utf8'),
        '<Form><Attributes><Attribute><Type><v8:Type>cfg:ExternalDataProcessorObject.Processor</v8:Type></Type></Attribute></Attributes></Form>'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(result.projectDirectory, 'Processor', 'Templates', 'Layout', 'Ext', 'Template.xml'), 'utf8'),
        '<Template>ExternalDataProcessor.Processor.Template.Layout</Template>'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(result.projectDirectory, 'Processor', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl'), 'utf8'),
        'Функция ТипОбъекта()\n Возврат "DataProcessorObject.Processor";\nКонецФункции'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(result.projectDirectory, 'Processor', 'Templates', 'Layout', 'Ext', 'Template.html'), 'utf8'),
        '<div>DataProcessor.Processor</div>'
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(result.projectDirectory, 'Processor', 'Templates', 'Layout', 'Ext', 'Template.bin')),
        Buffer.from([0, 1, 255])
      );
    });
  }

  test('exports an embedded report using ERF properties and report type references', async () => {
    const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'Reports');
    const objectDirectory = path.join(sourceDirectory, 'MonthlyReport');
    const destinationParent = path.join(workspaceRoot, 'external');
    const destinationDirectory = path.join(destinationParent, 'MonthlyReport_src');
    fs.mkdirSync(path.join(objectDirectory, 'Forms', 'Main', 'Ext'), { recursive: true });
    fs.mkdirSync(destinationParent);
    fs.writeFileSync(path.join(sourceDirectory, 'MonthlyReport.xml'), embeddedReportXml(), 'utf8');
    fs.mkdirSync(path.join(objectDirectory, 'Templates'), { recursive: true });
    fs.writeFileSync(
      path.join(objectDirectory, 'Forms', 'Main.xml'),
      '<MetaDataObject><Form uuid="44444444-4444-4444-8444-444444444444"><Properties><Name>Main</Name></Properties></Form></MetaDataObject>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(objectDirectory, 'Templates', 'MainSchema.xml'),
      '<MetaDataObject><Template uuid="55555555-5555-4555-8555-555555555555"><Properties><Name>MainSchema</Name></Properties></Template></MetaDataObject>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(objectDirectory, 'Forms', 'Main', 'Ext', 'Form.xml'),
      '<Form><Attributes><Attribute><Type><v8:Type>cfg:ReportObject.MonthlyReport</v8:Type></Type></Attribute></Attributes></Form>',
      'utf8'
    );

    const result = await service.exportEmbedded({
      workspaceRoot,
      sourceRootXmlPath: path.join(sourceDirectory, 'MonthlyReport.xml'),
      destinationDirectory,
    });

    assert.strictEqual(result.kind, 'ExternalReport');
    const rootXml = fs.readFileSync(result.rootXmlPath, 'utf8');
    assert.ok(rootXml.includes('<ExternalReport uuid='));
    assert.ok(rootXml.includes('<xr:ClassId>e41aff26-25cf-4bb6-b6c1-3f478a75f374</xr:ClassId>'));
    assert.ok(rootXml.includes('<MainDataCompositionSchema>ExternalReport.MonthlyReport.Template.MainSchema</MainDataCompositionSchema>'));
    assert.ok(rootXml.includes('name="ExternalReportObject.MonthlyReport"'));
    assert.ok(!rootXml.includes('<UseStandardCommands>'));
    assert.strictEqual(
      fs.readFileSync(path.join(result.projectDirectory, 'MonthlyReport', 'Forms', 'Main', 'Ext', 'Form.xml'), 'utf8'),
      '<Form><Attributes><Attribute><Type><v8:Type>cfg:ExternalReportObject.MonthlyReport</v8:Type></Type></Attribute></Attributes></Form>'
    );
  });

  test('rejects declared Form and Template children when their sibling metadata XML is missing', async () => {
    const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'DataProcessors');
    const objectDirectory = path.join(sourceDirectory, 'Processor');
    const destinationParent = path.join(workspaceRoot, 'external');
    fs.mkdirSync(path.join(objectDirectory, 'Forms'), { recursive: true });
    fs.mkdirSync(path.join(objectDirectory, 'Templates'), { recursive: true });
    fs.mkdirSync(destinationParent);
    fs.writeFileSync(path.join(sourceDirectory, 'Processor.xml'), embeddedObjectXml('2.20'), 'utf8');
    fs.writeFileSync(path.join(objectDirectory, 'Templates', 'Layout.xml'), '<MetaDataObject/>', 'utf8');

    await assert.rejects(
      service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory: path.join(destinationParent, 'MissingForm_src'),
      }),
      /Не найден обязательный XML формы "Main"/u
    );
    assert.strictEqual(fs.existsSync(path.join(destinationParent, 'MissingForm_src')), false);

    fs.writeFileSync(path.join(objectDirectory, 'Forms', 'Main.xml'), '<MetaDataObject/>', 'utf8');
    fs.unlinkSync(path.join(objectDirectory, 'Templates', 'Layout.xml'));
    await assert.rejects(
      service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory: path.join(destinationParent, 'MissingTemplate_src'),
      }),
      /Не найден обязательный XML макета "Layout"/u
    );
    assert.strictEqual(fs.existsSync(path.join(destinationParent, 'MissingTemplate_src')), false);
    assert.deepStrictEqual(fs.readdirSync(destinationParent), []);
  });

  test('rejects unsupported Designer versions and leaves no partial destination', async () => {
    const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'DataProcessors');
    const destinationParent = path.join(workspaceRoot, 'external');
    const destinationDirectory = path.join(destinationParent, 'Unsupported_src');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(destinationParent);
    fs.writeFileSync(path.join(sourceDirectory, 'Processor.xml'), embeddedObjectXml('2.22'), 'utf8');

    await assert.rejects(
      service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory,
      }),
      /не поддерживается/u
    );
    assert.strictEqual(fs.existsSync(destinationDirectory), false);
  });

  test('rejects configuration commands that external processors cannot represent before publishing', async () => {
    const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'DataProcessors');
    const destinationParent = path.join(workspaceRoot, 'external');
    const destinationDirectory = path.join(destinationParent, 'Processor_src');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(destinationParent);
    const xml = embeddedObjectXml('2.20').replace(
      '<ChildObjects>',
      '<ChildObjects><Command>OpenForm</Command>'
    );
    fs.writeFileSync(path.join(sourceDirectory, 'Processor.xml'), xml, 'utf8');

    await assert.rejects(
      service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory,
      }),
      /Команды конфигурации нельзя перенести во внешний объект/u
    );
    assert.strictEqual(fs.existsSync(destinationDirectory), false);
    assert.deepStrictEqual(fs.readdirSync(destinationParent), []);
  });

  test('rejects unknown root child metadata before publishing', async () => {
    const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'DataProcessors');
    const destinationParent = path.join(workspaceRoot, 'external');
    const destinationDirectory = path.join(destinationParent, 'Processor_src');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(destinationParent);
    const xml = embeddedObjectXml('2.20').replace(
      '<ChildObjects>',
      '<ChildObjects><UnknownChild/>'
    );
    fs.writeFileSync(path.join(sourceDirectory, 'Processor.xml'), xml, 'utf8');

    await assert.rejects(
      service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory,
      }),
      /Дочерний объект UnknownChild нельзя перенести во внешний объект EPF\/ERF/u
    );
    assert.strictEqual(fs.existsSync(destinationDirectory), false);
    assert.deepStrictEqual(fs.readdirSync(destinationParent), []);
  });

  test('rejects a root Commands subtree even when the metadata root omits Command children', async () => {
    const sourceDirectory = path.join(workspaceRoot, 'Configuration', 'DataProcessors');
    const objectDirectory = path.join(sourceDirectory, 'Processor');
    const destinationParent = path.join(workspaceRoot, 'external');
    const destinationDirectory = path.join(destinationParent, 'Processor_src');
    fs.mkdirSync(path.join(objectDirectory, 'Commands', 'OpenForm', 'Ext'), { recursive: true });
    fs.mkdirSync(destinationParent);
    fs.writeFileSync(path.join(sourceDirectory, 'Processor.xml'), embeddedObjectXml('2.20'), 'utf8');
    fs.writeFileSync(path.join(objectDirectory, 'Commands', 'OpenForm', 'Ext', 'Command.xml'), '<Command/>', 'utf8');

    await assert.rejects(
      service.exportEmbedded({
        workspaceRoot,
        sourceRootXmlPath: path.join(sourceDirectory, 'Processor.xml'),
        destinationDirectory,
      }),
      /Каталог Commands содержит команды конфигурации/u
    );
    assert.strictEqual(fs.existsSync(destinationDirectory), false);
    assert.deepStrictEqual(fs.readdirSync(destinationParent), []);
  });
});

function embeddedObjectXml(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="${version}">
  <DataProcessor uuid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">
    <InternalInfo>
      <xr:GeneratedType name="DataProcessorObject.Processor" category="Object"><xr:TypeId>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab</xr:TypeId><xr:ValueId>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac</xr:ValueId></xr:GeneratedType>
      <xr:GeneratedType name="DataProcessorManager.Processor" category="Manager"><xr:TypeId>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad</xr:TypeId><xr:ValueId>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae</xr:ValueId></xr:GeneratedType>
    </InternalInfo>
    <Properties>
      <Name>Processor</Name>
      <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Processor</v8:content></v8:item></Synonym>
      <Comment/>
      <UseStandardCommands>true</UseStandardCommands>
      <DefaultForm>DataProcessor.Processor.Form.Main</DefaultForm>
      <AuxiliaryForm/>
      <IncludeHelpInContents>false</IncludeHelpInContents>
      <ExtendedPresentation/>
      <Explanation/>
    </Properties>
    <ChildObjects>
      <Attribute uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Value</Name></Properties></Attribute>
      <Form>Main</Form>
      <Template>Layout</Template>
    </ChildObjects>
  </DataProcessor>
</MetaDataObject>`;
}

function embeddedReportXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20">
  <Report uuid="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">
    <InternalInfo>
      <xr:GeneratedType name="ReportObject.MonthlyReport" category="Object"><xr:TypeId>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc</xr:TypeId><xr:ValueId>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd</xr:ValueId></xr:GeneratedType>
      <xr:GeneratedType name="ReportManager.MonthlyReport" category="Manager"><xr:TypeId>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe</xr:TypeId><xr:ValueId>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbf</xr:ValueId></xr:GeneratedType>
    </InternalInfo>
    <Properties>
      <Name>MonthlyReport</Name><Synonym/><Comment/><UseStandardCommands>true</UseStandardCommands>
      <DefaultForm>Report.MonthlyReport.Form.Main</DefaultForm><AuxiliaryForm/>
      <IncludeHelpInContents>false</IncludeHelpInContents><ExtendedPresentation/><Explanation/>
      <MainDataCompositionSchema>Report.MonthlyReport.Template.MainSchema</MainDataCompositionSchema>
      <DefaultSettingsForm/><AuxiliarySettingsForm/><DefaultVariantForm/><SettingsStorage/><VariantsStorage/>
    </Properties>
    <ChildObjects><Form>Main</Form><Template>MainSchema</Template></ChildObjects>
  </Report>
</MetaDataObject>`;
}
