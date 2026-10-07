import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateFilterCriterionXml,
  collectAvailableFilterTypes,
  collectAvailableFilterCandidates,
  planCreateFilterCriterion,
  type FilterCriterionWizardParams,
  type AvailableFilterType,
  type AvailableFilterCandidate,
} from '../../src/services/filterCriterionWizardService';
import { XmlParser } from '../../src/parsers/xmlParser';
import { readFilterCriterionContent } from '../../src/services/filterCriterionContentFileUpdater';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

suite('FilterCriterionWizardService', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-filter-crit-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('generateFilterCriterionXml creates valid 1C Designer XML with InternalInfo and Content', () => {
    const params: FilterCriterionWizardParams = {
      name: 'УчастиеВСделках',
      synonym: 'Участие в сделках',
      comment: 'Тестовый критерий',
      types: ['cfg:CatalogRef.Партнеры', 'cfg:CatalogRef.КонтактныеЛица'],
      content: [
        'Catalog.СделкиСКлиентами.Attribute.Партнер',
        'Catalog.СделкиСКлиентами.TabularSection.Партнеры.Attribute.КонтактноеЛицо',
      ],
      useStandardCommands: true,
    };

    const xml = generateFilterCriterionXml(params, '2.20');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'must start with xml header');
    assert.ok(xml.includes('<MetaDataObject'), 'must have MetaDataObject root');
    assert.ok(xml.includes('version="2.20"'), 'must specify format version');

    const parsed = XmlParser.parseString(xml) as Record<string, any>;
    const root = parsed.MetaDataObject;
    assert.ok(root, 'root must be MetaDataObject');
    const fc = root.FilterCriterion;
    assert.ok(fc, 'FilterCriterion element must exist');
    assert.ok(fc['@_uuid'], 'FilterCriterion must have uuid attribute');

    // InternalInfo
    const internalInfo = fc.InternalInfo;
    assert.ok(internalInfo, 'InternalInfo must exist');
    const genTypes = Array.isArray(internalInfo['xr:GeneratedType'])
      ? internalInfo['xr:GeneratedType']
      : [internalInfo['xr:GeneratedType']];
    assert.strictEqual(genTypes.length, 2, 'must generate Manager and List types');

    const managerType = genTypes.find((g: any) => g['@_category'] === 'Manager');
    assert.ok(managerType, 'must have FilterCriterionManager');
    assert.strictEqual(managerType['@_name'], 'FilterCriterionManager.УчастиеВСделках');
    assert.ok(managerType['xr:TypeId'], 'Manager must have TypeId');
    assert.ok(managerType['xr:ValueId'], 'Manager must have ValueId');

    const listType = genTypes.find((g: any) => g['@_category'] === 'List');
    assert.ok(listType, 'must have FilterCriterionList');
    assert.strictEqual(listType['@_name'], 'FilterCriterionList.УчастиеВСделках');
    assert.ok(listType['xr:TypeId'], 'List must have TypeId');
    assert.ok(listType['xr:ValueId'], 'List must have ValueId');

    // Properties
    const props = fc.Properties;
    assert.ok(props, 'Properties must exist');
    assert.strictEqual(props.Name, 'УчастиеВСделках');
    assert.strictEqual(props.Comment, 'Тестовый критерий');
    assert.strictEqual(props.UseStandardCommands, 'true');

    // Type
    const typeObj = props.Type;
    assert.ok(typeObj, 'Type must exist');
    const typeList = Array.isArray(typeObj['v8:Type']) ? typeObj['v8:Type'] : [typeObj['v8:Type']];
    assert.deepStrictEqual(typeList, ['cfg:CatalogRef.Партнеры', 'cfg:CatalogRef.КонтактныеЛица']);

    // Content
    const contentObj = props.Content;
    assert.ok(contentObj, 'Content must exist');
    const itemList = Array.isArray(contentObj['xr:Item']) ? contentObj['xr:Item'] : [contentObj['xr:Item']];
    assert.strictEqual(itemList.length, 2);
    assert.strictEqual(itemList[0]['#text'], 'Catalog.СделкиСКлиентами.Attribute.Партнер');
    assert.strictEqual(itemList[0]['@_xsi:type'], 'xr:MDObjectRef');
    assert.strictEqual(itemList[1]['#text'], 'Catalog.СделкиСКлиентами.TabularSection.Партнеры.Attribute.КонтактноеЛицо');
  });

  test('generateFilterCriterionXml escapes special characters in name and synonym', () => {
    const params: FilterCriterionWizardParams = {
      name: 'Критерий_1',
      synonym: 'Тест & Проверка <Специальные>',
      comment: 'С кавычками "двойными" и \'одинарными\'',
      types: ['xs:string'],
      content: ['Catalog.Товары.Attribute.Код'],
    };

    const xml = generateFilterCriterionXml(params);
    assert.ok(xml.includes('Тест &amp; Проверка &lt;Специальные&gt;'));
    assert.ok(xml.includes('&quot;двойными&quot;'));
  });

  test('collectAvailableFilterTypes discovers reference types from configuration directory', async () => {
    // Create Catalogs and Documents in tmpDir
    const catDir = path.join(tmpDir, 'Catalogs');
    const docDir = path.join(tmpDir, 'Documents');
    await fs.promises.mkdir(catDir, { recursive: true });
    await fs.promises.mkdir(docDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(catDir, 'Контрагенты.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="1"><Properties><Name>Контрагенты</Name><Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Контрагенты</v8:content></v8:item></Synonym></Properties></Catalog></MetaDataObject>`
    );
    await fs.promises.writeFile(
      path.join(docDir, 'ЗаказКлиента.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Document uuid="2"><Properties><Name>ЗаказКлиента</Name><Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Заказ клиента</v8:content></v8:item></Synonym></Properties></Document></MetaDataObject>`
    );

    const types = await collectAvailableFilterTypes(tmpDir);
    const typeRefs = types.map((t: AvailableFilterType) => t.typeRef);
    assert.ok(typeRefs.includes('cfg:CatalogRef.Контрагенты'), 'must find CatalogRef.Контрагенты');
    assert.ok(typeRefs.includes('cfg:DocumentRef.ЗаказКлиента'), 'must find DocumentRef.ЗаказКлиента');
    assert.ok(typeRefs.includes('xs:string'), 'must include primitive xs:string');
    assert.ok(typeRefs.includes('xs:decimal'), 'must include primitive xs:decimal');
  });

  test('collectAvailableFilterCandidates discovers attributes and tabular section attributes matching types', async () => {
    const catDir = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(catDir, 'Договоры.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Catalog uuid="cat-1">
    <Properties>
      <Name>Договоры</Name>
      <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Договоры</v8:content></v8:item></Synonym>
    </Properties>
    <ChildObjects>
      <Attribute uuid="attr-1">
        <Properties>
          <Name>Партнер</Name>
          <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Партнер</v8:content></v8:item></Synonym>
          <Type>
            <v8:Type>cfg:CatalogRef.Партнеры</v8:Type>
          </Type>
        </Properties>
      </Attribute>
      <TabularSection uuid="ts-1">
        <Properties>
          <Name>Контакты</Name>
        </Properties>
        <ChildObjects>
          <Attribute uuid="ts-attr-1">
            <Properties>
              <Name>КонтактноеЛицо</Name>
              <Type>
                <v8:Type>cfg:CatalogRef.КонтактныеЛица</v8:Type>
              </Type>
            </Properties>
          </Attribute>
        </ChildObjects>
      </TabularSection>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`
    );

    // Candidates matching CatalogRef.Партнеры
    const candidates = await collectAvailableFilterCandidates(tmpDir, ['cfg:CatalogRef.Партнеры']);
    const refs = candidates.map((c: AvailableFilterCandidate) => c.ref);
    assert.ok(refs.includes('Catalog.Договоры.Attribute.Партнер'), 'must include matching attribute');
    assert.strictEqual(candidates.find((c: AvailableFilterCandidate) => c.ref === 'Catalog.Договоры.Attribute.Партнер')?.matchesSelectedType, true);
    assert.strictEqual(
      refs.includes('Catalog.Договоры.TabularSection.Контакты.Attribute.КонтактноеЛицо'),
      false,
      'must filter out incompatible attribute when specific types are selected'
    );

    // Candidates with both types
    const candidatesBoth = await collectAvailableFilterCandidates(tmpDir, [
      'cfg:CatalogRef.Партнеры',
      'cfg:CatalogRef.КонтактныеЛица',
    ]);
    const refsBoth = candidatesBoth.map((c: AvailableFilterCandidate) => c.ref);
    assert.ok(refsBoth.includes('Catalog.Договоры.Attribute.Партнер'));
    assert.ok(refsBoth.includes('Catalog.Договоры.TabularSection.Контакты.Attribute.КонтактноеЛицо'));
  });

  test('collectAvailableFilterCandidates returns empty array for completely incompatible type set', async () => {
    const catDir = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(catDir, 'Товары.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog uuid="cat-goods">
    <Properties><Name>Товары</Name></Properties>
    <ChildObjects>
      <Attribute uuid="attr-art">
        <Properties>
          <Name>Артикул</Name>
          <Type><v8:Type>xs:string</v8:Type></Type>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`
    );

    const candidates = await collectAvailableFilterCandidates(tmpDir, ['cfg:CatalogRef.Склады', 'xs:decimal']);
    assert.strictEqual(candidates.length, 0, 'must return empty array when all attributes are incompatible');
  });

  test('planCreateFilterCriterion throws error when content items have incompatible types', async () => {
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Configuration uuid="conf-1">
    <Properties><Name>ТестоваяКонфигурация</Name></Properties>
    <ChildObjects><Catalog>Товары</Catalog></ChildObjects>
  </Configuration>
</MetaDataObject>`;
    await fs.promises.writeFile(path.join(tmpDir, 'Configuration.xml'), configXml, 'utf-8');

    const catDir = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(catDir, 'Товары.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog uuid="cat-goods">
    <Properties><Name>Товары</Name></Properties>
    <ChildObjects>
      <Attribute uuid="attr-desc">
        <Properties>
          <Name>Описание</Name>
          <Type><v8:Type>xs:string</v8:Type></Type>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`
    );

    await assert.rejects(
      async () => {
        await planCreateFilterCriterion(tmpDir, {
          name: 'ПоСкладу',
          types: ['cfg:CatalogRef.Склады'],
          content: ['Catalog.Товары.Attribute.Описание'],
        });
      },
      /incompatible|несовместим/i
    );
  });

  test('planCreateFilterCriterion produces a complete valid mutation plan and creates the object', async () => {
    // Setup minimal configuration
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Configuration uuid="conf-1">
    <Properties>
      <Name>ТестоваяКонфигурация</Name>
    </Properties>
    <ChildObjects>
      <Catalog>Партнеры</Catalog>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;
    await fs.promises.writeFile(path.join(tmpDir, 'Configuration.xml'), configXml, 'utf-8');

    const params: FilterCriterionWizardParams = {
      name: 'ПоПартнеру',
      synonym: 'По партнеру',
      types: ['cfg:CatalogRef.Партнеры'],
      content: ['Catalog.Партнеры.Attribute.ГоловнойПартнер'],
    };

    const plan = await planCreateFilterCriterion(tmpDir, params);
    assert.strictEqual(plan.kind, 'filterCriterion.create');
    assert.ok(plan.steps.length >= 4, 'must have directory, file, child dir, and configuration update steps');

    // Execute steps manually to verify filesystem outcome
    for (const step of plan.steps) {
      if (step.type === 'ensureDirectory') {
        await fs.promises.mkdir(step.targetPath, { recursive: true });
      } else if (step.type === 'writeFile') {
        await fs.promises.writeFile(step.targetPath, step.content, 'utf-8');
      }
    }

    // Verify files created
    const createdXmlPath = path.join(tmpDir, 'FilterCriteria', 'ПоПартнеру.xml');
    assert.ok(fs.existsSync(createdXmlPath), 'FilterCriterion XML file must exist');

    const createdDirPath = path.join(tmpDir, 'FilterCriteria', 'ПоПартнеру');
    assert.ok(fs.existsSync(createdDirPath) && fs.statSync(createdDirPath).isDirectory(), 'Folder must exist');

    // Verify content readable by existing filter criterion content updater
    const contentResult = await readFilterCriterionContent(createdXmlPath);
    assert.deepStrictEqual(contentResult.refs, ['Catalog.Партнеры.Attribute.ГоловнойПартнер']);

    // Verify Configuration.xml has FilterCriterion registered
    const updatedConfigXml = await fs.promises.readFile(path.join(tmpDir, 'Configuration.xml'), 'utf-8');
    assert.ok(updatedConfigXml.includes('<FilterCriterion>ПоПартнеру</FilterCriterion>') ||
              updatedConfigXml.includes('<Item>ПоПартнеру</Item>'), 'Configuration.xml must register new FilterCriterion');
  });

  test('planCreateFilterCriterion throws error on invalid or duplicate name', async () => {
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Configuration uuid="conf-1"><Properties><Name>Conf</Name></Properties><ChildObjects/></Configuration>
</MetaDataObject>`;
    await fs.promises.writeFile(path.join(tmpDir, 'Configuration.xml'), configXml, 'utf-8');

    // Invalid 1C name
    await assert.rejects(
      async () => {
        await planCreateFilterCriterion(tmpDir, {
          name: '123_НеверноеИмя',
          types: ['xs:string'],
          content: ['Catalog.A.Attribute.B'],
        });
      },
      /начинаться с цифры|недопустимое имя|латиница/i
    );

    // Duplicate name
    const fcDir = path.join(tmpDir, 'FilterCriteria');
    await fs.promises.mkdir(fcDir, { recursive: true });
    await fs.promises.writeFile(path.join(fcDir, 'Существующий.xml'), '<dummy/>', 'utf-8');

    await assert.rejects(
      async () => {
        await planCreateFilterCriterion(tmpDir, {
          name: 'Существующий',
          types: ['xs:string'],
          content: ['Catalog.A.Attribute.B'],
        });
      },
      /уже существует|already exists/i
    );
  });

  test('generateFilterCriterionXml throws error when content is empty or contains only whitespace', () => {
    assert.throws(
      () => {
        generateFilterCriterionXml({
          name: 'ПустойКритерий',
          types: ['xs:string'],
          content: [],
        });
      },
      /content must contain at least one/i
    );

    assert.throws(
      () => {
        generateFilterCriterionXml({
          name: 'ПробельныйКритерий',
          types: ['xs:string'],
          content: ['   ', ''],
        });
      },
      /content must contain at least one/i
    );
  });

  test('planCreateFilterCriterion throws error when content is empty or contains only whitespace', async () => {
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Configuration uuid="conf-1"><Properties><Name>Conf</Name></Properties><ChildObjects/></Configuration>
</MetaDataObject>`;
    await fs.promises.writeFile(path.join(tmpDir, 'Configuration.xml'), configXml, 'utf-8');

    // Empty array
    await assert.rejects(
      async () => {
        await planCreateFilterCriterion(tmpDir, {
          name: 'БезСостава',
          types: ['xs:string'],
          content: [],
        });
      },
      /content must contain at least one/i
    );

    // Whitespace only elements
    await assert.rejects(
      async () => {
        await planCreateFilterCriterion(tmpDir, {
          name: 'СПробелами',
          types: ['xs:string'],
          content: ['   ', ' \t '],
        });
      },
      /content must contain at least one/i
    );
  });
});

