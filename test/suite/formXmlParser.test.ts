import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { injectMissingFormOpenTagAttrs, writeFormXml } from '../../src/formEditor/formXmlWriter';
import { isFormParseError, isFormParseFileMissing, createEmptyFormModel } from '../../src/formEditor/formModel';

suite('FormXmlParser', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/form-editor/Form.xml');

  test('fixture file exists', () => {
    assert.ok(fs.existsSync(fixturePath), `Fixture not found: ${fixturePath}`);
  });

  test('should parse valid Form.xml fixture', async () => {
    const result = await parseFormXml(fixturePath);
    assert.ok(!isFormParseError(result), (result as { error?: string }).error ?? '');
    assert.ok(!isFormParseFileMissing(result));
    assert.ok('model' in result);
    const model = result.model;
    const hasData =
      model.childItemsRoot.length > 0 ||
      model.formEvents.length > 0 ||
      model.attributes.length > 0 ||
      model.commands.length > 0;
    assert.ok(hasData, 'model should have at least one section with data');
    if (model.childItemsRoot.length >= 1) {
      assert.strictEqual(model.childItemsRoot[0].tag, 'UsualGroup');
      assert.strictEqual(model.childItemsRoot[0].name, 'Группа1');
      if (model.childItemsRoot[0].childItems.length >= 1) {
        assert.strictEqual(model.childItemsRoot[0].childItems[0].tag, 'InputField');
        assert.strictEqual(model.childItemsRoot[0].childItems[0].name, 'Поле1');
      }
    }
    if (model.formEvents.length >= 1) {
      assert.strictEqual(model.formEvents[0].name, 'OnOpen');
      assert.strictEqual(model.formEvents[0].method, 'ПриОткрытии');
    }
    if (model.attributes.length >= 1) assert.strictEqual(model.attributes[0].name, 'Реквизит1');
    if (model.commands.length >= 1) assert.strictEqual(model.commands[0].name, 'Команда1');
  });

  test('should return fileMissing when file does not exist and allowFileMissing', async () => {
    const result = await parseFormXml(path.join(__dirname, '../fixtures/non-existent-Form.xml'), true);
    assert.ok(isFormParseFileMissing(result));
    assert.ok(result.model);
    assert.strictEqual(result.model.childItemsRoot.length, 0);
  });

  test('should return error when file does not exist and allowFileMissing false', async () => {
    const result = await parseFormXml(path.join(__dirname, '../fixtures/non-existent-Form.xml'), false);
    assert.ok(isFormParseError(result));
    assert.ok(result.error.length > 0);
  });

  test('parses Parameters section into first-class model.parameters', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-params-parse-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      await writeFormXml(formXmlPath, {
        childItemsRoot: [],
        attributes: [],
        commands: [],
        formEvents: [],
        parameters: [
          {
            name: 'Парам1',
            id: '10',
            properties: { Title: [{ '#text': 'ЗаголовокПараметра' }] },
          },
        ],
      });
      const result = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(result), (result as { error?: string }).error ?? '');
      assert.strictEqual(result.model.parameters?.length ?? 0, 1);
      assert.ok(result.model.parameters?.[0].name);
      assert.ok(
        result.model.parameters?.[0].properties['Title'],
        'Parameter properties should keep known nested tags'
      );
      assert.ok(
        !(result.model.topLevelFields ?? []).some((f) => /(^|:)Parameters$/.test(f.tag)),
        'Parameters must not remain in topLevelFields when parsed as first-class section'
      );
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('parses CommandSet/ExcludedCommand into first-class model.excludedCommands', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-commandset-parse-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      await writeFormXml(formXmlPath, {
        childItemsRoot: [],
        attributes: [],
        commands: [],
        formEvents: [],
        excludedCommands: ['Form.CommandA', 'Form.CommandB'],
      });
      const result = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(result), (result as { error?: string }).error ?? '');
      assert.deepStrictEqual(result.model.excludedCommands, ['Form.CommandA', 'Form.CommandB']);
      assert.ok(
        !(result.model.topLevelFields ?? []).some((f) => /(^|:)CommandSet$/.test(f.tag)),
        'CommandSet must not remain in topLevelFields when parsed as first-class section'
      );
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('round-trip keeps raw Parameters when section has unknown child nodes', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-params-raw-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.17">
	<Parameters>
		<Parameter name="P1">
			<Title>P1</Title>
		</Parameter>
		<UnknownParamNode>
			<Value>42</Value>
		</UnknownParamNode>
	</Parameters>
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed), (parsed as { error?: string }).error ?? '');
      assert.strictEqual(parsed.model.parameters?.length ?? 0, 1);
      assert.strictEqual(parsed.model.parametersFirstClassLossless, false);
      assert.ok(
        (parsed.model.topLevelFields ?? []).some((f) => /(^|:)Parameters$/.test(f.tag)),
        'Raw Parameters should be retained in topLevelFields when first-class is not lossless'
      );
      await writeFormXml(formXmlPath, parsed.model);
      const after = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(after.includes('<UnknownParamNode>'));
      assert.ok(after.includes('<Value>42</Value>'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('round-trip keeps raw CommandSet when it has nodes other than ExcludedCommand', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-commandset-raw-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.17">
	<CommandSet>
		<ExcludedCommand>Form.CommandA</ExcludedCommand>
		<CustomCommandNode>
			<Name>KeepMe</Name>
		</CustomCommandNode>
	</CommandSet>
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed), (parsed as { error?: string }).error ?? '');
      assert.deepStrictEqual(parsed.model.excludedCommands, ['Form.CommandA']);
      assert.strictEqual(parsed.model.commandSetFirstClassLossless, false);
      assert.ok(
        (parsed.model.topLevelFields ?? []).some((f) => /(^|:)CommandSet$/.test(f.tag)),
        'Raw CommandSet should be retained in topLevelFields when first-class is not lossless'
      );
      await writeFormXml(formXmlPath, parsed.model);
      const after = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(after.includes('<CustomCommandNode>'));
      assert.ok(after.includes('<Name>KeepMe</Name>'));
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('does not deep-scan nested Parameters or CommandSet outside top-level Form sections', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-top-level-only-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.17">
	<ChildItems>
		<Group name="G1">
			<Parameters>
				<Parameter name="NestedParam"/>
			</Parameters>
			<CommandSet>
				<ExcludedCommand>Nested.Command</ExcludedCommand>
			</CommandSet>
		</Group>
	</ChildItems>
</Form>`;
      await fs.promises.writeFile(formXmlPath, xml, 'utf-8');
      const parsed = await parseFormXml(formXmlPath);
      assert.ok(!isFormParseError(parsed), (parsed as { error?: string }).error ?? '');
      assert.strictEqual(parsed.model.parameters?.length ?? 0, 0);
      assert.strictEqual(parsed.model.excludedCommands?.length ?? 0, 0);
      assert.ok(
        !(parsed.model.topLevelFields ?? []).some((f) => /(^|:)Parameters$/.test(f.tag)),
        'Nested Parameters must not be treated as top-level'
      );
      assert.ok(
        !(parsed.model.topLevelFields ?? []).some((f) => /(^|:)CommandSet$/.test(f.tag)),
        'Nested CommandSet must not be treated as top-level'
      );
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('should return error or no Form for invalid XML', async () => {
    const invalidPath = path.resolve(__dirname, '../fixtures/form-editor/FormInvalid.xml');
    const result = await parseFormXml(invalidPath);
    if (isFormParseError(result)) {
      assert.ok(result.error.length > 0);
    } else if (!isFormParseFileMissing(result) && 'model' in result) {
      assert.strictEqual(
        result.model.childItemsRoot.length,
        0,
        'invalid XML may produce empty model'
      );
    }
  });

  test('createEmptyFormModel returns empty model', () => {
    const empty = createEmptyFormModel();
    assert.strictEqual(empty.childItemsRoot.length, 0);
    assert.strictEqual(empty.attributes.length, 0);
    assert.strictEqual(empty.commands.length, 0);
    assert.strictEqual(empty.formEvents.length, 0);
  });

  test('writeFormXml adds xmlns and version on Form open tag when builder omits them', () => {
    const bare = '<Form>\n\t<ChildItems></ChildItems>\n</Form>';
    const model = createEmptyFormModel();
    model.version = '2.17';
    const out = injectMissingFormOpenTagAttrs(bare, model);
    assert.ok(out.includes('xmlns="http://v8.1c.ru/8.3/xcf/logform"'), 'default logform xmlns');
    assert.ok(out.includes('version="2.17"'), 'version from model');
  });

  test('round-trip: parse, write, parse produces valid model', async () => {
    const result = await parseFormXml(fixturePath);
    assert.ok(!isFormParseError(result), (result as { error?: string }).error ?? '');
    const model = result.model;
    const tmpPath = path.join(os.tmpdir(), `1cviewer-form-roundtrip-${Date.now()}.xml`);
    try {
      await writeFormXml(tmpPath, model);
      const written = await fs.promises.readFile(tmpPath, 'utf-8');
      assert.ok(
        /<\s*Form[^>]*\bversion\s*=\s*"2\.20"/.test(written),
        'written Form.xml should declare version on opening tag (B.1 contract)'
      );
      const reParsed = await parseFormXml(tmpPath);
      assert.ok(!isFormParseError(reParsed), (reParsed as { error?: string }).error ?? '');
      assert.ok(reParsed.model.childItemsRoot.length >= 1, 'round-trip model has childItemsRoot');
      assert.strictEqual(reParsed.model.childItemsRoot[0].tag, 'UsualGroup');
      assert.strictEqual(reParsed.model.childItemsRoot[0].name, 'Группа1');
      // id and name remain strings after round-trip
      const first = reParsed.model.childItemsRoot[0];
      if (first.id != null) assert.strictEqual(typeof first.id, 'string', 'childItemsRoot[0].id is string');
      if (first.name != null) assert.strictEqual(typeof first.name, 'string', 'childItemsRoot[0].name is string');
      if (reParsed.model.attributes.length >= 1) {
        const a = reParsed.model.attributes[0];
        if (a.id != null) assert.strictEqual(typeof a.id, 'string', 'attributes[0].id is string');
        if (a.name != null) assert.strictEqual(typeof a.name, 'string', 'attributes[0].name is string');
      }
      if (reParsed.model.commands.length >= 1) {
        const c = reParsed.model.commands[0];
        if (c.id != null) assert.strictEqual(typeof c.id, 'string', 'commands[0].id is string');
        if (c.name != null) assert.strictEqual(typeof c.name, 'string', 'commands[0].name is string');
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });

  test('id and name from parser are strings', async () => {
    const result = await parseFormXml(fixturePath);
    assert.ok(!isFormParseError(result), (result as { error?: string }).error ?? '');
    const model = result.model;
    function checkIdNameString(item: { id?: unknown; name?: unknown }, label: string): void {
      if (item.id != null) assert.strictEqual(typeof item.id, 'string', `${label}.id is string`);
      if (item.name != null) assert.strictEqual(typeof item.name, 'string', `${label}.name is string`);
    }
    function walkChildItems(items: Array<{ id?: unknown; name?: unknown; childItems?: unknown[] }>, prefix: string): void {
      items.forEach((item, i) => {
        checkIdNameString(item, `${prefix}[${i}]`);
        if (Array.isArray(item.childItems) && item.childItems.length) {
          walkChildItems(item.childItems as Array<{ id?: unknown; name?: unknown; childItems?: unknown[] }>, `${prefix}[${i}].childItems`);
        }
      });
    }
    walkChildItems(model.childItemsRoot, 'childItemsRoot');
    model.attributes.forEach((attr, i) => checkIdNameString(attr, `attributes[${i}]`));
    model.commands.forEach((cmd, i) => checkIdNameString(cmd, `commands[${i}]`));
  });
});
