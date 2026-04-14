import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIGURATION_XML } from '../constants/fileNames';
import type { InfobaseEntry } from './models/infobaseEntry';
import type { InfobaseStorageService } from './infobaseStorageService';
import {
  IB_FILE_IBCMD_WEB_UNSUPPORTED_RU,
  type PreparedIbcmdFileDb,
  type PreparedIbcmdYaml,
  prepareIbcmdConfigYaml,
  redactIbcmdYamlPasswordLines,
  resolvePathForIbcmdYamlFileField,
  tryParseInfobaseFileScalarFromYaml,
} from './ibcmdConfigPathResolver';

type PreparedIbcmdConnectionOk = PreparedIbcmdYaml | PreparedIbcmdFileDb;
import {
  buildInfobaseConfigApplyArgs,
  buildInfobaseConfigCheckArgs,
  buildInfobaseConfigExportArgs,
  buildInfobaseConfigExportObjectsArgs,
  buildInfobaseConfigImportArgs,
  buildInfobaseConfigImportFilesArgs,
  buildInfobaseConfigExportStatusArgs,
  ibcmdOfflineConnectionFromPrepared,
  type IbcmdConfigCliCredentials,
} from '../services/ibcmd/ibcmdInfobaseConfigArgs';
import {
  interpretIbcmdInfobaseOutcome,
  type IbcmdInfobaseConfigOpKind,
  type IbcmdInfobaseOperationResult,
} from '../services/ibcmd/ibcmdInfobaseOperationResult';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import {
  getIbcmdConsoleOutputEncodingSetting,
  getIbcmdImportDiagnosticsSetting,
} from '../services/metadataTreeSettings';
import { runIbcmdStreaming, type IbcmdStreamCancellation } from '../services/ibcmd/IbcmdStreamingRunner';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';
import {
  getIbcmdYamlInfobaseConfigUnsupportedMessage,
  probeIncrementalSupport,
} from '../services/ibcmd/ibcmdVersionSupport';
import { emptyDirectoryContents } from './ibcmdExportTargetDir';

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

/** Параметры подключения ibcmd (как ibcmdrunner: `--db-path`/`--config` + `--data`). */
async function appendIbcmdResolvedConfigChannelLines(
  ch: vscode.OutputChannel,
  prep: PreparedIbcmdConnectionOk,
  entry: InfobaseEntry,
): Promise<void> {
  ch.appendLine(`[ibcmd] --data (каталог данных автономного сервера): ${prep.offlineDataDir}`);
  if (prep.kind === 'fileDb') {
    ch.appendLine(`[ibcmd] --db-path (файловая ИБ): ${prep.dbCatalogPath}`);
    return;
  }
  const configKind = prep.isTemporary ? 'временный YAML' : 'файл на диске';
  ch.appendLine(`[ibcmd] --config: ${prep.absoluteConfigPath} (${configKind})`);
  if (prep.isTemporary && entry.type === 'file' && entry.filePath?.trim()) {
    try {
      const body = await fs.promises.readFile(prep.absoluteConfigPath, 'utf8');
      const fileScalar = tryParseInfobaseFileScalarFromYaml(body);
      if (fileScalar !== undefined) {
        ch.appendLine(
          `[ibcmd] в сгенерированном YAML поле infobase.file (после resolve+realpath): ${resolvePathForIbcmdYamlFileField(fileScalar)}`,
        );
      }
    } catch {
      /* ignore */
    }
  }
  if (!prep.isTemporary && entry.type === 'file' && entry.filePath?.trim()) {
    try {
      const body = await fs.promises.readFile(prep.absoluteConfigPath, 'utf8');
      const fileScalar = tryParseInfobaseFileScalarFromYaml(body);
      if (fileScalar !== undefined) {
        const fromYaml = resolvePathForIbcmdYamlFileField(fileScalar);
        const fromCatalog = resolvePathForIbcmdYamlFileField(entry.filePath.trim());
        if (fromYaml.toLowerCase() !== fromCatalog.toLowerCase()) {
          ch.appendLine(
            `[ibcmd] Внимание: в явном YAML поле file: указывает другой каталог, чем «каталог базы» в записи. Используется путь из YAML. YAML → ${fromYaml} | запись → ${fromCatalog}`,
          );
        }
      }
    } catch {
      /* не мешаем операции */
    }
  }
}

function findWorkspaceConfigurationRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  for (const f of folders) {
    const cfg = path.join(f.uri.fsPath, CONFIGURATION_XML);
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

/**
 * ibcmd `config export` требует пустой каталог; при согласии пользователя очищаем содержимое выбранной папки.
 */
async function confirmAndPrepareExportOutDirectory(dir: string): Promise<boolean> {
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
    `Папка не пуста (${entries.length} элементов). Для выгрузки ibcmd нужен пустой каталог — всё содержимое папки будет удалено. Продолжить?`,
    { modal: true },
    'Продолжить',
    'Отмена',
  );
  if (pick !== 'Продолжить') {
    return false;
  }
  await emptyDirectoryContents(dir);
  return true;
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
  /** WOW Phase 4 #64 — `ibcmd --extension` при загрузке выгрузки расширения. */
  ibcmdExtensionName?: string;
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

  const yamlUnsupported = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (yamlUnsupported) {
    return {
      status: 'error',
      exitCode: null,
      userMessage: yamlUnsupported,
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
  await appendIbcmdResolvedConfigChannelLines(ch, prep, params.entry);

  const resolvedSourceDir = path.resolve(params.absoluteSourceDir);
  let importCredentials: IbcmdConfigCliCredentials | undefined;
  const entryUser = params.entry.user?.trim();
  let entryPassword: string | undefined;
  if (params.entry.hasStoredPassword) {
    entryPassword = (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined;
  }
  if (entryUser || (entryPassword !== undefined && entryPassword.length > 0)) {
    importCredentials = { user: entryUser || undefined, password: entryPassword };
  }
  const connection = ibcmdOfflineConnectionFromPrepared(prep);
  const importArgs = buildInfobaseConfigImportArgs(connection, resolvedSourceDir, {
    extension: params.ibcmdExtensionName?.trim() || undefined,
    credentials: importCredentials,
  });
  if (getIbcmdImportDiagnosticsSetting()) {
    if (prep.kind === 'yaml') {
      const kind = prep.isTemporary ? 'временный YAML (сгенерирован расширением)' : 'явный файл пользователя';
      ch.appendLine(`[import diag] --config: ${prep.absoluteConfigPath} (${kind})`);
      try {
        const raw = await fs.promises.readFile(prep.absoluteConfigPath, 'utf8');
        ch.appendLine('[import diag] тело --config (пароль скрыт):');
        ch.appendLine(redactIbcmdYamlPasswordLines(raw).trimEnd());
      } catch (e) {
        ch.appendLine(`[import diag] не удалось прочитать --config: ${(e as Error).message}`);
      }
    } else {
      ch.appendLine(`[import diag] режим fileDb: --db-path=${prep.dbCatalogPath}`);
    }
    ch.appendLine(`[import diag] --data: ${prep.offlineDataDir}`);
    ch.appendLine(
      `[import diag] каталог выгрузки конфигурации — последний позиционный аргумент ibcmd: ${resolvedSourceDir}`,
    );
    ch.appendLine(`[import diag] argv (после Win long-path): ${importArgs.join(' ')}`);
    ch.appendLine('');
  }

  try {
    const outcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: importArgs,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
      abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
    });

    flushOutputChannel();

    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (outcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    const importResult = interpretIbcmdInfobaseOutcome('import', outcome);
    if (importResult.status === 'error') {
      return importResult;
    }

    // apply: обновление конфигурации БД
    const ctx = params.logContext?.trim() ? ` ${params.logContext.trim()}` : '';
    ch.appendLine(`[apply${ctx}] Обновление конфигурации БД...`);
    const applyArgs = buildInfobaseConfigApplyArgs(connection, {
      extension: params.ibcmdExtensionName?.trim() || undefined,
      credentials: importCredentials,
    });
    const applyOutcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: applyArgs,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
      abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
    });

    flushOutputChannel();

    if (applyOutcome.spawnErrorCode === 'ENOENT' || applyOutcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (applyOutcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    return interpretIbcmdInfobaseOutcome('apply', applyOutcome);
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
  buildArgsFromPrep: (prep: PreparedIbcmdConnectionOk, credentials?: IbcmdConfigCliCredentials) => string[];
  /** Дополнительная операция после основной (например apply после import). */
  postStep?: {
    op: IbcmdInfobaseConfigOpKind;
    logLine: string;
    buildArgsFromPrep: (prep: PreparedIbcmdConnectionOk, credentials?: IbcmdConfigCliCredentials) => string[];
  };
}): Promise<void> {
  const ibcmd = getIbcmdService();
  const pathResult = ibcmd.resolveExecutablePath();
  if (pathResult.kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const yamlUnsupported = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (yamlUnsupported) {
    void vscode.window.showErrorMessage(yamlUnsupported);
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
  await appendIbcmdResolvedConfigChannelLines(ch, prep, params.entry);

  let credentials: IbcmdConfigCliCredentials | undefined;
  const entryUser = params.entry.user?.trim();
  let entryPassword: string | undefined;
  if (params.entry.hasStoredPassword) {
    entryPassword = (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined;
  }
  if (entryUser || (entryPassword !== undefined && entryPassword.length > 0)) {
    credentials = { user: entryUser || undefined, password: entryPassword };
  }

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
          args: params.buildArgsFromPrep(prep, credentials),
          timeoutMs: ibcmd.getTimeoutMs(),
          cancellation: vscodeCancellation(token),
          consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
          onStreamChunk: (chunk) => appendOutputDebounced(chunk),
          abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
        });

        flushOutputChannel();

        if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
          ibcmd.invalidatePathCache();
        }

        if (outcome.logTruncated) {
          ch.appendLine(TRUNCATION_WARNING);
        }

        let interpreted = interpretIbcmdInfobaseOutcome(params.op, outcome);

        if (interpreted.status !== 'error' && params.postStep) {
          ch.appendLine(params.postStep.logLine);
          const postOutcome = await runIbcmdStreaming({
            executablePath: pathResult.path,
            args: params.postStep.buildArgsFromPrep(prep, credentials),
            timeoutMs: ibcmd.getTimeoutMs(),
            cancellation: vscodeCancellation(token),
            consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
            onStreamChunk: (chunk) => appendOutputDebounced(chunk),
            abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
          });

          flushOutputChannel();

          if (postOutcome.spawnErrorCode === 'ENOENT' || postOutcome.spawnErrorCode === 'ENOTDIR') {
            ibcmd.invalidatePathCache();
          }

          if (postOutcome.logTruncated) {
            ch.appendLine(TRUNCATION_WARNING);
          }

          interpreted = interpretIbcmdInfobaseOutcome(params.postStep.op, postOutcome);
        }

        const showOutput = 'Показать вывод';
        // Не await: иначе ProgressLocation.Notification крутится, пока пользователь не закроет toast.
        if (interpreted.status === 'success') {
          void vscode.window.showInformationMessage(interpreted.userMessage, showOutput).then((r) => {
            if (r === showOutput) {
              ch.show(true);
            }
          });
        } else if (interpreted.status === 'cancelled') {
          void vscode.window.showWarningMessage(interpreted.userMessage);
        } else {
          void vscode.window.showErrorMessage(interpreted.userMessage, showOutput).then((r) => {
            if (r === showOutput) {
              ch.show(true);
            }
          });
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
    void vscode.window.showWarningMessage(IB_FILE_IBCMD_WEB_UNSUPPORTED_RU);
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
      buildArgsFromPrep: (p, creds) =>
        buildInfobaseConfigImportArgs(ibcmdOfflineConnectionFromPrepared(p), path.resolve(source), { credentials: creds }),
      postStep: {
        op: 'apply',
        logLine: '[apply] Обновление конфигурации БД...',
        buildArgsFromPrep: (p, creds) =>
          buildInfobaseConfigApplyArgs(ibcmdOfflineConnectionFromPrepared(p), { credentials: creds }),
      },
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
    if (!(await confirmAndPrepareExportOutDirectory(absOut))) {
      return;
    }
    await runInfobaseConfigOperation({
      op: 'export',
      entry,
      storage: s,
      progressTitle: `Выгрузка конфигурации: ${entry.name}`,
      buildArgsFromPrep: (p, creds) =>
        buildInfobaseConfigExportArgs(ibcmdOfflineConnectionFromPrepared(p), absOut, { credentials: creds }),
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
      buildArgsFromPrep: (p, creds) => buildInfobaseConfigCheckArgs(ibcmdOfflineConnectionFromPrepared(p), { credentials: creds }),
    });
  });
}

export interface IncrementalImportParams {
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  configRoot: string;
  relativeFiles: readonly string[];
  token: vscode.CancellationToken;
  /** Подзаголовок в канале вывода (например «раскатка»). */
  logContext?: string;
  /** WOW Phase 4 — `ibcmd --extension` при загрузке расширения. */
  ibcmdExtensionName?: string;
}

/**
 * Инкрементальная загрузка выбранных файлов конфигурации через `ibcmd config import files`.
 * Без модальных диалогов — результат для агрегирования в отчёте DeployService.
 */
export async function runInfobaseConfigIncrementalImport(
  params: IncrementalImportParams,
): Promise<IbcmdInfobaseOperationResult> {
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

  const yamlUnsupported = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (yamlUnsupported) {
    return {
      status: 'error',
      exitCode: null,
      userMessage: yamlUnsupported,
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

  const probe = await probeIncrementalSupport(pathResult.path);
  if (!probe.importFiles) {
    await prep.dispose();
    return {
      status: 'error',
      exitCode: null,
      userMessage:
        'Команда `ibcmd infobase config import files` не поддерживается текущей версией ibcmd. Выполните полную раскатку через ibcmd config import.',
      logExcerpt: '',
    };
  }

  const ch = getOutputChannel();
  const ctx = params.logContext?.trim() ? ` ${params.logContext.trim()}` : '';
  ch.appendLine(`[import files${ctx}] ${params.entry.name} (${new Date().toISOString()})\n`);
  await appendIbcmdResolvedConfigChannelLines(ch, prep, params.entry);

  let importCredentials: IbcmdConfigCliCredentials | undefined;
  const entryUser = params.entry.user?.trim();
  let entryPassword: string | undefined;
  if (params.entry.hasStoredPassword) {
    entryPassword = (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined;
  }
  if (entryUser || (entryPassword !== undefined && entryPassword.length > 0)) {
    importCredentials = { user: entryUser || undefined, password: entryPassword };
  }

  const connection = ibcmdOfflineConnectionFromPrepared(prep);
  const importFilesArgs = buildInfobaseConfigImportFilesArgs(
    connection,
    params.relativeFiles,
    params.configRoot,
    {
      extension: params.ibcmdExtensionName?.trim() || undefined,
      credentials: importCredentials,
    },
  );

  try {
    const outcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: importFilesArgs,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
      abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
    });

    flushOutputChannel();

    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (outcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    const importResult = interpretIbcmdInfobaseOutcome('import', outcome);
    if (importResult.status === 'error') {
      return importResult;
    }

    // apply: обновление конфигурации БД
    ch.appendLine(`[apply${ctx}] Обновление конфигурации БД...`);
    const applyArgs = buildInfobaseConfigApplyArgs(connection, {
      extension: params.ibcmdExtensionName?.trim() || undefined,
      credentials: importCredentials,
    });
    const applyOutcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: applyArgs,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
      abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
    });

    flushOutputChannel();

    if (applyOutcome.spawnErrorCode === 'ENOENT' || applyOutcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (applyOutcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    return interpretIbcmdInfobaseOutcome('apply', applyOutcome);
  } finally {
    flushOutputChannel();
    await prep.dispose();
  }
}

/** Recursively copies all files from srcDir into destDir, creating subdirectories and overwriting existing files. */
function copyTreeOverwrite(srcDir: string, destDir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      count += copyTreeOverwrite(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

export interface ExportObjectsParams {
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  /** Целевой каталог конфигурации — файлы копируются сюда после выгрузки из temp. */
  configRoot: string;
  /** Идентификаторы объектов в формате `{MetadataType}.{name}`, например `Catalog.Справочник55`. */
  objectIds: readonly string[];
  token: vscode.CancellationToken;
  /** Подзаголовок в канале вывода. */
  logContext?: string;
  /** WOW Phase 4 — `ibcmd --extension` при работе с расширением. */
  ibcmdExtensionName?: string;
}

/**
 * Выгрузка отдельных объектов конфигурации через `ibcmd infobase config export objects`.
 * Read-only — apply не запускается.
 */
export async function runInfobaseConfigExportObjects(
  params: ExportObjectsParams,
): Promise<IbcmdInfobaseOperationResult> {
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

  const yamlUnsupported = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (yamlUnsupported) {
    return {
      status: 'error',
      exitCode: null,
      userMessage: yamlUnsupported,
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

  const probe = await probeIncrementalSupport(pathResult.path);
  if (!probe.exportObjects) {
    await prep.dispose();
    return {
      status: 'error',
      exitCode: null,
      userMessage:
        'Команда `ibcmd infobase config export objects` не поддерживается текущей версией ibcmd.',
      logExcerpt: '',
    };
  }

  const ch = getOutputChannel();
  const ctx = params.logContext?.trim() ? ` ${params.logContext.trim()}` : '';
  ch.appendLine(`[export objects${ctx}] ${params.entry.name} (${new Date().toISOString()})\n`);
  await appendIbcmdResolvedConfigChannelLines(ch, prep, params.entry);

  let exportCredentials: IbcmdConfigCliCredentials | undefined;
  const entryUser = params.entry.user?.trim();
  let entryPassword: string | undefined;
  if (params.entry.hasStoredPassword) {
    entryPassword = (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined;
  }
  if (entryUser || (entryPassword !== undefined && entryPassword.length > 0)) {
    exportCredentials = { user: entryUser || undefined, password: entryPassword };
  }

  // Export to a temp directory (ibcmd requires --out= to be empty), then copy to workspace.
  const tempExportDir = path.join(os.tmpdir(), `1cviewer-export-objects-${Date.now()}`);
  fs.mkdirSync(tempExportDir, { recursive: true });

  const connection = ibcmdOfflineConnectionFromPrepared(prep);
  const exportObjectsArgs = buildInfobaseConfigExportObjectsArgs(
    connection,
    tempExportDir,
    params.objectIds,
    {
      extension: params.ibcmdExtensionName?.trim() || undefined,
      credentials: exportCredentials,
    },
  );

  try {
    const outcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: exportObjectsArgs,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
      abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
    });

    flushOutputChannel();

    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (outcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    const result = interpretIbcmdInfobaseOutcome('export', outcome);

    // Copy exported files from temp to workspace configRoot.
    if (result.status === 'success') {
      const copied = copyTreeOverwrite(tempExportDir, params.configRoot);
      ch.appendLine(`[export objects${ctx}] Скопировано файлов: ${copied}`);
    }

    return result;
  } finally {
    flushOutputChannel();
    await prep.dispose();
    // Clean up temp directory.
    try {
      fs.rmSync(tempExportDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

export interface ExportStatusParams {
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  configDumpInfoPath: string;
  token: vscode.CancellationToken;
  /** WOW Phase 4 — `ibcmd --extension` при работе с расширением. */
  ibcmdExtensionName?: string;
}

/**
 * Диагностика статуса конфигурации через `ibcmd config export status`.
 * Read-only — apply не запускается.
 */
export async function runInfobaseConfigExportStatus(
  params: ExportStatusParams,
): Promise<IbcmdInfobaseOperationResult> {
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

  const yamlUnsupported = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (yamlUnsupported) {
    return {
      status: 'error',
      exitCode: null,
      userMessage: yamlUnsupported,
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

  const probe = await probeIncrementalSupport(pathResult.path);
  if (!probe.exportStatus) {
    await prep.dispose();
    return {
      status: 'error',
      exitCode: null,
      userMessage:
        'Команда `ibcmd infobase config export status` не поддерживается текущей версией ibcmd.',
      logExcerpt: '',
    };
  }

  const ch = getOutputChannel();
  ch.appendLine(`[export status] ${params.entry.name} (${new Date().toISOString()})\n`);
  await appendIbcmdResolvedConfigChannelLines(ch, prep, params.entry);

  let exportCredentials: IbcmdConfigCliCredentials | undefined;
  const entryUser = params.entry.user?.trim();
  let entryPassword: string | undefined;
  if (params.entry.hasStoredPassword) {
    entryPassword = (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined;
  }
  if (entryUser || (entryPassword !== undefined && entryPassword.length > 0)) {
    exportCredentials = { user: entryUser || undefined, password: entryPassword };
  }

  const connection = ibcmdOfflineConnectionFromPrepared(prep);
  const exportStatusArgs = buildInfobaseConfigExportStatusArgs(
    connection,
    params.configDumpInfoPath,
    {
      extension: params.ibcmdExtensionName?.trim() || undefined,
      credentials: exportCredentials,
    },
  );

  try {
    const outcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args: exportStatusArgs,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: (chunk) => appendOutputDebounced(chunk),
      abortPattern: /Имя пользователя\s*:[\s\S]*Имя пользователя\s*:/,
    });

    flushOutputChannel();

    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (outcome.logTruncated) {
      ch.appendLine(TRUNCATION_WARNING);
    }

    return interpretIbcmdInfobaseOutcome('export', outcome);
  } finally {
    flushOutputChannel();
    await prep.dispose();
  }
}
