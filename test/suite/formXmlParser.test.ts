import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { writeFormXml } from '../../src/formEditor/formXmlWriter';
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

  test('round-trip: parse, write, parse produces valid model', async () => {
    const result = await parseFormXml(fixturePath);
    assert.ok(!isFormParseError(result), (result as { error?: string }).error ?? '');
    const model = result.model;
    const tmpPath = path.join(os.tmpdir(), `1cviewer-form-roundtrip-${Date.now()}.xml`);
    try {
      await writeFormXml(tmpPath, model);
      const reParsed = await parseFormXml(tmpPath);
      assert.ok(!isFormParseError(reParsed), (reParsed as { error?: string }).error ?? '');
      assert.ok(reParsed.model.childItemsRoot.length >= 1, 'round-trip model has childItemsRoot');
      assert.ok(reParsed.model.childItemsRoot[0].tag, 'round-trip first element has tag');
      assert.ok(reParsed.model.childItemsRoot[0].name, 'round-trip first element has name');
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
