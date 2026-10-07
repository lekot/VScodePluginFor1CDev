import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { resolveCommonPicture } from '../services/picture/commonPictureResolver';
import { Logger } from '../utils/logger';

export function registerPictureCommands(context: vscode.ExtensionContext): void {
  const openPictureCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openCommonPicture',
    async (node?: TreeNode) => {
      if (!node) {
        return;
      }
      try {
        const resolved = await resolveCommonPicture(node);
        if (!resolved.success || !resolved.resolvedFilePath) {
          vscode.window.showWarningMessage(
            resolved.error || `Не удалось найти файл изображения для «${node.name}»`
          );
          return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved.resolvedFilePath));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        Logger.error('Failed to open CommonPicture', err);
        vscode.window.showErrorMessage(`Ошибка при открытии картинки: ${msg}`);
      }
    }
  );

  context.subscriptions.push(openPictureCommand);
}
