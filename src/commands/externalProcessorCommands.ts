import * as vscode from 'vscode';
import {
  buildExternalProcessor,
  dumpExternalProcessor,
} from '../services/externalProcessor/externalProcessorService';

export function registerExternalProcessorCommands(context: vscode.ExtensionContext): void {
  const dumpCmd = vscode.commands.registerCommand(
    '1c-metadata-tree.dumpExternalProcessor',
    async (uri?: vscode.Uri) => {
      let targetPath = uri?.fsPath;
      if (!targetPath) {
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { '1C External Processors / Reports': ['epf', 'erf'] },
          openLabel: 'Выберите файл обработки/отчёта',
        });
        if (!files || files.length === 0) {
          return;
        }
        targetPath = files[0].fsPath;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Разборка внешней обработки...',
          cancellable: false,
        },
        async () => {
          const res = await dumpExternalProcessor({
            externalFilePath: targetPath!,
            directoryPath: `${targetPath}_src`,
          });
          if (res.success) {
            vscode.window.showInformationMessage(`Обработка успешно разобрана в: ${targetPath}_src`);
          } else {
            vscode.window.showErrorMessage(`Ошибка разборки обработки: ${res.message}`);
          }
        }
      );
    }
  );

  const buildCmd = vscode.commands.registerCommand(
    '1c-metadata-tree.buildExternalProcessor',
    async (uri?: vscode.Uri) => {
      let targetPath = uri?.fsPath;
      if (!targetPath) {
        const folders = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Выберите каталог XML-исходников',
        });
        if (!folders || folders.length === 0) {
          return;
        }
        targetPath = folders[0].fsPath;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Сборка внешней обработки...',
          cancellable: false,
        },
        async () => {
          const epfPath = `${targetPath}_built.epf`;
          const res = await buildExternalProcessor({
            externalFilePath: epfPath,
            directoryPath: targetPath!,
          });
          if (res.success) {
            vscode.window.showInformationMessage(`Обработка успешно собрана: ${epfPath}`);
          } else {
            vscode.window.showErrorMessage(`Ошибка сборки обработки: ${res.message}`);
          }
        }
      );
    }
  );

  context.subscriptions.push(dumpCmd, buildCmd);
}
