import * as vscode from 'vscode';

/**
 * Active file URI for the focused editor: text document or a custom tab with a `file` URI.
 */
export function getActiveFileUriForReveal(): vscode.Uri | undefined {
  const e = vscode.window.activeTextEditor;
  if (e && e.document.uri.scheme === 'file') {
    return e.document.uri;
  }
  const group = vscode.window.tabGroups?.activeTabGroup;
  const tab = group?.activeTab;
  if (!tab) {
    return undefined;
  }
  const input = tab.input;
  if (isTabInputTextDiffLike(input)) {
    if (input.modified?.scheme === 'file') {
      return input.modified;
    }
  }
  if (input && typeof input === 'object' && 'uri' in input) {
    const u = (input as { uri: vscode.Uri }).uri;
    if (u instanceof vscode.Uri && u.scheme === 'file') {
      return u;
    }
  }
  return undefined;
}

type TabDiffLike = { readonly original: vscode.Uri; readonly modified: vscode.Uri };

function isTabInputTextDiffLike(
  x: unknown
): x is TabDiffLike {
  if (!x || typeof x !== 'object' || !('original' in x) || !('modified' in x)) {
    return false;
  }
  const o = x as { original: unknown; modified: unknown };
  return o.modified instanceof vscode.Uri;
}
