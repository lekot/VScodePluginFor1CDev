import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Finds the exact workspace folder containing targetPath without arbitrary fallbacks.
 * Handles Windows case-insensitivity and path normalization.
 */
export function findWorkspaceFolderForPath(targetPath: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0 || !targetPath) {
    return undefined;
  }

  // 1. Try native vscode.workspace.getWorkspaceFolder
  try {
    const uriFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetPath));
    if (uriFolder) {
      return uriFolder;
    }
  } catch {
    // ignore URI parsing errors
  }

  // 2. Lexical prefix matching (handles case differences and trailing slashes on Windows)
  const isWin = process.platform === 'win32';
  const resolvedTarget = path.resolve(targetPath);
  const targetNorm = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;

  for (const folder of folders) {
    const resolvedFolder = path.resolve(folder.uri.fsPath);
    const folderNorm = isWin ? resolvedFolder.toLowerCase() : resolvedFolder;
    if (targetNorm === folderNorm || targetNorm.startsWith(folderNorm + path.sep)) {
      return folder;
    }
  }

  return undefined;
}
