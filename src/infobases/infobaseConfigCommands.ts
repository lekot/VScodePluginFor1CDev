import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InfobaseEntry } from './models/infobaseEntry';
import type { InfobaseStorageService } from './infobaseStorageService';
import { prepareIbcmdConfigYaml } from './ibcmdConfigPathResolver';
import {
  buildInfobaseConfigCheckArgs,
  buildInfobaseConfigExportArgs,
  buildInfobaseConfigImportArgs,
} from '../services/ibcmd/ibcmdInfobaseConfigArgs';
import {
  interpretIbcmdInfobaseOutcome,
  type IbcmdInfobaseConfigOpKind,
  type IbcmdInfobaseOperationResult,
} from '../services/ibcmd/ibcmdInfobaseOperationResult';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { runIbcmdStreaming, type IbcmdStreamCancellation } from '../services/ibcmd/IbcmdStreamingRunner';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';

const OUTPUT_CHANNEL_NAME = 'CDT 41: Infobase (ibcmd)';
const OUTPUT_DEBOUNCE_MS = 75;
const TRUNCATION_WARNING =
  '[ibcmd] Вывод усечён из‑за лимита буфера (см. IbcmdStreamingRunner). Полный журнал недоступен в канале.';

let outputChannel: vscode.OutputChannel | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingOutput = '';

/** Serializes ibcmd config ops (design §8 NFR). */
let configOpChain: Promise<unknown> = Promise.resolve();

export function serializeInfobaseConfigIbcmdOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = configOpChain.then(() => fn());
  configOpChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel;
}

/** Для WOW §2D: открыть канал вывода ibcmd после раскатки. */
export function showIbcmdInfobaseOutputChannel(): void {
  getOutputChannel().show(true);
}

/** Строка в канал Infobase (ibcmd) без показа панели — итог по шагу раскатки и т.п. */
export function appendIbcmdOutputLine(line: string): void {
  getOutputChannel().appendLine(line);
}

function appendOutputDebounced(chunk: string): void {
  if (!chunk) {
    return;
  }
  pendingOutput += chunk;
  if (debounceTimer !== undefined) {
    return;
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    const ch = getOutputChannel();
    if (pendingOutput) {
      ch.append(pendingOutput);
      pendingOutput = '';
    }
  }, OUTPUT_DEBOUNCE_MS);
}

function flushOutputChannel(): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  const ch = getOutputChannel();
  if (pendingOutput) {
    ch.append(pendingOutput);
    pendingOutput = '';
  }
}

function vscodeCancellation(token: vscode.CancellationToken): IbcmdStreamCancellation {
  return {
    isCancellationRequested: token.isCancellationRequested,
    onCancellationRequested: (listener) => token.onCancellationRequested(listener),
  };
}

function findWorkspaceConfigurationRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  for (const f of folders) {
    const cfg = path.join(f.uri.fsPath, 'Configuration.xml');
    if (fs.existsSync(cfg)) {
      return f.uri.fsPath;
    }
  }
  return undefined;
}

async function pickImportSourcePath(): Promise<string | undefined> {
  const wsRoot = findWorkspaceConfigurationRoot();
  type Pick = vscode.QuickPickItem & { _kind: 'workspace' | 'browse' };
  const items: Pick[] = [];
  if (wsRoot) {
    items.push({
      label: '$(folder-opened) Текущий workspace',
      description: wsRoot,
      _kind: 'workspace',
    });
  }
  items.push({
    label: '$(file-directory) Выбрать папку…',
    description: 'Каталог выгрузки конфигурации',
    _kind: 'browse',
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Источник выгрузки конфигурации',
    placeHolder: 'Выберите каталог с Configuration.xml / выгрузкой',
  });
  if (!picked) {
    return undefined;
  }
  if (picked._kind === 'workspace') {
    return wsRoot;
  }
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать каталог выгрузки',
    title: 'Каталог выгрузки для import',
  });
  return dirs?.[0]?.fsPath;
}

async function pickExportOutDirectory(): Promise<string | undefined> {
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать папку',
    title: 'Папка для выгрузки конфигурации',
  });
  return dirs?.[0]?.fsPath;
}

async function confirmOverwriteIfNonEmpty(dir: string): Promise<boolean> {
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return true;
  }
  if (entries.length === 0) {
    return true;
  }
  const pick = await vscode.window.showWarningMessage(
    `Папка не пуста (${entries.length} элементов). ibcmd может перезаписать файлы. Продолжить?`,
    { modal: true },
    'Продолжить',
    'Отмена',
  );
  return pick === 'Продолжить';
}

async function ensureStorage(
  storage: InfobaseStorageService | null,
): Promise<InfobaseStorageService | undefined> {
  if (!storage) {
    void vscode.window.showErrorMessage('Infobase Manager: хранилище не инициализировано.');
    return undefined;
  }
  return storage;
}

/**
 * Загрузка конфигурации из фиксированного каталога выгрузки (WOW §2D DeployService).
 * Без модальных диалогов — результат для агрегирования в отчёте.
 */
export async function runInfobaseConfigImportFromDirectory(params: {
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  absoluteSourceDir: string;
  token: vscode.CancellationToken;
  /** Подзаголовок в канале вывода (например «раскатка»). */
  logContext?: string;
}): Promise<IbcmdInfobaseOperationResult> {
  const ibcmd = getIbcmdService();
  const pathResult = ibcmd.resolveExecutablePath();
  if (pathResult.kind !== 'resolved') {
    return {
      status: 'error',
      exitCode: null,
      userMessage:
        'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.',
      logExcerpt: '',
    };
  }

  const prep = await prepareIbcmdConfigYaml(params.entry, (id) => params.storage.readPasswordSecret(id));
  if (!prep.ok) {
    return {
      status: 'error',
      exitCode: null,
      userMessage: prep.userMessage,
      logExcerpt: '',
    };
  }

  const ch = getOutputChannel();
  const ctx = params.logContext?.trim() ? ` ${params.logContext.trim()}` : '';
  ch.appendLine(`[import${ctx}] ${params.entry.name} (${new Date().toISOString()})\n`);

  try {
    const outcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: buildInfobaseConfigImportArgs(prep.absoluteConfigPath, path.resolve(params.absoluteSourceDir)),
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
    });

    flushOutputChannel();

    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (outcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    return interpretIbcmdInfobaseOutcome('import', outcome);
  } finally {
    flushOutputChannel();
    await prep.dispose();
  }
}

async function runInfobaseConfigOperation(params: {
  op: IbcmdInfobaseConfigOpKind;
  entry: InfobaseEntry;
  storage: InfobaseStorageService;
  progressTitle: string;
  argsForConfigPath: (absConfigPath: string) => string[];
}): Promise<void> {
  const ibcmd = getIbcmdService();
  const pathResult = ibcmd.resolveExecutablePath();
  if (pathResult.kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const prep = await prepareIbcmdConfigYaml(params.entry, (id) => params.storage.readPasswordSecret(id));
  if (!prep.ok) {
    if (prep.code === 'WEB_NOT_SUPPORTED') {
      void vscode.window.showWarningMessage(prep.userMessage);
    } else {
      void vscode.window.showErrorMessage(prep.userMessage);
    }
    return;
  }

  const ch = getOutputChannel();
  const header = `[${params.op}] ${params.entry.name} (${new Date().toISOString()})\n`;
  ch.appendLine(header);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: params.progressTitle,
        cancellable: true,
      },
      async (_progress, token) => {
        const outcome = await runIbcmdStreaming({
          executablePath: pathResult.path,
          args: params.argsForConfigPath(prep.absoluteConfigPath),
          timeoutMs: ibcmd.getTimeoutMs(),
          cancellation: vscodeCancellation(token),
          onStreamChunk: (chunk) => appendOutputDebounced(chunk),
        });

        flushOutputChannel();

        if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
          ibcmd.invalidatePathCache();
        }

        if (outcome.logTruncated) {
          ch.appendLine(TRUNCATION_WARNING);
        }

        const interpreted = interpretIbcmdInfobaseOutcome(params.op, outcome);
        const showOutput = 'Показать вывод';
        if (interpreted.status === 'success') {
          const r = await vscode.window.showInformationMessage(interpreted.userMessage, showOutput);
          if (r === showOutput) {
            ch.show(true);
          }
        } else if (interpreted.status === 'cancelled') {
          void vscode.window.showWarningMessage(interpreted.userMessage);
        } else {
          const r = await vscode.window.showErrorMessage(interpreted.userMessage, showOutput);
          if (r === showOutput) {
            ch.show(true);
          }
        }
      },
    );
  } finally {
    flushOutputChannel();
    await prep.dispose();
  }
}

function assertFileOrServer(entry: InfobaseEntry): boolean {
  if (entry.type === 'web') {
    void vscode.window.showWarningMessage(
      'Операции import/export/check через ibcmd не поддерживаются для веб-базы. Используйте файловую или серверную запись.',
    );
    return false;
  }
  return true;
}

export async function runInfobaseConfigImport(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorage(storage);
  if (!s || !entry) {
    if (entry === undefined && s) {
      void vscode.window.showWarningMessage('Загрузить конфигурацию: выберите базу в дереве Infobase Manager.');
    }
    return;
  }
  if (!assertFileOrServer(entry)) {
    return;
  }

  await serializeInfobaseConfigIbcmdOp(async () => {
    const source = await pickImportSourcePath();
    if (!source) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      'Конфигурация в информационной базе будет перезаписана. Продолжить?',
      { modal: true },
      'Продолжить',
    );
    if (ok !== 'Продолжить') {
      return;
    }
    await runInfobaseConfigOperation({
      op: 'import',
      entry,
      storage: s,
      progressTitle: `Загрузка конфигурации: ${entry.name}`,
      argsForConfigPath: (cfg) => buildInfobaseConfigImportArgs(cfg, path.resolve(source)),
    });
  });
}

export async function runInfobaseConfigExport(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorage(storage);
  if (!s || !entry) {
    if (entry === undefined && s) {
      void vscode.window.showWarningMessage('Выгрузить конфигурацию: выберите базу в дереве Infobase Manager.');
    }
    return;
  }
  if (!assertFileOrServer(entry)) {
    return;
  }

  await serializeInfobaseConfigIbcmdOp(async () => {
    const outDir = await pickExportOutDirectory();
    if (!outDir) {
      return;
    }
    const absOut = path.resolve(outDir);
    if (!(await confirmOverwriteIfNonEmpty(absOut))) {
      return;
    }
    await runInfobaseConfigOperation({
      op: 'export',
      entry,
      storage: s,
      progressTitle: `Выгрузка конфигурации: ${entry.name}`,
      argsForConfigPath: (cfg) => buildInfobaseConfigExportArgs(cfg, absOut),
    });
  });
}

export async function runInfobaseConfigCheck(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorage(storage);
  if (!s || !entry) {
    if (entry === undefined && s) {
      void vscode.window.showWarningMessage('Проверить конфигурацию: выберите базу в дереве Infobase Manager.');
    }
    return;
  }
  if (!assertFileOrServer(entry)) {
    return;
  }

  await serializeInfobaseConfigIbcmdOp(async () => {
    await runInfobaseConfigOperation({
      op: 'check',
      entry,
      storage: s,
      progressTitle: `Проверка конфигурации: ${entry.name}`,
      argsForConfigPath: (cfg) => buildInfobaseConfigCheckArgs(cfg),
    });
  });
}
