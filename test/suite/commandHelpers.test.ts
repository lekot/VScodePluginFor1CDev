import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';
import { getSelectedNode, requireDesignerFormat } from '../../src/helpers/commandHelpers';
import { MetadataType, TreeNode } from '../../src/models/treeNode';

suite('commandHelpers', () => {
  const originalDetect = FormatDetector.detect;
  const defaultShowWarning = vscode.window.showWarningMessage.bind(vscode.window);
  const defaultShowInformation = vscode.window.showInformationMessage.bind(vscode.window);

  setup(() => {
    (vscode.window as any).showWarningMessage = defaultShowWarning;
    (vscode.window as any).showInformationMessage = defaultShowInformation;
  });

  teardown(() => {
    (FormatDetector as any).detect = originalDetect;
    (vscode.window as any).showWarningMessage = defaultShowWarning;
    (vscode.window as any).showInformationMessage = defaultShowInformation;
  });

  test('getSelectedNode prefers command argument', () => {
    const selected: TreeNode = {
      id: 'sel',
      name: 'Selected',
      type: MetadataType.Catalog,
      properties: {},
    };
    const arg: TreeNode = {
      id: 'arg',
      name: 'ArgNode',
      type: MetadataType.Document,
      properties: {},
    };
    const state = { treeView: { selection: [selected] } } as any;
    assert.strictEqual(getSelectedNode(state, arg), arg);
  });

  test('getSelectedNode falls back to tree selection', () => {
    const selected: TreeNode = {
      id: 'sel',
      name: 'Selected',
      type: MetadataType.Catalog,
      properties: {},
    };
    const state = { treeView: { selection: [selected] } } as any;
    assert.strictEqual(getSelectedNode(state), selected);
  });

  test('requireDesignerFormat returns null and warns when config path is missing', async () => {
    const warnCalls: string[] = [];
    (vscode.window as any).showWarningMessage = async (msg: string) => {
      warnCalls.push(msg);
      return undefined;
    };
    (vscode.window as any).showInformationMessage = async () => undefined;

    const target: TreeNode = { id: 'n', name: 'N', type: MetadataType.Catalog, properties: {} };
    const state = { treeDataProvider: { getConfigPathForNode: () => undefined, getConfigPath: () => undefined } } as any;

    const result = await requireDesignerFormat(state, target, {
      notLoadedMessage: 'NO_CONFIG',
      nonDesignerMessage: 'NOT_DESIGNER',
    });

    assert.strictEqual(result, null);
    assert.deepStrictEqual(warnCalls, ['NO_CONFIG']);
  });

  test('requireDesignerFormat returns null and info for non-designer format', async () => {
    const infoCalls: string[] = [];
    (vscode.window as any).showWarningMessage = async () => undefined;
    (vscode.window as any).showInformationMessage = async (msg: string) => {
      infoCalls.push(msg);
      return undefined;
    };
    (FormatDetector as any).detect = async () => ConfigFormat.EDT;

    const target: TreeNode = { id: 'n', name: 'N', type: MetadataType.Catalog, properties: {} };
    const state = { treeDataProvider: { getConfigPathForNode: () => 'C:/cfg', getConfigPath: () => 'C:/cfg' } } as any;

    const result = await requireDesignerFormat(state, target, {
      notLoadedMessage: 'NO_CONFIG',
      nonDesignerMessage: 'NOT_DESIGNER',
    });

    assert.strictEqual(result, null);
    assert.deepStrictEqual(infoCalls, ['NOT_DESIGNER']);
  });
});
