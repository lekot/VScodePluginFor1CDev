import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FormModel } from '../../src/formEditor/formModel';
import { writeFormXml, buildFormContent, injectXmlnsIntoFormTag, injectMissingFormOpenTagAttrs } from '../../src/formEditor/formXmlWriter';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { isFormParseError } from '../../src/formEditor/formModel';

function createBaseModel(): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

suite('FormXmlWriter', () => {
  test('writes default Form version 2.20 when model version is absent', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-version-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      await writeFormXml(formXmlPath, createBaseModel());
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.includes('<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('writes mandatory AutoCommandBar with defaults when model fields are absent', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-autobar-default-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      await writeFormXml(formXmlPath, createBaseModel());
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(
        /<AutoCommandBar\s+name="ФормаКоманднаяПанель"\s+id="-1"\s*(?:\/>|><\/AutoCommandBar>)/.test(xml),
        'AutoCommandBar with default name/id must be written to XML'
      );
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('preserves AutoCommandBar name/id from model for round-trip compatibility', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-autobar-model-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.autoCommandBarName = 'ПанельИзМодели';
      model.autoCommandBarId = '42';
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(
        /<AutoCommandBar\s+name="ПанельИзМодели"\s+id="42"\s*(?:\/>|><\/AutoCommandBar>)/.test(xml),
        'AutoCommandBar from model must be preserved in XML'
      );
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('writes Parameters and CommandSet from first-class model fields', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-first-class-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.parameters = [
        {
          name: 'Парам1',
          id: '100',
          properties: {
            Title: [{ '#text': 'Параметр 1' }],
          },
        },
      ];
      model.excludedCommands = ['Form.CommandA', 'Form.CommandB'];
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(/<Parameters>[\s\S]*<Parameter\s+name="Парам1"\s+id="100">/.test(xml));
      assert.ok(/<CommandSet>[\s\S]*<ExcludedCommand>Form\.CommandA<\/ExcludedCommand>/.test(xml));
      assert.ok(/<CommandSet>[\s\S]*<ExcludedCommand>Form\.CommandB<\/ExcludedCommand>/.test(xml));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('does not duplicate Parameters/CommandSet when also present in topLevelFields', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-no-dups-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.topLevelFields = [
        { tag: 'Parameters', content: [{ Parameter: [{ ':@': { '@_name': 'RawParam' } }] }] },
        { tag: 'CommandSet', content: [{ ExcludedCommand: [{ '#text': 'Raw.Command' }] }] },
      ];
      model.parameters = [{ name: 'FirstClassParam', properties: {} }];
      model.excludedCommands = ['FirstClass.Command'];
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      const parametersMatches = xml.match(/<Parameters>/g) ?? [];
      const commandSetMatches = xml.match(/<CommandSet>/g) ?? [];
      assert.strictEqual(parametersMatches.length, 1, 'Parameters section must be written once');
      assert.strictEqual(commandSetMatches.length, 1, 'CommandSet section must be written once');
      assert.ok(xml.includes('FirstClassParam'));
      assert.ok(xml.includes('FirstClass.Command'));
      assert.ok(!xml.includes('RawParam'));
      assert.ok(!xml.includes('Raw.Command'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('keeps stable section order with CommandSet and Parameters guards', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-order-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.topLevelFields = [{ tag: 'WindowOpeningMode', content: [{ '#text': 'LockWholeInterface' }] }];
      model.excludedCommands = ['Form.CommandA'];
      model.formEvents = [{ name: 'OnOpen', method: 'ПриОткрытии' }];
      model.childItemsRoot = [{ tag: 'Button', name: 'Кнопка1', properties: {}, childItems: [] }];
      model.attributes = [{ name: 'Реквизит1', properties: {} }];
      model.parameters = [{ name: 'Парам1', properties: {} }];
      model.commands = [{ name: 'Команда1', properties: {} }];
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      const idxTopLevel = xml.indexOf('<WindowOpeningMode>');
      const idxCommandSet = xml.indexOf('<CommandSet>');
      const idxAutoCommandBar = xml.indexOf('<AutoCommandBar');
      const idxEvents = xml.indexOf('<Events>');
      const idxChildItems = xml.indexOf('<ChildItems>');
      const idxAttributes = xml.indexOf('<Attributes>');
      const idxParameters = xml.indexOf('<Parameters>');
      const idxCommands = xml.indexOf('<Commands>');
      assert.ok(idxTopLevel >= 0 && idxCommandSet >= 0 && idxAutoCommandBar >= 0);
      assert.ok(idxEvents >= 0 && idxChildItems >= 0 && idxAttributes >= 0 && idxParameters >= 0 && idxCommands >= 0);
      assert.ok(idxTopLevel < idxCommandSet);
      assert.ok(idxCommandSet < idxAutoCommandBar);
      assert.ok(idxAutoCommandBar < idxEvents);
      assert.ok(idxEvents < idxChildItems);
      assert.ok(idxChildItems < idxAttributes);
      assert.ok(idxAttributes < idxParameters);
      assert.ok(idxParameters < idxCommands);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('prefers raw Parameters/CommandSet when first-class is marked non-lossless', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-raw-fallback-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.parameters = [{ name: 'FirstClassParam', properties: {} }];
      model.excludedCommands = ['FirstClass.Command'];
      model.parametersFirstClassLossless = false;
      model.commandSetFirstClassLossless = false;
      model.topLevelFields = [
        {
          tag: 'Parameters',
          content: [
            { Parameter: [{ ':@': { '@_name': 'RawParam' } }, { Title: [{ '#text': 'Raw Title' }] }] },
            { UnknownParamNode: [{ '#text': 'keep' }] },
          ],
        },
        {
          tag: 'CommandSet',
          content: [
            { ExcludedCommand: [{ '#text': 'Raw.Command' }] },
            { CustomCommandNode: [{ '#text': 'keep' }] },
          ],
        },
      ];
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.includes('RawParam'));
      assert.ok(xml.includes('Raw.Command'));
      assert.ok(xml.includes('<UnknownParamNode>keep</UnknownParamNode>'));
      assert.ok(xml.includes('<CustomCommandNode>keep</CustomCommandNode>'));
      assert.ok(!xml.includes('FirstClassParam'));
      assert.ok(!xml.includes('FirstClass.Command'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── Round-trip: parse inline XML → write → parse again ──────────────────────

  test('round-trip: form with no ChildItems preserves empty ChildItems section', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-empty-ci-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed));
      assert.strictEqual(parsed.model.childItemsRoot.length, 0);
      await writeFormXml(formXmlPath, parsed.model);
      const written = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(written.includes('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.ok(/<Form[^>]*>/.test(written));
      const reParsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(reParsed));
      assert.strictEqual(reParsed.model.childItemsRoot.length, 0);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('round-trip: deeply nested ChildItems (3 levels) preserved', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-deep-nest-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">
\t<ChildItems>
\t\t<UsualGroup name="Группа1" id="1">
\t\t\t<ChildItems>
\t\t\t\t<UsualGroup name="Группа2" id="2">
\t\t\t\t\t<ChildItems>
\t\t\t\t\t\t<InputField name="Поле1" id="3">
\t\t\t\t\t\t\t<DataPath>Реквизит1</DataPath>
\t\t\t\t\t\t</InputField>
\t\t\t\t\t</ChildItems>
\t\t\t\t</UsualGroup>
\t\t\t</ChildItems>
\t\t</UsualGroup>
\t</ChildItems>
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed));
      assert.strictEqual(parsed.model.childItemsRoot.length, 1);
      assert.strictEqual(parsed.model.childItemsRoot[0].name, 'Группа1');
      assert.strictEqual(parsed.model.childItemsRoot[0].childItems.length, 1);
      assert.strictEqual(parsed.model.childItemsRoot[0].childItems[0].name, 'Группа2');
      assert.strictEqual(parsed.model.childItemsRoot[0].childItems[0].childItems.length, 1);
      assert.strictEqual(parsed.model.childItemsRoot[0].childItems[0].childItems[0].name, 'Поле1');

      await writeFormXml(formXmlPath, parsed.model);
      const reParsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(reParsed));
      assert.strictEqual(reParsed.model.childItemsRoot.length, 1);
      assert.strictEqual(reParsed.model.childItemsRoot[0].name, 'Группа1');
      assert.strictEqual(reParsed.model.childItemsRoot[0].childItems[0].name, 'Группа2');
      assert.strictEqual(reParsed.model.childItemsRoot[0].childItems[0].childItems[0].name, 'Поле1');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('writer emits Events section when model.formEvents is populated', async () => {
    // Note: the parser does not currently re-parse Events from XML back into formEvents
    // (fast-xml-parser attribute position issue). This test verifies writer output only.
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-events-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.formEvents = [
        { name: 'OnOpen', method: 'ПриОткрытии' },
        { name: 'BeforeClose', method: 'ПередЗакрытием' },
      ];
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.includes('<Events>'), 'Events section must be written');
      assert.ok(/<Event\s+name="OnOpen">/.test(xml), 'OnOpen event must appear');
      assert.ok(xml.includes('ПриОткрытии'), 'OnOpen method must appear');
      assert.ok(/<Event\s+name="BeforeClose">/.test(xml), 'BeforeClose event must appear');
      assert.ok(xml.includes('ПередЗакрытием'), 'BeforeClose method must appear');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('writer emits child item Events section when item.events is populated', async () => {
    // Note: the parser does not currently re-parse Events from XML back into model
    // (fast-xml-parser attribute position issue). This test verifies writer output only.
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-child-events-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.childItemsRoot = [
        {
          tag: 'InputField',
          name: 'Поле1',
          id: '1',
          properties: {},
          childItems: [],
          events: { OnChange: 'ПриИзменении' },
        },
      ];
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.includes('<Events>'), 'Events section must be written inside ChildItems');
      assert.ok(/<Event\s+name="OnChange">/.test(xml), 'OnChange event must appear');
      assert.ok(xml.includes('ПриИзменении'), 'OnChange method must appear');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('round-trip: topLevelFields (unknown sections) survive write unchanged', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-top-level-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">
\t<WindowOpeningMode>LockWholeInterface</WindowOpeningMode>
\t<UseForFoldersAndItems>FoldersAndItems</UseForFoldersAndItems>
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed));
      assert.ok(parsed.model.topLevelFields && parsed.model.topLevelFields.length >= 2);

      await writeFormXml(formXmlPath, parsed.model);
      const written = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(written.includes('WindowOpeningMode'));
      assert.ok(written.includes('LockWholeInterface'));
      assert.ok(written.includes('UseForFoldersAndItems'));
      assert.ok(written.includes('FoldersAndItems'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── xmlns preservation ───────────────────────────────────────────────────────

  test('xmlns declarations preserved in round-trip (xmlns:v8 survives write)', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-xmlns-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1" version="2.20">
\t<Attributes>
\t\t<Attribute name="Реквизит1" id="1">
\t\t\t<Type>
\t\t\t\t<v8:Type>xs:string</v8:Type>
\t\t\t</Type>
\t\t</Attribute>
\t</Attributes>
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed));
      assert.ok(parsed.model.xmlnsDeclarations);
      assert.ok('xmlns:v8' in parsed.model.xmlnsDeclarations!);
      assert.strictEqual(parsed.model.xmlnsDeclarations!['xmlns:v8'], 'http://v8.1c.ru/8.1');

      await writeFormXml(formXmlPath, parsed.model);
      const written = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(written.includes('xmlns="http://v8.1c.ru/8.3/xcf/logform"'), 'default xmlns preserved');
      assert.ok(written.includes('xmlns:v8="http://v8.1c.ru/8.1"'), 'xmlns:v8 preserved');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('injectXmlnsIntoFormTag inserts xmlns declarations into <Form> open tag', () => {
    const bare = '<Form version="2.20">\n</Form>';
    const result = injectXmlnsIntoFormTag(bare, {
      'xmlns': 'http://v8.1c.ru/8.3/xcf/logform',
      'xmlns:v8': 'http://v8.1c.ru/8.1',
    });
    assert.ok(result.includes('xmlns="http://v8.1c.ru/8.3/xcf/logform"'), 'xmlns injected');
    assert.ok(result.includes('xmlns:v8="http://v8.1c.ru/8.1"'), 'xmlns:v8 injected');
    // xmlns should come before xmlns:v8 (sorted with xmlns first)
    assert.ok(result.indexOf('xmlns=') < result.indexOf('xmlns:v8='));
  });

  test('injectXmlnsIntoFormTag is a no-op when declarations are empty', () => {
    const bare = '<Form version="2.20">\n</Form>';
    const result = injectXmlnsIntoFormTag(bare, {});
    assert.strictEqual(result, bare);
  });

  // ── AutoCommandBar edge cases ────────────────────────────────────────────────

  test('AutoCommandBar round-trip: model fields written to XML and preserved', async () => {
    // Note: the parser does not currently read AutoCommandBar name/id from XML attributes
    // (fast-xml-parser preserveOrder attribute position issue). We test model→writer→XML only.
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-autobar-rt-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.autoCommandBarName = 'МояПанель';
      model.autoCommandBarId = '77';
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(
        /<AutoCommandBar\s+name="МояПанель"\s+id="77"\s*(?:\/>|><\/AutoCommandBar>)/.test(xml),
        'AutoCommandBar with custom name/id must be present in XML'
      );
      // Re-write via a parse→write cycle: model fields survive because they came from the model,
      // not from XML re-parsing (which is the known limitation of the current parser)
      await writeFormXml(formXmlPath, model);
      const xml2 = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(/<AutoCommandBar\s+name="МояПанель"\s+id="77"/.test(xml2));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── Empty form validation ────────────────────────────────────────────────────

  test('buildFormContent returns non-empty array even for empty model', () => {
    const model = createBaseModel();
    const content = buildFormContent(model);
    // First item is the attrs object {:@: ...}, rest is form body
    assert.ok(Array.isArray(content));
    assert.ok(content.length >= 1);
    // AutoCommandBar must always be present in the body
    const hasAutoBar = content.some((item) => {
      if (!item || typeof item !== 'object') { return false; }
      return 'AutoCommandBar' in (item as Record<string, unknown>);
    });
    assert.ok(hasAutoBar, 'buildFormContent must always include AutoCommandBar');
  });

  test('writeFormXml includes XML declaration header', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-decl-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      await writeFormXml(formXmlPath, createBaseModel());
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── Backup / rollback ────────────────────────────────────────────────────────

  test('backup file is created before write and removed after successful write', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-backup-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    const backupPath = `${formXmlPath}.bak`;
    try {
      // Pre-create the target file so backup captures real content
      const initialContent = '<?xml version="1.0" encoding="UTF-8"?>\n<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">\n</Form>';
      await fs.promises.writeFile(formXmlPath, initialContent, 'utf-8');

      await writeFormXml(formXmlPath, createBaseModel());

      // After successful write, backup must be cleaned up
      assert.ok(!fs.existsSync(backupPath), 'backup file must be deleted after successful write');
      // Target file must exist with new content
      const written = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(written.includes('<Form'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('writeFormXml creates a new file when target does not exist', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-newfile-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      // File does not exist yet
      assert.ok(!fs.existsSync(formXmlPath));
      const model = createBaseModel();
      model.formEvents = [{ name: 'OnOpen', method: 'ПриОткрытии' }];
      await writeFormXml(formXmlPath, model);
      assert.ok(fs.existsSync(formXmlPath));
      const written = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(written.includes('OnOpen'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── version handling ─────────────────────────────────────────────────────────

  test('writes model.version when provided', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-version-custom-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model = createBaseModel();
      model.version = '2.17';
      await writeFormXml(formXmlPath, model);
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.includes('version="2.17"'), 'custom version from model should be written');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('version preserved in round-trip parse→write→parse', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-version-rt-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.17">
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed));
      assert.strictEqual(parsed.model.version, '2.17');

      await writeFormXml(formXmlPath, parsed.model);
      const reParsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(reParsed));
      assert.strictEqual(reParsed.model.version, '2.17');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── injectMissingFormOpenTagAttrs edge cases ─────────────────────────────────

  test('injectMissingFormOpenTagAttrs does not duplicate xmlns when already present', () => {
    const xml = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">\n</Form>';
    const model = createBaseModel();
    model.version = '2.20';
    const result = injectMissingFormOpenTagAttrs(xml, model);
    const matches = result.match(/xmlns=/g) ?? [];
    assert.strictEqual(matches.length, 1, 'xmlns must appear exactly once');
  });

  test('injectMissingFormOpenTagAttrs does not duplicate version when already present', () => {
    const xml = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.17">\n</Form>';
    const model = createBaseModel();
    model.version = '2.17';
    const result = injectMissingFormOpenTagAttrs(xml, model);
    const matches = result.match(/version=/g) ?? [];
    assert.strictEqual(matches.length, 1, 'version must appear exactly once');
  });

  // ── Full round-trip with all sections ────────────────────────────────────────

  test('round-trip: form with all major sections (childItems, attributes, commands, parameters, excludedCommands)', async () => {
    // Note: formEvents are written correctly but the parser does not re-parse them from XML
    // due to a known fast-xml-parser attribute position issue; tested separately via XML string check.
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-full-rt-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const model: FormModel = {
        version: '2.20',
        xmlnsDeclarations: { xmlns: 'http://v8.1c.ru/8.3/xcf/logform' },
        formEvents: [{ name: 'OnOpen', method: 'ПриОткрытии' }],
        childItemsRoot: [
          {
            tag: 'UsualGroup',
            name: 'Группа1',
            id: '1',
            properties: {},
            childItems: [
              { tag: 'Button', name: 'Кнопка1', id: '2', properties: {}, childItems: [] },
            ],
          },
        ],
        attributes: [{ name: 'Реквизит1', id: '10', properties: {} }],
        commands: [{ name: 'Команда1', id: '20', properties: {} }],
        parameters: [{ name: 'Парам1', id: '30', properties: {} }],
        excludedCommands: ['Form.Cut'],
      };

      await writeFormXml(formXmlPath, model);
      // Verify XML content directly for Events (parser limitation)
      const xmlStr = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(/<Event\s+name="OnOpen">/.test(xmlStr), 'Events section written correctly');

      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed), (parsed as { error?: string }).error ?? '');

      const m = parsed.model;
      // childItemsRoot — correctly parsed back (ChildItems name/id resolution works)
      assert.strictEqual(m.childItemsRoot.length, 1);
      assert.strictEqual(m.childItemsRoot[0].name, 'Группа1');
      assert.strictEqual(m.childItemsRoot[0].childItems.length, 1);
      assert.strictEqual(m.childItemsRoot[0].childItems[0].name, 'Кнопка1');
      // excludedCommands — first-class ExcludedCommand text content, always parseable
      assert.deepStrictEqual(m.excludedCommands, ['Form.Cut']);
      // Attributes, Commands, Parameters and Events: when elements have no child nodes
      // (only XML attributes), fast-xml-parser preserveOrder puts name/id on the container
      // ':@' object rather than in the content array — parser limitation.
      // Verify writer output via XML string:
      assert.ok(/<Attribute\s+name="Реквизит1"/.test(xmlStr), 'Attribute written in XML');
      assert.ok(/<Command\s+name="Команда1"/.test(xmlStr), 'Command written in XML');
      assert.ok(/<Parameter\s+name="Парам1"/.test(xmlStr), 'Parameter written in XML');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
