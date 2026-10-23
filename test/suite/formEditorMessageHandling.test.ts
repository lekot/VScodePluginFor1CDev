import * as assert from 'assert';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import {
  applyExternalPropertyChange,
  createSerializedExecutor,
  handleMessage,
  type MessageHandlerContext,
} from '../../src/formEditor/formMessageHandler';
import type { FormModel } from '../../src/formEditor/formModel';
import * as vscode from 'vscode';

function makeSelectableModel(widths: readonly string[] = ['100', '200']): FormModel {
  return {
    version: '2.20',
    attributes: [],
    commands: [],
    formEvents: [],
    childItemsRoot: widths.map((width, index) => ({
      tag: 'InputField',
      id: `field-${index + 1}`,
      name: `Field${index + 1}`,
      properties: { Width: width },
      childItems: [],
    })),
  };
}

function createMessageFixture(model = makeSelectableModel()): {
  ctx: MessageHandlerContext;
  model: FormModel;
  key: string;
  posted: Array<Record<string, unknown>>;
  get documentChanges(): number;
} {
  const uri = vscode.Uri.file('C:/tmp/form-message-batch/Form.xml');
  const key = uri.toString();
  const posted: Array<Record<string, unknown>> = [];
  let documentChanges = 0;
  const ctx: MessageHandlerContext = {
    document: { uri },
    webviewPanel: {
      title: '',
      webview: {
        postMessage: (message: unknown) => {
          posted.push(message as Record<string, unknown>);
          return Promise.resolve(true);
        },
      },
    } as unknown as vscode.WebviewPanel,
    documentModel: new Map([[key, model]]),
    dirtyDocuments: new Set<string>(),
    onDidChangeDocument: () => { documentChanges += 1; },
  };
  return {
    ctx,
    model,
    key,
    posted,
    get documentChanges() { return documentChanges; },
  };
}

async function withCommandEngineFlag<T>(value: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.FORM_COMMAND_ENGINE_ENABLED;
  if (value === undefined) {
    delete process.env.FORM_COMMAND_ENGINE_ENABLED;
  } else {
    process.env.FORM_COMMAND_ENGINE_ENABLED = value;
  }
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.FORM_COMMAND_ENGINE_ENABLED;
    } else {
      process.env.FORM_COMMAND_ENGINE_ENABLED = previous;
    }
  }
}

function getWidths(model: FormModel): string[] {
  return model.childItemsRoot.map((item) => String(item.properties?.Width));
}

suite('form editor message handling regressions', () => {
  test('enabled multi-select applies one atomic batch and publishes one dirty event', async () => {
    await withCommandEngineFlag('true', async () => {
      const fixture = createMessageFixture();
      await handleMessage(fixture.ctx, {
        type: 'propertyChange',
        elementIds: ['field-1', 'field-2'],
        key: 'Width',
        value: '250',
      });

      assert.deepStrictEqual(getWidths(fixture.model), ['250', '250']);
      assert.strictEqual(fixture.documentChanges, 1, 'a successful multi-select edit publishes once');
      assert.strictEqual(fixture.ctx.dirtyDocuments?.has(fixture.key), true);
      const engine = fixture.ctx.commandEngines?.get(fixture.key);
      assert.ok(engine, 'multi-select command uses the opt-in engine');
      assert.strictEqual(engine!.getSnapshot().undoDepth, 1, 'the selection is one history entry');
      assert.strictEqual(engine!.getSnapshot().lastCommandType as string | undefined, 'batch');
    });
  });

  test('a later unknown selected ID rejects the whole multi-select without dirty publication', async () => {
    await withCommandEngineFlag('true', async () => {
      const fixture = createMessageFixture();
      const beforeModel = JSON.parse(JSON.stringify(fixture.model)) as FormModel;

      await handleMessage(fixture.ctx, {
        type: 'propertyChange',
        elementIds: ['field-1', 'unknown-field'],
        key: 'Width',
        value: '999',
      });

      assert.deepStrictEqual(fixture.model, beforeModel, 'failure after the first valid ID rolls back that edit');
      assert.strictEqual(fixture.documentChanges, 0);
      assert.strictEqual(fixture.ctx.dirtyDocuments?.has(fixture.key) ?? false, false);
      assert.ok(fixture.posted.some((message) => message.type === 'error'), 'the batch failure is reported');
      assert.strictEqual(fixture.ctx.commandEngines?.get(fixture.key)?.getSnapshot().undoDepth ?? 0, 0);
    });
  });

  test('duplicate selected IDs edit a target once and one undo restores the selection', async () => {
    await withCommandEngineFlag('true', async () => {
      const fixture = createMessageFixture();
      await handleMessage(fixture.ctx, {
        type: 'propertyChange',
        elementIds: ['field-1', 'field-1', 'field-2'],
        key: 'Width',
        value: '250',
      });

      assert.deepStrictEqual(getWidths(fixture.model), ['250', '250']);
      const engine = fixture.ctx.commandEngines?.get(fixture.key);
      assert.ok(engine);
      assert.strictEqual(engine!.getSnapshot().undoDepth, 1, 'duplicate IDs do not create repeated history');
      assert.strictEqual(fixture.documentChanges, 1);
      assert.strictEqual(engine!.undo().ok, true);
      assert.deepStrictEqual(getWidths(fixture.model), ['100', '200']);
      assert.strictEqual(engine!.getSnapshot().redoDepth, 1);
      assert.strictEqual(engine!.redo().ok, true);
      assert.deepStrictEqual(getWidths(fixture.model), ['250', '250']);
    });
  });

  test('an empty multi-select does not create history or dirty events', async () => {
    await withCommandEngineFlag('true', async () => {
      const empty = createMessageFixture();
      const initial = JSON.parse(JSON.stringify(empty.model)) as FormModel;
      await handleMessage(empty.ctx, {
        type: 'propertyChange',
        elementIds: [],
        elementId: 'field-1',
        key: 'Width',
        value: '999',
      });
      assert.deepStrictEqual(empty.model, initial);
      assert.strictEqual(empty.documentChanges, 0);
      assert.strictEqual(empty.ctx.dirtyDocuments?.has(empty.key) ?? false, false);
      assert.strictEqual(empty.ctx.commandEngines?.get(empty.key)?.getSnapshot().undoDepth ?? 0, 0);
    });
  });

  test('a same-value multi-select is a no-op with no history or dirty events', async () => {
    await withCommandEngineFlag('true', async () => {
      const noOp = createMessageFixture(makeSelectableModel(['100', '100']));
      await handleMessage(noOp.ctx, {
        type: 'propertyChange',
        elementIds: ['field-1'],
        key: 'Width',
        value: '100',
      });
      assert.deepStrictEqual(getWidths(noOp.model), ['100', '100']);
      assert.strictEqual(noOp.documentChanges, 0);
      assert.strictEqual(noOp.ctx.dirtyDocuments?.has(noOp.key) ?? false, false);
      assert.strictEqual(noOp.ctx.commandEngines?.get(noOp.key)?.getSnapshot().undoDepth ?? 0, 0);
    });
  });

  test('multi-select legacy path remains active when the command engine flag is unset', async () => {
    await withCommandEngineFlag(undefined, async () => {
      const fixture = createMessageFixture();
      await handleMessage(fixture.ctx, {
        type: 'propertyChange',
        elementIds: ['field-1', 'field-2'],
        key: 'Width',
        value: '350',
      });

      assert.deepStrictEqual(getWidths(fixture.model), ['350', '350']);
      assert.strictEqual(fixture.documentChanges, 1, 'legacy multi-select still notifies once');
      assert.strictEqual(fixture.ctx.dirtyDocuments?.has(fixture.key), true);
      assert.ok(!fixture.ctx.commandEngines || fixture.ctx.commandEngines.size === 0);
    });
  });

  test('webview property change uses dataset key for regular props', () => {
    const html = getWebviewHtml({} as any);
    assert.ok(
      html.includes("const key = inp.dataset.key ? inp.dataset.key : (inp.id ? inp.id.replace('prop-', '') : null);"),
      'property key extraction should prioritize data-key with correct precedence'
    );
    assert.ok(
      !html.includes("const key = inp.dataset.key || inp.id ? inp.id.replace('prop-', '') : null;"),
      'buggy operator-precedence expression must be removed'
    );
    assert.ok(
      html.includes('selectedAttributeId = attr.id || attr.name;'),
      'attribute selection should prefer stable id'
    );
    assert.ok(
      html.includes('selectedCommandId = cmd.id || cmd.name;'),
      'command selection should prefer stable id'
    );
  });

  test('serialized executor preserves in-flight operation ordering', async () => {
    const events: string[] = [];
    const run = createSerializedExecutor(async (payload: { name: string; delayMs: number }) => {
      events.push(`start:${payload.name}`);
      await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
      events.push(`end:${payload.name}`);
    });

    const first = run({ name: 'first', delayMs: 25 });
    const second = run({ name: 'second', delayMs: 0 });
    await Promise.all([first, second]);

    assert.deepStrictEqual(events, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
  });

  test('external property change applies only to matching docUri context', () => {
    const docUri = vscode.Uri.parse('file:///tmp/form-a/Ext/Form.xml');
    const wrongDocUri = 'file:///tmp/form-b/Ext/Form.xml';
    const model: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [
        { id: 'el-1', name: 'Element1', tag: 'InputField', properties: { Width: '120' }, childItems: [] },
      ],
    };
    const documentModel = new Map<string, FormModel>([[docUri.toString(), model]]);
    let posted = 0;
    const ctx: MessageHandlerContext = {
      document: { uri: docUri },
      webviewPanel: {
        title: '',
        webview: {
          postMessage: () => {
            posted += 1;
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel,
      documentModel,
      dirtyDocuments: new Set<string>(),
    };

    applyExternalPropertyChange(ctx, {
      docUri: wrongDocUri,
      entityType: 'element',
      entityId: 'el-1',
      scope: 'property',
      key: 'Width',
      value: '220',
    });
    assert.strictEqual(model.childItemsRoot[0].properties?.Width, '120', 'foreign docUri must be ignored');
    assert.strictEqual(posted, 0, 'ignored payload must not emit formData');

    applyExternalPropertyChange(ctx, {
      docUri: docUri.toString(),
      entityType: 'element',
      entityId: 'el-1',
      scope: 'property',
      key: 'Width',
      value: '220',
    });
    assert.strictEqual(model.childItemsRoot[0].properties?.Width, '220', 'matching docUri must apply');
    assert.ok(posted > 0, 'applied payload should emit formData');
  });

  test('addElementWizard rejects empty tag at message handler boundary', async () => {
    const docUri = vscode.Uri.parse('file:///tmp/form-a/Ext/Form.xml');
    const model: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [],
    };
    const posted: Array<Record<string, unknown>> = [];
    const ctx: MessageHandlerContext = {
      document: { uri: docUri },
      webviewPanel: {
        title: '',
        webview: {
          postMessage: (message: unknown) => {
            posted.push(message as Record<string, unknown>);
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel,
      documentModel: new Map<string, FormModel>([[docUri.toString(), model]]),
      dirtyDocuments: new Set<string>(),
    };

    await handleMessage(ctx, { type: 'addElementWizard', tag: '   ' });

    const error = posted.find((message) => message.type === 'error');
    assert.ok(error, 'empty/whitespace tag must be rejected');
    assert.strictEqual(model.childItemsRoot.length, 0, 'model must stay unchanged on validation error');
  });

  test('addElementWizard rejects non-string tag at message handler boundary', async () => {
    const docUri = vscode.Uri.parse('file:///tmp/form-a/Ext/Form.xml');
    const model: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [],
    };
    const posted: Array<Record<string, unknown>> = [];
    const ctx: MessageHandlerContext = {
      document: { uri: docUri },
      webviewPanel: {
        title: '',
        webview: {
          postMessage: (message: unknown) => {
            posted.push(message as Record<string, unknown>);
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel,
      documentModel: new Map<string, FormModel>([[docUri.toString(), model]]),
      dirtyDocuments: new Set<string>(),
    };

    await handleMessage(ctx, { type: 'addElementWizard', tag: 42 as unknown as string });

    const error = posted.find((message) => message.type === 'error');
    assert.ok(error, 'non-string tag must be rejected');
    assert.strictEqual(model.childItemsRoot.length, 0, 'model must stay unchanged on validation error');
  });

  test('addElementWizard rejects non-object propertiesPatch', async () => {
    const docUri = vscode.Uri.parse('file:///tmp/form-a/Ext/Form.xml');
    const model: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [],
    };
    const posted: Array<Record<string, unknown>> = [];
    const ctx: MessageHandlerContext = {
      document: { uri: docUri },
      webviewPanel: {
        title: '',
        webview: {
          postMessage: (message: unknown) => {
            posted.push(message as Record<string, unknown>);
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel,
      documentModel: new Map<string, FormModel>([[docUri.toString(), model]]),
      dirtyDocuments: new Set<string>(),
    };

    await handleMessage(ctx, { type: 'addElementWizard', tag: 'InputField', propertiesPatch: [] });

    const error = posted.find((message) => message.type === 'error');
    assert.ok(error, 'array propertiesPatch must be rejected');
    assert.strictEqual(model.childItemsRoot.length, 0, 'model must stay unchanged on validation error');
  });

  test('addElementWizard rejects null propertiesPatch', async () => {
    const docUri = vscode.Uri.parse('file:///tmp/form-a/Ext/Form.xml');
    const model: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [],
    };
    const posted: Array<Record<string, unknown>> = [];
    const ctx: MessageHandlerContext = {
      document: { uri: docUri },
      webviewPanel: {
        title: '',
        webview: {
          postMessage: (message: unknown) => {
            posted.push(message as Record<string, unknown>);
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel,
      documentModel: new Map<string, FormModel>([[docUri.toString(), model]]),
      dirtyDocuments: new Set<string>(),
    };

    await handleMessage(ctx, { type: 'addElementWizard', tag: 'InputField', propertiesPatch: null });

    const error = posted.find((message) => message.type === 'error');
    assert.ok(error, 'null propertiesPatch must be rejected');
    assert.strictEqual(model.childItemsRoot.length, 0, 'model must stay unchanged on validation error');
  });

  test('addElementWizard accepts trimmed tag and posts updated formData', async () => {
    const docUri = vscode.Uri.parse('file:///tmp/form-a/Ext/Form.xml');
    const model: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [],
    };
    const posted: Array<Record<string, unknown>> = [];
    const ctx: MessageHandlerContext = {
      document: { uri: docUri },
      webviewPanel: {
        title: '',
        webview: {
          postMessage: (message: unknown) => {
            posted.push(message as Record<string, unknown>);
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel,
      documentModel: new Map<string, FormModel>([[docUri.toString(), model]]),
      dirtyDocuments: new Set<string>(),
    };

    await handleMessage(ctx, {
      type: 'addElementWizard',
      tag: ' InputField ',
      propertiesPatch: { Width: '320' },
    });

    assert.strictEqual(model.childItemsRoot.length, 1, 'wizard should add one element');
    assert.strictEqual(model.childItemsRoot[0].tag, 'InputField', 'tag should be trimmed before apply');
    assert.strictEqual(model.childItemsRoot[0].properties?.Width, '320');
    assert.ok(
      posted.some((message) => message.type === 'formData'),
      'successful wizard add should publish updated formData'
    );
    assert.ok(
      !(posted.some((message) => message.type === 'error')),
      'valid payload should not trigger error post'
    );
  });
});
