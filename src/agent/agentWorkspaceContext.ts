import * as path from 'path';
import * as vscode from 'vscode';
import { isSameOrDescendantPath } from '../utils/configurationPathIdentity';

/**
 * Finds the exact workspace folder containing targetPath without arbitrary fallbacks.
 * When folders are nested, selects the deepest/most specific enclosing workspace folder.
 * Handles Windows case-insensitivity and path normalization.
 */
export function findWorkspaceFolderForPath(targetPath: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0 || !targetPath) {
    return undefined;
  }

  // 1. Try native vscode.workspace.getWorkspaceFolder
  let nativeCandidate: vscode.WorkspaceFolder | undefined;
  try {
    nativeCandidate = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetPath));
  } catch {
    // ignore URI parsing errors
  }

  // 2. Select the deepest/most specific enclosing workspace folder (longest matching path)
  let bestFolder = nativeCandidate;
  let bestLength = nativeCandidate ? path.resolve(nativeCandidate.uri.fsPath).length : -1;

  for (const folder of folders) {
    if (!folder?.uri?.fsPath) {
      continue;
    }
    if (isSameOrDescendantPath(folder.uri.fsPath, targetPath)) {
      const len = path.resolve(folder.uri.fsPath).length;
      if (len > bestLength) {
        bestFolder = folder;
        bestLength = len;
      }
    }
  }

  return bestFolder;
}
