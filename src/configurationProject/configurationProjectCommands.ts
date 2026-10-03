import * as path from 'path';
import * as vscode from 'vscode';
import { validateElementName } from '../utils/elementNameValidator';
import {
  ConfigurationProjectService,
  type ConfigurationProjectLanguage,
} from './configurationProjectService';

export const CREATE_CONFIGURATION_PROJECT_COMMAND = '1c-metadata-tree.configuration.createProject';

export interface RegisterConfigurationProjectCommandsOptions {
  readonly context: vscode.ExtensionContext;
  readonly refreshTree: () => Promise<void>;
  readonly createService?: () => ConfigurationProjectService;
}

/** VS Code adapter for creating a base Configuration root in the selected workspace folder. */
export function registerConfigurationProjectCommands(
  options: RegisterConfigurationProjectCommandsOptions,
): void {
  const command = vscode.commands.registerCommand(CREATE_CONFIGURATION_PROJECT_COMMAND, async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      await vscode.window.showWarningMessage('Откройте папку workspace, чтобы создать проект конфигурации.');
      return undefined;
    }

    const folder = workspaceFolders.length === 1
      ? workspaceFolders[0]
      : await vscode.window.showQuickPick(
        workspaceFolders.map((workspaceFolder) => ({
          label: workspaceFolder.name,
          description: workspaceFolder.uri.fsPath,
          workspaceFolder,
        })),
        { placeHolder: 'Выберите папку workspace для новой конфигурации', ignoreFocusOut: true },
      ).then((selection) => selection?.workspaceFolder);
    if (!folder) {
      return undefined;
    }

    const name = await vscode.window.showInputBox({
      title: 'Создать проект конфигурации',
      prompt: 'Имя основной конфигурации',
      placeHolder: 'МояКонфигурация',
      ignoreFocusOut: true,
      validateInput: (value) => validateElementName(value.trim(), []) ?? undefined,
    });
    if (name === undefined) {
      return undefined;
    }
    const trimmedName = name.trim();

    const language = await vscode.window.showQuickPick([
      { label: 'Русский', description: 'По умолчанию', value: 'ru' as const },
      { label: 'English', value: 'en' as const },
    ], { placeHolder: 'Основной язык конфигурации', ignoreFocusOut: true });
    if (!language) {
      return undefined;
    }

    let outcome: Awaited<ReturnType<ConfigurationProjectService['createProject']>>;
    try {
      outcome = await (options.createService?.() ?? new ConfigurationProjectService()).createProject({
        workspaceRoot: folder.uri.fsPath,
        targetRelativePath: trimmedName,
        name: trimmedName,
        language: language.value as ConfigurationProjectLanguage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Не удалось создать проект конфигурации: ${message}`);
      return undefined;
    }

    try {
      await options.refreshTree();
    } catch {
      await vscode.window.showWarningMessage(
        `Проект конфигурации «${trimmedName}» создан, но дерево не удалось обновить. Обновите дерево вручную.`,
      );
      return outcome;
    }

    await vscode.window.showInformationMessage(
      `Создан проект конфигурации «${trimmedName}» в ${path.join(folder.uri.fsPath, trimmedName)}.`,
    );
    return outcome;
  });

  options.context.subscriptions.push(command);
}
