import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseFormXmlContent } from '../../src/formEditor/formXmlParser';
import { loadFormModel, saveFormModel } from '../../src/formEditor/formFileIo';
import { applyFormXmlEdits, diffFormModels } from '../../src/formEditor/formXmlTextEditor';

suite('Form XML source-preserving save', () => {
  test('keeps untouched line endings, comments, and attribute order when one scalar changes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'form-xml-splice-red-'));
    const filePath = path.join(tempRoot, 'Form.xml');
    const source = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">',
      '\t<!-- keep outer comment -->',
      '\t<!-- keep form comment -->',
      '\t<AutoCommandBar name="ФормаКоманднаяПанель" id="-1"/>',
      '\t<ChildItems>',
      '\t\t<UsualGroup name="Group" id="10">',
      '\t\t\t<ChildItems>',
      '\t\t\t\t<!-- keep node comment -->',
      '\t\t\t\t<InputField extra=\'keep-attribute-order\' name=\'Field\' id=\'11\'>',
      '\t\t\t\t\t<DataPath>Before&amp;After</DataPath>',
      '\t\t\t\t</InputField>',
      '\t\t\t</ChildItems>',
      '\t\t</UsualGroup>',
      '\t</ChildItems>',
      '</Form>',
    ].join('\r\n') + '\r\n';

    try {
      await fs.writeFile(filePath, Buffer.from(source, 'utf8'));
      const loaded = await loadFormModel(filePath);
      assert.ok(!('error' in loaded), 'source fixture loads');
      if ('error' in loaded) return;
      const field = loaded.model.childItemsRoot[0]?.childItems[0];
      assert.ok(field, 'nested input field exists');
      if (!field) return;
      field.properties.DataPath = 'Changed & safe';

      assert.ok(loaded.sourceSnapshot, 'raw source snapshot is captured');
      await saveFormModel(filePath, loaded.model, loaded.sourceSnapshot);
      const actual = await fs.readFile(filePath);
      const xml = actual.toString('utf8');

      assert.ok(xml.includes('\r\n'), 'CRLF remains');
      assert.ok(xml.includes('<!-- keep outer comment -->'), 'outer comment remains');
      assert.ok(xml.includes('<!-- keep form comment -->'), 'form comment remains');
      assert.ok(xml.includes('<!-- keep node comment -->'), 'node comment remains');
      assert.ok(xml.includes("<InputField extra='keep-attribute-order' name='Field' id='11'>"), 'untouched start tag stays byte-identical');
      assert.ok(xml.includes('<DataPath>Changed &amp; safe</DataPath>'), 'changed scalar is safely XML-escaped');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('loads and saves UTF-8 BOM documents without treating the BOM as part of the root tag', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'form-xml-bom-red-'));
    const filePath = path.join(tempRoot, 'Form.xml');
    const source = Buffer.from(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n<Form version="2.20"><ChildItems/></Form>\r\n',
      'utf8'
    );

    try {
      await fs.writeFile(filePath, source);
      const loaded = await loadFormModel(filePath);
      assert.ok(!('error' in loaded), 'BOM source loads');
      if ('error' in loaded) return;
      assert.strictEqual(loaded.model.version, '2.20', 'BOM does not hide the root version');
      await saveFormModel(filePath, loaded.model, loaded.sourceSnapshot);
      const actual = await fs.readFile(filePath);
      assert.ok(actual.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'UTF-8 BOM remains');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects external changes with a typed conflict and leaves them intact', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'form-xml-conflict-'));
    const filePath = path.join(tempRoot, 'Form.xml');
    const source = '<Form version="2.20"><ChildItems><InputField name="Field" id="1"><DataPath>Old</DataPath></InputField></ChildItems></Form>';
    try {
      await fs.writeFile(filePath, source, 'utf8');
      const loaded = await loadFormModel(filePath);
      assert.ok(!('error' in loaded), 'source loads');
      if ('error' in loaded) return;
      assert.ok(loaded.sourceSnapshot, 'snapshot is captured');
      loaded.model.childItemsRoot[0]!.properties.DataPath = 'UI edit';
      const external = source.replace('</Form>', '<!-- external edit -->\n</Form>');
      await fs.writeFile(filePath, external, 'utf8');

      await assert.rejects(
        saveFormModel(filePath, loaded.model, loaded.sourceSnapshot),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORM_XML_EXTERNAL_CHANGE',
      );
      assert.strictEqual(await fs.readFile(filePath, 'utf8'), external, 'external bytes are not overwritten');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('fails closed when an existing file is saved without its source snapshot', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'form-xml-missing-snapshot-'));
    const filePath = path.join(tempRoot, 'Form.xml');
    const source = '<Form version="2.20"><ChildItems><InputField name="Field" id="1"><DataPath>Old</DataPath></InputField></ChildItems></Form>';
    try {
      await fs.writeFile(filePath, source, 'utf8');
      const parsed = parseFormXmlContent(source);
      assert.ok(!('error' in parsed));
      if ('error' in parsed) return;
      parsed.model.childItemsRoot[0]!.properties.DataPath = 'Must not rewrite';
      await assert.rejects(saveFormModel(filePath, parsed.model), /передайте снимок из loadFormModel/);
      assert.strictEqual(await fs.readFile(filePath, 'utf8'), source, 'the old full rewrite path is never used for existing XML');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('uses the EDT configuration root for atomic saves and fails closed when it is missing', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'form-xml-edt-root-'));
    const unrootedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'form-xml-no-root-'));
    const edtFormPath = path.join(tempRoot, 'src', 'Catalogs', 'Goods', 'Forms', 'MainForm', 'Ext', 'Form.xml');
    const source = '<Form version="2.20"><ChildItems><InputField name="Field" id="1"><DataPath>Old</DataPath></InputField></ChildItems></Form>';
    try {
      await fs.mkdir(path.dirname(edtFormPath), { recursive: true });
      await fs.mkdir(path.join(tempRoot, 'src', 'Configuration'), { recursive: true });
      await fs.writeFile(path.join(tempRoot, 'src', 'Configuration', 'Configuration.mdo'), '<MetaDataObject/>');
      await fs.writeFile(edtFormPath, source, 'utf8');
      const loaded = await loadFormModel(edtFormPath);
      assert.ok(!('error' in loaded), 'EDT form loads');
      if ('error' in loaded) return;
      loaded.model.childItemsRoot[0]!.properties.DataPath = 'Saved';
      const nextSnapshot = await saveFormModel(edtFormPath, loaded.model, loaded.sourceSnapshot);
      assert.ok(nextSnapshot.sha256 !== loaded.sourceSnapshot?.sha256, 'successful save refreshes the snapshot hash');
      assert.ok((await fs.readFile(edtFormPath, 'utf8')).includes('<DataPath>Saved</DataPath>'));

      const missingRootPath = path.join(unrootedRoot, 'src', 'Catalogs', 'Goods', 'Forms', 'OtherForm', 'Ext', 'Form.xml');
      await fs.mkdir(path.dirname(missingRootPath), { recursive: true });
      await fs.writeFile(missingRootPath, source, 'utf8');
      const unrooted = await loadFormModel(missingRootPath);
      assert.ok(!('error' in unrooted), 'unrooted source still loads for read-only use');
      if ('error' in unrooted) return;
      unrooted.model.childItemsRoot[0]!.properties.DataPath = 'Must not write';
      await assert.rejects(
        saveFormModel(missingRootPath, unrooted.model, unrooted.sourceSnapshot),
        /корневая метка конфигурации/,
      );
      assert.strictEqual(await fs.readFile(missingRootPath, 'utf8'), source, 'unrooted managed path remains untouched');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
      await fs.rm(unrootedRoot, { recursive: true, force: true });
    }
  });

  test('splices scalar and complex properties while retaining the rest of the original source', () => {
    const source = '\uFEFF<?xml version="1.0"?>\r\n'
      + '<Form version="2.20">\r\n'
      + '\t<!-- preserve this comment -->\r\n'
      + '\t<ChildItems>\r\n'
      + '\t\t<InputField extra=\'keep\' name=\'Field\' id=\'1\'>\r\n'
      + '\t\t\t<DataPath>Old&amp;Path</DataPath>\r\n'
      + '\t\t\t<Title><v8:item><v8:lang>ru</v8:lang><v8:content>Старое</v8:content></v8:item></Title>\r\n'
      + '\t\t\t<ContextMenu name="FieldContextMenu" id="2"/>\r\n'
      + '\t\t</InputField>\r\n'
      + '\t</ChildItems>\r\n'
      + '</Form>\r\n';
    const output = applyFormXmlEdits(source, [{
      type: 'setProperties',
      element: { id: '1', name: 'Field' },
      properties: { DataPath: 'Changed & <safe>', Title: [{ 'v8:item': [
        { 'v8:lang': [{ '#text': 'ru' }] },
        { 'v8:content': [{ '#text': 'Новое & лучше' }] },
      ] }] },
    }]);

    assert.ok(output.startsWith('\uFEFF<?xml version="1.0"?>\r\n'), 'BOM and prolog stay byte-identical');
    assert.ok(output.includes('<!-- preserve this comment -->\r\n'), 'unrelated comment remains');
    assert.ok(output.includes("<InputField extra='keep' name='Field' id='1'>"), 'untouched start tag keeps quotes and attribute order');
    assert.ok(output.includes('<DataPath>Changed &amp; &lt;safe&gt;</DataPath>'), 'scalar text is escaped');
    assert.ok(output.includes('<v8:content>Новое &amp; лучше</v8:content>'), 'complex property nodes are serialized');
    assert.ok(output.includes('<ContextMenu name="FieldContextMenu" id="2"/>'), 'unmodified companion node remains');
    assert.ok(output.includes('\r\n'), 'CRLF remains');
    assert.ok(!output.replace(/\r\n/g, '').includes('\n'), 'no mixed line endings introduced');
  });

  test('diffs a cloned unchanged model to no edits and a property-only edit without moves', () => {
    const source = '<Form version="2.20">\n'
      + '\t<ChildItems>\n'
      + '\t\t<UsualGroup name="Group" id="1">\n'
      + '\t\t\t<ChildItems>\n'
      + '\t\t\t\t<InputField name="First" id="2"><DataPath>One</DataPath></InputField>\n'
      + '\t\t\t</ChildItems>\n'
      + '\t\t</UsualGroup>\n'
      + '\t\t<Button name="Second" id="3"><Title>Keep</Title></Button>\n'
      + '\t</ChildItems>\n'
      + '</Form>\n';
    const parsed = parseFormXmlContent(source);
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    const baseline = parsed.model;
    const unchanged = JSON.parse(JSON.stringify(baseline)) as typeof baseline;

    assert.deepStrictEqual(diffFormModels(baseline, unchanged), [], 'load-save without edits is byte-identical');

    const changed = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    changed.childItemsRoot[0]!.childItems[0]!.properties.DataPath = 'Changed';
    const edits = diffFormModels(baseline, changed);
    assert.deepStrictEqual(edits.map((edit) => edit.type), ['setProperties'], 'only the changed property is edited');
    const output = applyFormXmlEdits(source, edits);
    assert.ok(output.includes('<UsualGroup name="Group" id="1">'), 'parent start tag remains unchanged');
    assert.ok(output.includes('<Button name="Second" id="3"><Title>Keep</Title></Button>'), 'sibling bytes remain unchanged');
  });

  test('adds, moves, and removes elements together with their companions', () => {
    const source = '<Form version="2.20">\n'
      + '\t<ChildItems>\n'
      + '\t\t<UsualGroup name="Group" id="1">\n'
      + '\t\t\t<ChildItems>\n'
      + '\t\t\t\t<InputField name="First" id="2"><ContextMenu name="FirstContextMenu" id="3"/></InputField>\n'
      + '\t\t\t</ChildItems>\n'
      + '\t\t</UsualGroup>\n'
      + '\t\t<Button name="Second" id="4"><ExtendedTooltip name="SecondExtendedTooltip" id="5"/></Button>\n'
      + '\t</ChildItems>\n'
      + '</Form>\n';
    const output = applyFormXmlEdits(source, [
      { type: 'addElement', parent: { id: '1' }, index: 1, item: {
        tag: 'InputField', name: 'Added', id: '6', properties: { DataPath: 'Attr' }, childItems: [],
      } },
      { type: 'moveElement', element: { id: '4', name: 'Second' }, parent: { id: '1' }, index: 2 },
      { type: 'removeElement', element: { id: '2', name: 'First' } },
    ]);

    assert.ok(output.includes('<InputField name="Added" id="6">'), 'new item exists');
    assert.ok(output.includes('<ContextMenu name="AddedContextMenu" id="7"/>'), 'new item companion exists');
    assert.ok(output.includes('<ExtendedTooltip name="AddedExtendedTooltip" id="8"/>'), 'second companion exists');
    assert.ok(output.includes('<Button name="Second" id="4">'), 'moved item remains');
    assert.ok(!output.includes('name="First"'), 'removed item and companion are removed together');
    const model = parseFormXmlContent(output);
    assert.ok(!('error' in model), 'result parses as a form');
    if (!('error' in model)) {
      assert.deepStrictEqual(model.model.childItemsRoot[0]?.childItems.map((item) => item.name), ['Added', 'Second']);
    }
  });

  test('adds exactly one element when the destination ChildItems section is self-closing', () => {
    const source = '<Form version="2.20"><ChildItems/></Form>';
    const output = applyFormXmlEdits(source, [{
      type: 'addElement',
      index: 0,
      item: { tag: 'UsualGroup', name: 'NewGroup', id: '1', properties: {}, childItems: [] },
    }]);
    assert.strictEqual((output.match(/<UsualGroup\b/g) ?? []).length, 1, 'self-closing destination expands without duplicating the new element');
    const parsed = parseFormXmlContent(output);
    assert.ok(!('error' in parsed));
    if (!('error' in parsed)) {
      assert.deepStrictEqual(parsed.model.childItemsRoot.map((item) => item.name), ['NewGroup']);
    }
  });

  test('reconciles attributes, commands, and form and element event edits', () => {
    const source = '<Form version="2.20">\n'
      + '\t<Events><Event name="OnOpen">OldFormHandler</Event></Events>\n'
      + '\t<ChildItems><InputField name="Field" id="1"><Events><Event name="OnChange">OldHandler</Event></Events></InputField></ChildItems>\n'
      + '\t<Attributes><Attribute name="Existing" id="2"><Type><v8:Type>xs:string</v8:Type></Type></Attribute></Attributes>\n'
      + '\t<Commands><Command name="ExistingCommand" id="3"><Title>Old</Title></Command></Commands>\n'
      + '</Form>\n';
    const baselineResult = parseFormXmlContent(source);
    assert.ok(!('error' in baselineResult));
    if ('error' in baselineResult) return;
    const baseline = baselineResult.model;
    assert.deepStrictEqual(baseline.commands.map((command) => ({ name: command.name, id: command.id })), [
      { name: 'ExistingCommand', id: '3' },
    ], 'real outer Command attributes are parsed into the model');
    const current = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    current.formEvents = [{ name: 'OnOpen', method: 'NewFormHandler' }, { name: 'OnClose', method: 'CloseHandler' }];
    current.childItemsRoot[0]!.events = { OnChange: 'NewHandler' };
    current.attributes[0]!.properties.Type = [{ 'v8:Type': [{ '#text': 'xs:boolean' }] }];
    current.attributes.push({ name: 'AddedAttribute', id: '4', properties: { Type: [{ 'v8:Type': [{ '#text': 'xs:string' }] }] } });
    current.commands[0]!.properties.Title = [{ '#text': 'New command title' }];
    current.commands.push({ name: 'AddedCommand', id: '5', properties: {} });

    const edits = diffFormModels(baseline, current);
    const output = applyFormXmlEdits(source, edits);

    assert.ok(output.includes('<Event name="OnOpen">NewFormHandler</Event>'), 'form event updated');
    assert.ok(output.includes('<Event name="OnClose">CloseHandler</Event>'), 'form event added');
    assert.ok(output.includes('<Event name="OnChange">NewHandler</Event>'), 'element event updated');
    assert.ok(output.includes('<Attribute name="AddedAttribute" id="4">'), 'attribute added');
    assert.ok(output.includes('<Command name="AddedCommand" id="5">'), 'command added');
    assert.ok(output.includes('<Title>New command title</Title>'), 'command property updated');
    assert.ok(output.includes('<v8:Type>xs:boolean</v8:Type>'), 'complex attribute type updated');
  });

  test('fails closed on unsupported top-level changes and malformed XML', () => {
    const parsed = parseFormXmlContent('<Form version="2.20"><UnknownSection><Entry/></UnknownSection></Form>');
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    const changed = { ...parsed.model, topLevelFields: [{ tag: 'UnknownSection', content: [{ Entry: [] }] }, { tag: 'NewOpaque', content: [] }] };
    assert.throws(() => diffFormModels(parsed.model, changed), /корневого поля topLevelFields/);
    assert.throws(() => applyFormXmlEdits('<Form version="2.20"><ChildItems></Form>', []), /повреждён/);
  });
});
