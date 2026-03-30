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

suite('form editor message handling regressions', () => {
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
