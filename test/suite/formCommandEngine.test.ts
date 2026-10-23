import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FormModel } from '../../src/formEditor/formModel';
import { FormCommandEngine } from '../../src/formEditor/formCommandEngine';
import type { FormEditorCommand } from '../../src/formEditor/formCommandEngine';
import type { CommandResult } from '../../src/formEditor/formModelCommands';
import { handleMessage, type MessageHandlerContext } from '../../src/formEditor/formMessageHandler';
import * as vscode from 'vscode';

function makeModel(): FormModel {
  return {
    version: '2.20',
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

function makeSelectableModel(): FormModel {
  return {
    ...makeModel(),
    childItemsRoot: [
      { tag: 'InputField', id: 'field-1', name: 'Field1', properties: { Width: '100' }, childItems: [] },
      { tag: 'InputField', id: 'field-2', name: 'Field2', properties: { Width: '200' }, childItems: [] },
    ],
  };
}

function propertyChange(elementId: string, value: string, section?: string): FormEditorCommand {
  return {
    type: 'propertyChange',
    payload: { elementId, key: 'Width', value, section },
  };
}

function executeBatch(engine: FormCommandEngine, commands: readonly FormEditorCommand[]): CommandResult {
  return engine.executeBatch(commands);
}

function widths(model: FormModel): string[] {
  return model.childItemsRoot.map((item) => String(item.properties?.Width));
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

  test('executes a valid command batch as one undoable history entry', () => {
    const model = makeSelectableModel();
    const engine = new FormCommandEngine(model);
    engine.execute({ type: 'addElement', payload: { tag: 'Group', name: 'Undone' } });
    assert.strictEqual(engine.undo().ok, true, 'prepare an existing redo entry');
    assert.strictEqual(engine.getSnapshot().redoDepth, 1);

    const result = executeBatch(engine, [propertyChange('field-1', '110'), propertyChange('field-2', '220')]);

    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(widths(model), ['110', '220']);
    const committed = engine.getSnapshot();
    assert.strictEqual(committed.undoDepth, 1, 'the whole batch creates one undo entry');
    assert.strictEqual(committed.redoDepth, 0, 'a successful batch clears redo history');
    assert.strictEqual(committed.lastCommandType as string | undefined, 'batch');

    assert.strictEqual(engine.undo().ok, true, 'one undo reverses every command in the batch');
    assert.deepStrictEqual(widths(model), ['100', '200']);
    assert.strictEqual(engine.getSnapshot().undoDepth, 0);
    assert.strictEqual(engine.getSnapshot().redoDepth, 1);

    assert.strictEqual(engine.redo().ok, true, 'one redo reapplies every command in the batch');
    assert.deepStrictEqual(widths(model), ['110', '220']);
    assert.strictEqual(engine.getSnapshot().undoDepth, 1);
    assert.strictEqual(engine.getSnapshot().redoDepth, 0);
  });

  test('rolls back a batch that encounters an unknown element after a valid command', () => {
    const model = makeSelectableModel();
    const engine = new FormCommandEngine(model);
    engine.execute({ type: 'addElement', payload: { tag: 'Group', name: 'Undone' } });
    assert.strictEqual(engine.undo().ok, true, 'prepare existing history to verify it remains unchanged');
    const beforeModel = JSON.parse(JSON.stringify(model)) as FormModel;
    const beforeHistory = engine.getSnapshot();

    const result = executeBatch(engine, [propertyChange('field-1', '999'), propertyChange('missing-id', '888')]);

    assert.strictEqual(result.ok, false, 'unknown target is a batch failure');
    assert.deepStrictEqual(model, beforeModel, 'failure restores all targets changed earlier in the batch');
    assert.deepStrictEqual(engine.getSnapshot(), beforeHistory, 'failure preserves undo and redo history');
  });

  test('batch targets nested children and the selected attributes or commands section', () => {
    const model = makeSelectableModel();
    model.childItemsRoot.push({
      tag: 'UsualGroup',
      id: 'group-1',
      name: 'NestedGroup',
      properties: {},
      childItems: [
        { tag: 'InputField', id: 'nested-field', name: 'NestedField', properties: { Width: '10' }, childItems: [] },
      ],
    });
    model.attributes.push({ name: 'Attribute1', id: 'attribute-1', properties: { Width: '20' } });
    model.commands.push({ name: 'Command1', id: 'command-1', properties: { Width: '30' } });
    const engine = new FormCommandEngine(model);
    const beforeModel = JSON.parse(JSON.stringify(model)) as FormModel;

    const result = executeBatch(engine, [
      propertyChange('nested-field', '11'),
      propertyChange('attribute-1', '21', 'attributes'),
      propertyChange('command-1', '31', 'commands'),
    ]);

    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(model.childItemsRoot[2].childItems[0].properties.Width, '11');
    assert.strictEqual(model.attributes[0].properties.Width, '21');
    assert.strictEqual(model.commands[0].properties.Width, '31');
    assert.strictEqual(engine.getSnapshot().undoDepth, 1, 'all sections share one batch history entry');

    assert.strictEqual(engine.undo().ok, true);
    assert.deepStrictEqual(model, beforeModel, 'one undo restores nested, attribute, and command targets');
  });

  test('batch rejects targets that do not belong to the explicitly selected section', () => {
    const invalidTargets = [
      { section: 'attributes', elementId: 'nested-field' },
      { section: 'attributes', elementId: 'command-1' },
      { section: 'commands', elementId: 'attribute-1' },
      { section: 'commands', elementId: 'nested-field' },
    ];

    for (const invalidTarget of invalidTargets) {
      const model = makeSelectableModel();
      model.childItemsRoot.push({
        tag: 'UsualGroup',
        id: 'group-1',
        name: 'NestedGroup',
        properties: {},
        childItems: [
          { tag: 'InputField', id: 'nested-field', name: 'NestedField', properties: { Width: '10' }, childItems: [] },
        ],
      });
      model.attributes.push({ name: 'Attribute1', id: 'attribute-1', properties: { Width: '20' } });
      model.commands.push({ name: 'Command1', id: 'command-1', properties: { Width: '30' } });
      const engine = new FormCommandEngine(model);
      const beforeModel = JSON.parse(JSON.stringify(model)) as FormModel;
      const beforeHistory = engine.getSnapshot();

      const result = executeBatch(engine, [
        propertyChange('field-1', '101'),
        propertyChange(invalidTarget.elementId, '999', invalidTarget.section),
      ]);

      assert.strictEqual(result.ok, false, `${invalidTarget.section} must reject ${invalidTarget.elementId}`);
      assert.deepStrictEqual(model, beforeModel, 'section mismatch rolls back earlier commands in the batch');
      assert.deepStrictEqual(engine.getSnapshot(), beforeHistory, 'section mismatch leaves history unchanged');
    }
  });

  test('empty and no-op batches leave the model and history unchanged', () => {
    const model = makeSelectableModel();
    const engine = new FormCommandEngine(model);
    engine.execute({ type: 'addElement', payload: { tag: 'Group', name: 'Undone' } });
    assert.strictEqual(engine.undo().ok, true, 'prepare existing redo history');
    const beforeModel = JSON.parse(JSON.stringify(model)) as FormModel;
    const beforeHistory = engine.getSnapshot();
    assert.strictEqual(beforeHistory.redoDepth, 1);

    assert.deepStrictEqual(executeBatch(engine, []), { ok: true });
    assert.deepStrictEqual(engine.getSnapshot(), beforeHistory, 'empty batch has no history effect');

    assert.deepStrictEqual(executeBatch(engine, [
      propertyChange('field-1', '101'),
      propertyChange('field-1', '100'),
    ]), { ok: true });
    assert.deepStrictEqual(model, beforeModel, 'same-value change leaves model unchanged');
    assert.deepStrictEqual(engine.getSnapshot(), beforeHistory, 'no-op batch has no history effect');
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
    let tempDir: string | undefined;
    try {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-engine-save-'));
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
      if (tempDir !== undefined) {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
});
