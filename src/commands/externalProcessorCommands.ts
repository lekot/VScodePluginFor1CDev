import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildExternalProcessor,
  dumpExternalProcessor,
  inspectExternalProcessorRoot,
} from '../services/externalProcessor/externalProcessorService';
import type {
  ExternalProcessorExecutionContext,
  ExternalProcessorOperationResult,
} from '../services/externalProcessor/externalProcessorTypes';
import type { StreamCancellation } from '../services/process/streamingProcessRunner';

interface ContextChoice extends vscode.QuickPickItem {
  readonly contextKind: ExternalProcessorExecutionContext['kind'];
}

export function registerExternalProcessorCommands(context: vscode.ExtensionContext): void {
  const dumpCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.dumpExternalProcessor',
    async (uri?: vscode.Uri) => {
      const source = uri ?? await pickExternalFile();
      if (!source) {
        return;
      }
      const extension = path.extname(source.fsPath).toLocaleLowerCase();
      if (extension !== '.epf' && extension !== '.erf') {
        void vscode.window.showErrorMessage('Выберите файл внешней обработки .epf или отчёта .erf.');
        return;
      }
      const defaultOutput = path.join(
        path.dirname(source.fsPath),
        `${path.basename(source.fsPath, extension)}_src`
      );
      const outputDirectory = await vscode.window.showInputBox({
        title: 'Разборка внешней обработки или отчёта',
        prompt: 'Укажите новый каталог для XML-исходников',
        value: defaultOutput,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : 'Путь к каталогу обязателен.',
      });
      if (outputDirectory === undefined) {
        return;
      }
      const format = await vscode.window.showQuickPick(
        [
          { label: 'Hierarchical', description: 'Иерархическая структура каталогов' },
          { label: 'Plain', description: 'Плоская структура файлов' },
        ] as const,
        {
          title: 'Формат XML-исходников',
          placeHolder: 'Выберите формат разборки',
          ignoreFocusOut: true,
        }
      );
      if (!format) {
        return;
      }
      const executionContext = await pickExecutionContext();
      if (!executionContext) {
        return;
      }
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Разборка внешней обработки или отчёта…',
          cancellable: true,
        },
        (_progress, token) => dumpExternalProcessor({
          externalFilePath: source.fsPath,
          outputDirectory: path.resolve(outputDirectory),
          format: format.label,
          context: executionContext,
          cancellation: toStreamCancellation(token),
        })
      );
      showOperationResult(result, 'XML-исходники созданы');
    }
  );

  const buildCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.buildExternalProcessor',
    async (uri?: vscode.Uri) => {
      const rootXml = uri ?? await pickRootXml();
      if (!rootXml) {
        return;
      }
      if (path.extname(rootXml.fsPath).toLocaleLowerCase() !== '.xml') {
        void vscode.window.showErrorMessage('Выберите корневой XML внешней обработки или отчёта.');
        return;
      }
      let root: Awaited<ReturnType<typeof inspectExternalProcessorRoot>>;
      try {
        root = await inspectExternalProcessorRoot(rootXml.fsPath);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Не удалось определить тип внешнего объекта: ${errorMessage(error)}`
        );
        return;
      }
      const destination = await vscode.window.showSaveDialog({
        title: root.kind === 'ExternalReport'
          ? 'Собрать внешний отчёт'
          : 'Собрать внешнюю обработку',
        defaultUri: vscode.Uri.file(root.defaultDestinationPath),
        filters: root.extension === '.erf'
          ? { 'Внешний отчёт 1С': ['erf'] }
          : { 'Внешняя обработка 1С': ['epf'] },
        saveLabel: 'Собрать',
      });
      if (!destination) {
        return;
      }
      const executionContext = await pickExecutionContext();
      if (!executionContext) {
        return;
      }
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: root.kind === 'ExternalReport'
            ? 'Сборка внешнего отчёта…'
            : 'Сборка внешней обработки…',
          cancellable: true,
        },
        (_progress, token) => buildExternalProcessor({
          rootXmlPath: rootXml.fsPath,
          destinationPath: destination.fsPath,
          context: executionContext,
          cancellation: toStreamCancellation(token),
        })
      );
      showOperationResult(result, 'Внешний файл собран');
    }
  );

  context.subscriptions.push(dumpCommand, buildCommand);
}

async function pickExternalFile(): Promise<vscode.Uri | undefined> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'Внешние обработки и отчёты 1С': ['epf', 'erf'] },
    openLabel: 'Разобрать',
  });
  return selected?.[0];
}

async function pickRootXml(): Promise<vscode.Uri | undefined> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'Корневой XML внешнего объекта': ['xml'] },
    openLabel: 'Собрать',
  });
  return selected?.[0];
}

async function pickExecutionContext(): Promise<ExternalProcessorExecutionContext | undefined> {
  const choice = await vscode.window.showQuickPick<ContextChoice>(
    [
      {
        contextKind: 'infobase',
        label: 'Файловая информационная база',
        description: 'Сохранить ссылочные типы в контексте существующей ИБ',
      },
      {
        contextKind: 'standalone',
        label: 'Автономный режим',
        description: 'Без ИБ; ссылочные типы конфигурации могут быть потеряны',
      },
    ],
    {
      title: 'Контекст пакетного Конфигуратора',
      placeHolder: 'Выберите ровно один контекст выполнения',
      ignoreFocusOut: true,
    }
  );
  if (!choice) {
    return undefined;
  }
  if (choice.contextKind === 'standalone') {
    const confirmation = await vscode.window.showWarningMessage(
      'В автономном режиме ссылочные типы конфигурации могут быть необратимо заменены примитивными. Продолжить?',
      { modal: true },
      'Продолжить'
    );
    return confirmation === 'Продолжить'
      ? { kind: 'standalone', acknowledgeTypeLoss: true }
      : undefined;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать файловую ИБ',
    title: 'Выберите каталог, содержащий 1Cv8.1CD',
  });
  const infobaseDirectory = selected?.[0];
  if (!infobaseDirectory) {
    return undefined;
  }
  try {
    const databaseFile = await vscode.workspace.fs.stat(
      vscode.Uri.file(path.join(infobaseDirectory.fsPath, '1Cv8.1CD'))
    );
    if ((databaseFile.type & vscode.FileType.File) === 0) {
      throw new Error('1Cv8.1CD не является файлом.');
    }
  } catch {
    void vscode.window.showErrorMessage('В выбранном каталоге нет файла информационной базы 1Cv8.1CD.');
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title: 'Аутентификация информационной базы',
    prompt: 'Имя пользователя 1С; оставьте пустым, если аутентификация не требуется',
    ignoreFocusOut: true,
  });
  if (user === undefined) {
    return undefined;
  }
  const normalizedUser = user.trim();
  if (!normalizedUser) {
    return {
      kind: 'infobase',
      infobasePath: infobaseDirectory.fsPath,
    };
  }
  const password = await vscode.window.showInputBox({
    title: 'Аутентификация информационной базы',
    prompt: 'Пароль пользователя 1С',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }
  return {
    kind: 'infobase',
    infobasePath: infobaseDirectory.fsPath,
    credentials: {
      user: normalizedUser,
      password,
    },
  };
}

function toStreamCancellation(token: vscode.CancellationToken): StreamCancellation {
  return {
    get isCancellationRequested() {
      return token.isCancellationRequested;
    },
    onCancellationRequested: (listener) => token.onCancellationRequested(listener),
  };
}

function showOperationResult(result: ExternalProcessorOperationResult, successTitle: string): void {
  if (result.state === 'completed') {
    const warning = result.warning ? `. ${result.warning}` : '';
    void vscode.window.showInformationMessage(
      `${successTitle}: ${result.artifactPath}${warning}`
    );
    return;
  }
  if (result.state === 'inDoubt') {
    const effectLocation = result.publishedArtifactPath
      ? `Возможный опубликованный результат: ${result.publishedArtifactPath}. Staging/evidence: ${result.stagingPath}`
      : `Возможное место результата — staging: ${result.stagingPath}`;
    void vscode.window.showWarningMessage(
      `Исход операции не подтверждён: ${result.message} ${effectLocation}`,
      { modal: true }
    );
    return;
  }
  void vscode.window.showErrorMessage(`${result.message} (${result.code})`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
