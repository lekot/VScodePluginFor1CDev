import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { QueryBuilderProvider } from './queryBuilderProvider';

export function registerQueryBuilderCommands(
  context: vscode.ExtensionContext,
  deps: { state: ExtensionState }
): vscode.Disposable[] {
  const provider = new QueryBuilderProvider(context, deps.state);

  const openSimple = vscode.commands.registerCommand(
    '1c-metadata-tree.queryBuilder',
    async () => {
      await provider.open(vscode.window.activeTextEditor, 'simple');
    }
  );

  const openWithProcessing = vscode.commands.registerCommand(
    '1c-metadata-tree.queryBuilderWithProcessing',
    async () => {
      await provider.open(vscode.window.activeTextEditor, 'withProcessing');
    }
  );

  return [openSimple, openWithProcessing];
}