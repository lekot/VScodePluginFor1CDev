import * as assert from 'assert';
import * as vscode from 'vscode';
import { FormEditorProvider } from '../../src/formEditor/formEditorProvider';
import type { FormModel } from '../../src/formEditor/formModel';
import type { MessageHandlerContext } from '../../src/formEditor/formMessageHandler';

suite('FormEditorProvider routing guards', () => {
  test('property change is routed only to active docUri context', () => {
    const provider = new FormEditorProvider();
    const docA = 'file:///form-a/Ext/Form.xml';
    const docB = 'file:///form-b/Ext/Form.xml';
    const modelA: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [
        { id: 'el-a', name: 'ElementA', tag: 'InputField', properties: { Width: '100' }, childItems: [] },
      ],
    };
    const modelB: FormModel = {
      attributes: [],
      commands: [],
      formEvents: [],
      childItemsRoot: [
        { id: 'el-b', name: 'ElementB', tag: 'InputField', properties: { Width: '200' }, childItems: [] },
      ],
    };

    const contexts = new Map<string, MessageHandlerContext>([
      [
        docA,
        {
          document: { uri: vscode.Uri.parse(docA) },
          webviewPanel: {
            title: '',
            webview: { postMessage: () => Promise.resolve(true) },
          } as unknown as vscode.WebviewPanel,
          documentModel: new Map([[docA, modelA]]),
          dirtyDocuments: new Set<string>(),
        },
      ],
      [
        docB,
        {
          document: { uri: vscode.Uri.parse(docB) },
          webviewPanel: {
            title: '',
            webview: { postMessage: () => Promise.resolve(true) },
          } as unknown as vscode.WebviewPanel,
          documentModel: new Map([[docB, modelB]]),
          dirtyDocuments: new Set<string>(),
        },
      ],
    ]);

    (provider as any).contextByDocument = contexts;
    (provider as any).activeSelectionDocumentUri = docA;
    (provider as any).latestSelectionByDocument = new Map([
      [docA, { entityType: 'element', entityId: 'el-a', entityName: 'ElementA' }],
      [docB, { entityType: 'element', entityId: 'el-b', entityName: 'ElementB' }],
    ]);

    provider.applySelectionPropertyChange({
      docUri: docB,
      entityType: 'element',
      entityId: 'el-b',
      scope: 'property',
      key: 'Width',
      value: '250',
    });
    assert.strictEqual(modelB.childItemsRoot[0].properties?.Width, '200', 'inactive docUri payload must be ignored');

    provider.applySelectionPropertyChange({
      docUri: docA,
      entityType: 'element',
      entityId: 'el-a',
      scope: 'property',
      key: 'Width',
      value: '130',
    });
    assert.strictEqual(modelA.childItemsRoot[0].properties?.Width, '130', 'active docUri payload must apply');
  });
});
