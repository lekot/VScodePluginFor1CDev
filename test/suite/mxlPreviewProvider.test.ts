import * as assert from 'assert';
import * as vscode from 'vscode';
import { MxlPreviewProvider } from '../../src/mxlPreview/mxlPreviewProvider';
import { MetadataType } from '../../src/models/treeNode';

suite('MxlPreviewProvider', () => {
  const defaultAsRelativePath = (vscode.workspace as any).asRelativePath;
  const defaultShowWarning = (vscode.window as any).showWarningMessage;
  const defaultExecuteCommand = (vscode.commands as any).executeCommand.bind(vscode.commands);

  setup(() => {
    (vscode.workspace as any).asRelativePath = (uriOrPath: { fsPath?: string } | string): string =>
      typeof uriOrPath === 'string' ? uriOrPath : (uriOrPath.fsPath ?? '');
  });

  teardown(() => {
    (vscode.workspace as any).asRelativePath = defaultAsRelativePath;
    (vscode.window as any).showWarningMessage = defaultShowWarning;
    (vscode.commands as any).executeCommand = defaultExecuteCommand;
  });

  test('shows actionable parse-error fallback and opens source document', async () => {
    const provider = new MxlPreviewProvider();
    const uri = { fsPath: 'C:/tmp/broken.mxl' } as vscode.Uri;
    const selectedWarnings: string[] = [];
    const docStub = { uri };
    const openXmlCalls: Array<{ command: string; args: unknown[] }> = [];

    (provider as any).loader = {
      loadFromUri: async () => ({
        uri,
        sourceFormat: 'mxl',
        rawXml: '<bad',
        model: {
          version: 'v1',
          tables: [],
          diagnostics: [{ level: 'error', code: 'MXL_XML_PARSE_ERROR', message: 'broken xml' }],
        },
      }),
    };
    (vscode.window as any).showWarningMessage = async (message: string, ...items: string[]) => {
      selectedWarnings.push(message);
      return items[0];
    };

    (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
      openXmlCalls.push({ command, args });
      return {} as any;
    };

    const panel = {
      webview: { options: {}, html: '', cspSource: 'vscode-test-csp' },
      title: '',
    } as unknown as vscode.WebviewPanel;

    await provider.resolveCustomEditor({ uri, dispose: () => undefined } as any, panel);

    assert.ok(panel.webview.html.includes('MXL preview unavailable'));
    assert.strictEqual(selectedWarnings.length, 1);
    assert.ok(selectedWarnings[0].includes('blocking parser errors'));
    assert.strictEqual(openXmlCalls.length, 1);
    assert.strictEqual(openXmlCalls[0].command, '1c-metadata-tree.openXML');
    const fallbackNode = openXmlCalls[0].args[0] as any;
    assert.strictEqual(fallbackNode.type, MetadataType.Template);
    assert.strictEqual(fallbackNode.filePath, uri.fsPath);
    assert.ok(docStub.uri);
  });
});
