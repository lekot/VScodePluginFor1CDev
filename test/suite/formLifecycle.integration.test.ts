import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  applyAddElement,
  applyDeleteElements,
  applyPasteElements,
  applyPropertyChange,
} from '../../src/formEditor/formModelCommands';
import type { FormModel, FormChildItem } from '../../src/formEditor/formModel';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { writeFormXml } from '../../src/formEditor/formXmlWriter';
import { createSerializedMessageHandler } from '../../src/formEditor/formMessageHandler';

suite('form lifecycle integration', () => {
  test('create -> rename -> duplicate -> delete keeps tree and disk consistent', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-lifecycle-'));
    const formXmlPath = path.join(tmpRoot, 'Catalogs', 'Orders', 'Forms', 'MainForm', 'Ext', 'Form.xml');
    try {
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      const minimalFormXml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">
  <Events/>
  <ChildItems/>
  <Attributes/>
  <Commands/>
</Form>
`;
      await fs.promises.writeFile(formXmlPath, minimalFormXml, 'utf-8');

      const loaded = await parseFormXml(formXmlPath, true);
      assert.ok(!('error' in loaded), 'Form model should load from disk');
      const model = (loaded as { model: FormModel }).model;

      const created = applyAddElement(model, undefined, 'Group', 'FieldOriginal');
      assert.strictEqual(created.ok, true, 'Create command should succeed');
      assert.ok(model.childItemsRoot.length > 0, 'Tree should contain created form element');
      const createdNode = model.childItemsRoot[0];
      assert.ok(createdNode.id, 'Created node id should be defined');
      const createdId = createdNode.id as string;

      applyPropertyChange(model, { elementId: createdId, key: 'name', value: 'FieldRenamed' });
      assert.strictEqual(model.childItemsRoot[0].name, 'FieldRenamed', 'Rename should mutate tree node name');

      const clonedSource: FormChildItem = JSON.parse(JSON.stringify(model.childItemsRoot[0])) as FormChildItem;
      const duplicated = applyPasteElements(model, createdId, [clonedSource]);
      assert.strictEqual(duplicated.ok, true, 'Duplicate command should succeed');
      assert.strictEqual(
        model.childItemsRoot[0].childItems?.length ?? 0,
        1,
        'Tree should contain duplicated element as child'
      );

      const duplicateId = model.childItemsRoot[0].childItems![0].id;
      assert.ok(duplicateId, 'Duplicate node id should be defined');
      const deleted = applyDeleteElements(model, [duplicateId]);
      assert.strictEqual(deleted.ok, true, 'Delete command should succeed');
      assert.strictEqual(model.childItemsRoot[0].childItems?.length ?? 0, 0, 'Deleted node should be removed from tree');

      await writeFormXml(formXmlPath, model);
      const reloaded = await parseFormXml(formXmlPath, true);
      assert.ok(!('error' in reloaded), 'Saved form model should be reloadable');
      const persistedModel = (reloaded as { model: FormModel }).model;
      assert.strictEqual(persistedModel.childItemsRoot.length, 1, 'Persisted root should contain renamed element');
      assert.strictEqual(persistedModel.childItemsRoot[0].childItems?.length ?? 0, 0);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('ui message routing: create -> rename -> duplicate -> delete -> save persists roundtrip', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-ui-lifecycle-'));
    const formXmlPath = path.join(tmpRoot, 'Catalogs', 'Orders', 'Forms', 'UiMainForm', 'Ext', 'Form.xml');
    try {
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      await fs.promises.writeFile(
        formXmlPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">
  <Events/>
  <ChildItems/>
  <Attributes/>
  <Commands/>
</Form>
`,
        'utf-8'
      );

      const posted: Array<Record<string, unknown>> = [];
      const fakePanel = {
        title: '',
        webview: {
          postMessage: async (message: unknown) => {
            posted.push(message as Record<string, unknown>);
            return true;
          },
        },
      } as unknown as vscode.WebviewPanel;

      const ctx = {
        document: { uri: vscode.Uri.file(formXmlPath) },
        webviewPanel: fakePanel,
        documentModel: new Map<string, FormModel>(),
      };
      const send = createSerializedMessageHandler(ctx);

      await send({ type: 'load' });
      const afterLoad = posted.find((m) => m.type === 'formData');
      assert.ok(afterLoad, 'Load should post initial formData');

      await send({ type: 'addElement', tag: 'Group', name: 'FieldOriginal' });
      const afterCreate = posted.filter((m) => m.type === 'formData').slice(-1)[0];
      const createdModel = afterCreate.formModel as FormModel;
      assert.strictEqual(createdModel.childItemsRoot.length, 1, 'Create should add one root element');
      const createdId = createdModel.childItemsRoot[0].id as string;
      assert.ok(createdId, 'Created element must have id');

      await send({ type: 'propertyChange', elementId: createdId, key: 'name', value: 'FieldRenamed' });

      const clone: FormChildItem = JSON.parse(JSON.stringify(createdModel.childItemsRoot[0])) as FormChildItem;
      await send({ type: 'pasteElement', targetId: createdId, clipboard: [clone] });
      const afterDuplicate = posted.filter((m) => m.type === 'formData').slice(-1)[0];
      const duplicatedModel = afterDuplicate.formModel as FormModel;
      const duplicateId = duplicatedModel.childItemsRoot[0].childItems?.[0].id as string;
      assert.ok(duplicateId, 'Duplicate should create nested child item');

      await send({ type: 'deleteElement', elementId: duplicateId });
      const afterDelete = posted.filter((m) => m.type === 'formData').slice(-1)[0];
      const afterDeleteModel = afterDelete.formModel as FormModel;
      assert.strictEqual(afterDeleteModel.childItemsRoot[0].name, 'FieldRenamed', 'Rename should persist in model');
      assert.strictEqual(afterDeleteModel.childItemsRoot[0].childItems?.length ?? 0, 0, 'Duplicate should be removed');

      await send({ type: 'save' });
      assert.ok(posted.some((m) => m.type === 'saved'), 'Explicit save message should emit saved event');

      const reloaded = await parseFormXml(formXmlPath, true);
      assert.ok(!('error' in reloaded), 'Saved form should remain parseable');
      const persistedModel = (reloaded as { model: FormModel }).model;
      assert.strictEqual(persistedModel.childItemsRoot.length, 1, 'Persisted model should keep one root element');
      assert.strictEqual(persistedModel.childItemsRoot[0].childItems?.length ?? 0, 0, 'Persisted duplicate should be deleted');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
