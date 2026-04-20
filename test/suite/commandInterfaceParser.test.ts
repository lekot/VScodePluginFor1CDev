import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseCommandInterface, serializeCommandInterface } from '../../src/parsers/commandInterfaceParser';
import type { CommandInterfaceModel } from '../../src/types/commandInterface';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'commandInterface');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

suite('commandInterfaceParser', () => {
  test('parse empty CommandInterface — all arrays empty', () => {
    const xml = readFixture('empty.xml');
    const model = parseCommandInterface(xml);
    assert.strictEqual(model.xmlVersion, '2.17');
    assert.deepStrictEqual(model.visibility, []);
    assert.deepStrictEqual(model.placement, []);
    assert.deepStrictEqual(model.commandsOrder, []);
    assert.deepStrictEqual(model.subsystemsOrder, []);
    assert.deepStrictEqual(model.groupsOrder, []);
    assert.strictEqual(model.hasBom, false);
  });

  test('parse minimal CommandInterface with visibility only', () => {
    const xml = readFixture('minimal.xml');
    const model = parseCommandInterface(xml);
    assert.strictEqual(model.xmlVersion, '2.17');
    assert.strictEqual(model.visibility.length, 2);
    assert.strictEqual(model.visibility[0].commandName, 'Catalog.Товары.StandardCommand.OpenList');
    assert.strictEqual(model.visibility[0].common, 'visible');
    assert.strictEqual(model.visibility[1].commandName, 'CommonCommand.ПанельОтчетов');
    assert.strictEqual(model.visibility[1].common, 'hidden');
    assert.deepStrictEqual(model.placement, []);
    assert.deepStrictEqual(model.commandsOrder, []);
    assert.deepStrictEqual(model.subsystemsOrder, []);
    assert.deepStrictEqual(model.groupsOrder, []);
  });

  test('parse full CommandInterface with all 5 sections', () => {
    const xml = readFixture('full.xml');
    const model = parseCommandInterface(xml);
    assert.strictEqual(model.visibility.length, 2);
    assert.strictEqual(model.placement.length, 1);
    assert.strictEqual(model.placement[0].commandGroup, 'NavigationPanelOrdinary');
    assert.strictEqual(model.placement[0].placement, 'Auto');
    assert.strictEqual(model.commandsOrder.length, 2);
    assert.strictEqual(model.subsystemsOrder.length, 2);
    assert.strictEqual(model.subsystemsOrder[0], 'Subsystem.Продажи.Subsystem.Отчеты');
    assert.strictEqual(model.groupsOrder.length, 2);
    assert.strictEqual(model.groupsOrder[0], 'NavigationPanelOrdinary');
  });

  test('roundtrip: parse → serialize → parse produces equal model', () => {
    const xml = readFixture('full.xml');
    const model1 = parseCommandInterface(xml);
    const serialized = serializeCommandInterface(model1);
    const model2 = parseCommandInterface(serialized);
    assert.strictEqual(model2.xmlVersion, model1.xmlVersion);
    assert.strictEqual(model2.hasBom, model1.hasBom);
    assert.deepStrictEqual(model2.visibility, model1.visibility);
    assert.deepStrictEqual(model2.placement, model1.placement);
    assert.deepStrictEqual(model2.commandsOrder, model1.commandsOrder);
    assert.deepStrictEqual(model2.subsystemsOrder, model1.subsystemsOrder);
    assert.deepStrictEqual(model2.groupsOrder, model1.groupsOrder);
  });

  test('BOM preservation: input with BOM produces output with BOM', () => {
    const xml = readFixture('full.xml');
    const withBom = '\uFEFF' + xml;
    const model = parseCommandInterface(withBom);
    assert.strictEqual(model.hasBom, true);
    const serialized = serializeCommandInterface(model);
    assert.ok(serialized.startsWith('\uFEFF'), 'serialized must start with BOM');
  });

  test('BOM preservation: input without BOM produces output without BOM', () => {
    const xml = readFixture('full.xml');
    const model = parseCommandInterface(xml);
    assert.strictEqual(model.hasBom, false);
    const serialized = serializeCommandInterface(model);
    assert.ok(!serialized.startsWith('\uFEFF'), 'serialized must not start with BOM');
  });

  test('parse large real file from FormatSamples', () => {
    const realPath = path.join(
      __dirname, '..', '..', 'FormatSamples', 'uh', 'Subsystems',
      'Администрирование', 'Ext', 'CommandInterface.xml'
    );
    if (!fs.existsSync(realPath)) {
      return; // skip if format samples not present
    }
    const xml = fs.readFileSync(realPath, 'utf8');
    const model = parseCommandInterface(xml);
    assert.strictEqual(model.xmlVersion, '2.20');
    assert.ok(model.visibility.length > 0, 'should have visibility entries');
    assert.ok(model.placement.length > 0, 'should have placement entries');
    assert.ok(model.commandsOrder.length > 0, 'should have commandsOrder entries');
    assert.ok(model.subsystemsOrder.length > 0, 'should have subsystemsOrder entries');
    assert.ok(model.groupsOrder.length > 0, 'should have groupsOrder entries');
  });

  test('roundtrip for large real file preserves all counts', () => {
    const realPath = path.join(
      __dirname, '..', '..', 'FormatSamples', 'uh', 'Subsystems',
      'Администрирование', 'Ext', 'CommandInterface.xml'
    );
    if (!fs.existsSync(realPath)) {
      return;
    }
    const xml = fs.readFileSync(realPath, 'utf8');
    const model1 = parseCommandInterface(xml);
    const model2 = parseCommandInterface(serializeCommandInterface(model1));
    assert.strictEqual(model2.visibility.length, model1.visibility.length);
    assert.strictEqual(model2.placement.length, model1.placement.length);
    assert.strictEqual(model2.commandsOrder.length, model1.commandsOrder.length);
    assert.strictEqual(model2.subsystemsOrder.length, model1.subsystemsOrder.length);
    assert.strictEqual(model2.groupsOrder.length, model1.groupsOrder.length);
    assert.deepStrictEqual(model2.visibility, model1.visibility);
  });

  test('serialize empty model produces valid XML without sections', () => {
    const model: CommandInterfaceModel = {
      xmlVersion: '2.17',
      hasBom: false,
      visibility: [],
      placement: [],
      commandsOrder: [],
      subsystemsOrder: [],
      groupsOrder: [],
    };
    const xml = serializeCommandInterface(model);
    assert.ok(xml.includes('<CommandInterface'), 'should include root element');
    assert.ok(!xml.includes('<CommandsVisibility>'), 'should not include empty sections');
    assert.ok(!xml.includes('<CommandsOrder>'), 'should not include empty sections');
  });
});
