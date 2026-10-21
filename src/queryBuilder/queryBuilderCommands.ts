import * as vscode from 'vscode';
import type { QueryBuilderContext } from '../extension/extensionFeatureContexts';
import { QueryBuilderProvider } from './queryBuilderProvider';
import { QUERY_BUILDER_FOR_TEXT_COMMAND } from './queryBuilderCommandIds';

export function registerQueryBuilderCommands(
  context: vscode.ExtensionContext,
  deps: { state: QueryBuilderContext }
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

  // Internal (not in the palette): the builder over a query text that is not
  // in a text editor; resolves with the saved text or undefined.
  const openForText = vscode.commands.registerCommand(
    QUERY_BUILDER_FOR_TEXT_COMMAND,
    (text: unknown, fileUri?: unknown) =>
      provider.openText(
        typeof text === 'string' ? text : '',
        fileUri instanceof vscode.Uri ? fileUri : undefined
      )
  );

  return [openSimple, openWithProcessing, openForText];
}
