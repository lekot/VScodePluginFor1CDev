import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FormModel } from '../../src/formEditor/formModel';
import { writeFormXml } from '../../src/formEditor/formXmlWriter';

function createBaseModel(): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

suite('FormXmlWriter', () => {
  test('writes default Form version 2.17 when model version is absent', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-writer-version-'));
    const formXmlPath = path.join(tmpRoot, 'Form.xml');
    try {
      await writeFormXml(formXmlPath, createBaseModel());
      const xml = await fs.promises.readFile(formXmlPath, 'utf-8');
      assert.ok(xml.includes('<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.17">'));
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
});
