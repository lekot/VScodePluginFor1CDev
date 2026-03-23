import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FormModel } from '../../src/formEditor/formModel';
import { FormCommandEngine } from '../../src/formEditor/formCommandEngine';
import { handleMessage, type MessageHandlerContext } from '../../src/formEditor/formMessageHandler';
import * as vscode from 'vscode';

function makeModel(): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

suite('FormCommandEngine iteration-1', () => {
  test('execute updates snapshot', () => {
    const model = makeModel();
    const engine = new FormCommandEngine(model);

    const addResult = engine.execute({
      type: 'addElement',
      payload: { tag: 'Group', name: 'RootNode' },
    });

    assert.strictEqual(addResult.ok, true);
    assert.strictEqual(model.childItemsRoot.length, 1);

    const snapshot = engine.getSnapshot();
    assert.strictEqual(snapshot.canUndo, true);
    assert.strictEqual(snapshot.canRedo, false);
    assert.strictEqual(snapshot.lastCommandType, 'addElement');
  });

  test('undo/redo roundtrip restores and reapplies state', () => {
    const model = makeModel();
    const engine = new FormCommandEngine(model);

    engine.execute({ type: 'addElement', payload: { tag: 'Group', name: 'RootNode' } });
    assert.strictEqual(model.childItemsRoot.length, 1);

    const undoResult = engine.undo();
    assert.strictEqual(undoResult.ok, true);
    assert.strictEqual(model.childItemsRoot.length, 0);
    assert.strictEqual(engine.getSnapshot().canRedo, true);

    const redoResult = engine.redo();
    assert.strictEqual(redoResult.ok, true);
    assert.strictEqual(model.childItemsRoot.length, 1);
    assert.strictEqual(engine.getSnapshot().canUndo, true);
  });

  test('dirty flag changes after execute and resets after undo', () => {
    const model = makeModel();
    const engine = new FormCommandEngine(model);
    assert.strictEqual(engine.isDirty(), false);

    const addResult = engine.execute({
      type: 'addElement',
      payload: { tag: 'Group', name: 'RootNode' },
    });
    assert.strictEqual(addResult.ok, true);
    assert.strictEqual(engine.isDirty(), true);
    assert.strictEqual(engine.getSnapshot().dirty, true);

    const undoResult = engine.undo();
    assert.strictEqual(undoResult.ok, true);
    assert.strictEqual(engine.isDirty(), false);
    assert.strictEqual(engine.getSnapshot().dirty, false);
  });

  test('message handler routes addElement through engine when enabled', async () => {
    process.env.FORM_COMMAND_ENGINE_ENABLED = 'true';
    process.env.FORM_COMMAND_ENGINE_EXPLICIT_SAVE_ENABLED = 'true';
    try {
      const model = makeModel();
      const uri = vscode.Uri.file('C:/tmp/Form.xml');
      const key = uri.toString();
      const ctx: MessageHandlerContext = {
        document: { uri },
        webviewPanel: {
          title: '',
          webview: { postMessage: () => undefined },
        } as unknown as vscode.WebviewPanel,
        documentModel: new Map<string, FormModel>([[key, model]]),
      };

      await handleMessage(ctx, {
        type: 'addElement',
        tag: 'Group',
        name: 'FromEngine',
      });

      assert.strictEqual(model.childItemsRoot.length, 1);
      assert.strictEqual(model.childItemsRoot[0].name, 'FromEngine');
      assert.ok(ctx.commandEngines);
      assert.strictEqual(ctx.commandEngines!.size, 1);
      assert.strictEqual(ctx.dirtyDocuments?.has(key), true);
    } finally {
      delete process.env.FORM_COMMAND_ENGINE_ENABLED;
      delete process.env.FORM_COMMAND_ENGINE_EXPLICIT_SAVE_ENABLED;
    }
  });

  test('message handler keeps fallback path when engine is disabled', async () => {
    delete process.env.FORM_COMMAND_ENGINE_ENABLED;
    delete process.env.FORM_COMMAND_ENGINE_EXPLICIT_SAVE_ENABLED;

    const model = makeModel();
    const elementId = 'el-1';
    model.childItemsRoot.push({
      tag: 'InputField',
      id: elementId,
      name: 'Before',
      properties: {},
      childItems: [],
    });
    const uri = vscode.Uri.file('C:/tmp/Form.xml');
    const key = uri.toString();
    const ctx: MessageHandlerContext = {
      document: { uri },
      webviewPanel: {
        title: '',
        webview: { postMessage: () => undefined },
      } as unknown as vscode.WebviewPanel,
      documentModel: new Map<string, FormModel>([[key, model]]),
    };

    await handleMessage(ctx, {
      type: 'propertyChange',
      elementId,
      key: 'name',
      value: 'After',
    });

    assert.strictEqual(model.childItemsRoot[0].name, 'After');
    assert.ok(!ctx.commandEngines || ctx.commandEngines.size === 0);
    assert.strictEqual(ctx.dirtyDocuments?.has(key), true);
  });

  test('save clears dirty flag and writes on explicit save', async () => {
    process.env.FORM_COMMAND_ENGINE_ENABLED = 'true';
    try {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-engine-save-'));
      const formPath = path.join(tempDir, 'Form.xml');
      const uri = vscode.Uri.file(formPath);
      const key = uri.toString();
      const model = makeModel();
      const posted: Array<{ type?: string }> = [];
      const ctx: MessageHandlerContext = {
        document: { uri },
        webviewPanel: {
          title: '',
          webview: { postMessage: (payload: unknown) => posted.push(payload as { type?: string }) },
        } as unknown as vscode.WebviewPanel,
        documentModel: new Map<string, FormModel>([[key, model]]),
      };

      await handleMessage(ctx, { type: 'addElement', tag: 'Group', name: 'NeedsSave' });
      assert.strictEqual(ctx.dirtyDocuments?.has(key), true);

      await handleMessage(ctx, { type: 'save', formModel: model });
      assert.strictEqual(ctx.dirtyDocuments?.has(key), false);
      assert.ok(posted.some((m) => m.type === 'saved'));
      const written = await fs.promises.readFile(formPath, 'utf-8');
      assert.ok(written.includes('<Form'));
    } finally {
      delete process.env.FORM_COMMAND_ENGINE_ENABLED;
    }
  });
});
