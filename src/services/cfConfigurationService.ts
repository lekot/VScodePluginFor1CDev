import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { CONFIGURATION_XML } from '../constants/fileNames';
import type { IbcmdPathResolveResult } from './ibcmd/IbcmdPathResolver';
import {
  buildInfobaseConfigCreateFileDbArgs,
  buildInfobaseConfigExportArgs,
  buildInfobaseConfigImportArgs,
  type IbcmdOfflineConnection,
} from './ibcmd/ibcmdInfobaseConfigArgs';
import {
  runIbcmdStreaming,
  type IbcmdStreamCancellation,
  type IbcmdStreamingRawOutcome,
  type IbcmdStreamingRunnerOptions,
} from './ibcmd/IbcmdStreamingRunner';
import { interpretIbcmdInfobaseOutcome } from './ibcmd/ibcmdInfobaseOperationResult';
import type { IbcmdConsoleOutputEncoding } from './ibcmd/ibcmdConsoleEncodingTypes';

const requireFromHere = createRequire(__filename);

export interface CfConfigurationServiceDeps {
  resolveExecutablePath: () => IbcmdPathResolveResult;
  getTimeoutMs: () => number;
  getConsoleOutputEncoding: () => IbcmdConsoleOutputEncoding;
  createTempRoot: () => Promise<string>;
  runStreaming: (options: IbcmdStreamingRunnerOptions) => Promise<IbcmdStreamingRawOutcome>;
}

export interface CfConfigurationOperationResult {
  status: 'success' | 'cancelled' | 'error';
  userMessage: string;
  logExcerpt: string;
  exitCode: number | null;
  code?: 'IBCMD_NOT_FOUND';
}

export interface DecomposeCfToXmlDirectoryParams {
  cfPath: string;
  outDir: string;
  token: IbcmdStreamCancellation;
}

export interface BuildCfFromXmlConfigurationParams {
  configRoot: string;
  outFile: string;
  token: IbcmdStreamCancellation;
}

function defaultDeps(): CfConfigurationServiceDeps {
  const { getIbcmdService } = requireFromHere(
    './ibcmd/ibcmdServiceSingleton',
  ) as typeof import('./ibcmd/ibcmdServiceSingleton');
  const { getIbcmdConsoleOutputEncodingSetting } = requireFromHere(
    './metadataTreeSettings',
  ) as typeof import('./metadataTreeSettings');
  const ibcmd = getIbcmdService();
  return {
    resolveExecutablePath: () => ibcmd.resolveExecutablePath(),
    getTimeoutMs: () => ibcmd.getTimeoutMs(),
    getConsoleOutputEncoding: () => getIbcmdConsoleOutputEncodingSetting(),
    createTempRoot: async () => fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-')),
    runStreaming: runIbcmdStreaming,
  };
}

function errorResult(
  userMessage: string,
  logExcerpt = '',
  code?: CfConfigurationOperationResult['code'],
): CfConfigurationOperationResult {
  return {
    status: 'error',
    userMessage,
    logExcerpt,
    exitCode: null,
    code,
  };
}

async function ensureExistingFile(filePath: string, label: string): Promise<CfConfigurationOperationResult | null> {
  try {
    const st = await fs.promises.stat(filePath);
    if (st.isFile()) {
      return null;
    }
  } catch {
    /* handled below */
  }
  return errorResult(`${label} не найден или не является файлом: ${filePath}`);
}

async function ensureConfigurationRoot(configRoot: string): Promise<CfConfigurationOperationResult | null> {
  try {
    const st = await fs.promises.stat(configRoot);
    if (!st.isDirectory()) {
      return errorResult(`Корень XML-конфигурации не является каталогом: ${configRoot}`);
    }
  } catch {
    return errorResult(`Корень XML-конфигурации не найден: ${configRoot}`);
  }

  const configurationXml = path.join(configRoot, CONFIGURATION_XML);
  const missingConfigurationXml = await ensureExistingFile(configurationXml, CONFIGURATION_XML);
  return missingConfigurationXml;
}

async function prepareTempConnection(
  executablePath: string,
  deps: CfConfigurationServiceDeps,
  token: IbcmdStreamCancellation,
): Promise<
  | { ok: true; tempRoot: string; connection: IbcmdOfflineConnection }
  | { ok: false; tempRoot: string; result: CfConfigurationOperationResult }
> {
  const tempRoot = await deps.createTempRoot();
  const dbPath = path.join(tempRoot, 'db');
  const offlineDataDir = path.join(tempRoot, 'data');
  try {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    await fs.promises.mkdir(dbPath, { recursive: true });
    await fs.promises.mkdir(offlineDataDir, { recursive: true });

    const createOutcome = await deps.runStreaming({
      executablePath,
      args: buildInfobaseConfigCreateFileDbArgs(dbPath, offlineDataDir, { force: true }),
      timeoutMs: deps.getTimeoutMs(),
      cancellation: token,
      consoleOutputEncoding: deps.getConsoleOutputEncoding(),
    });
    const createResult = interpretCreateOutcome(createOutcome);
    if (createResult.status !== 'success') {
      return { ok: false, tempRoot, result: createResult };
    }

    return {
      ok: true,
      tempRoot,
      connection: { kind: 'fileDb', dbCatalogPath: dbPath, offlineDataDir },
    };
  } catch (error) {
    await cleanupTempRoot(tempRoot);
    throw error;
  }
}

function interpretCreateOutcome(raw: IbcmdStreamingRawOutcome): CfConfigurationOperationResult {
  if (raw.cancelled) {
    return {
      status: 'cancelled',
      userMessage: 'Операция отменена.',
      logExcerpt: raw.combinedLog,
      exitCode: raw.exitCode,
    };
  }
  if (raw.timedOut) {
    return {
      status: 'error',
      userMessage: 'Превышено время ожидания создания временной информационной базы ibcmd.',
      logExcerpt: raw.combinedLog,
      exitCode: raw.exitCode,
    };
  }
  if (raw.spawnErrorCode || raw.spawnErrorMessage) {
    return {
      status: 'error',
      userMessage: `Не удалось запустить ibcmd: ${raw.spawnErrorMessage ?? raw.spawnErrorCode ?? 'unknown'}`,
      logExcerpt: raw.combinedLog,
      exitCode: null,
    };
  }
  if (raw.exitCode === 0) {
    return {
      status: 'success',
      userMessage: 'Операция завершена успешно.',
      logExcerpt: raw.combinedLog,
      exitCode: 0,
    };
  }
  return {
    status: 'error',
    userMessage: 'Не удалось создать временную информационную базу ibcmd.',
    logExcerpt: raw.combinedLog,
    exitCode: raw.exitCode,
  };
}

async function cleanupTempRoot(tempRoot: string | null): Promise<void> {
  if (!tempRoot) {
    return;
  }
  await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

function ibcmdNotFoundResult(resolved: IbcmdPathResolveResult): CfConfigurationOperationResult {
  const hint = resolved.kind === 'notFound' ? resolved.hint : '';
  return errorResult(
    hint || 'Исполняемый файл ibcmd не найден. Проверьте путь в настройках или переменную IBCMD_PATH.',
    hint,
    'IBCMD_NOT_FOUND',
  );
}

export async function decomposeCfToXmlDirectory(
  params: DecomposeCfToXmlDirectoryParams,
  deps: CfConfigurationServiceDeps = defaultDeps(),
): Promise<CfConfigurationOperationResult> {
  const cfValidation = await ensureExistingFile(params.cfPath, 'CF-файл');
  if (cfValidation) {
    return cfValidation;
  }
  await fs.promises.mkdir(params.outDir, { recursive: true });

  const resolved = deps.resolveExecutablePath();
  if (resolved.kind !== 'resolved') {
    return ibcmdNotFoundResult(resolved);
  }

  let tempRoot: string | null = null;
  try {
    const prepared = await prepareTempConnection(resolved.path, deps, params.token);
    tempRoot = prepared.tempRoot;
    if (!prepared.ok) {
      return prepared.result;
    }

    const outcome = await deps.runStreaming({
      executablePath: resolved.path,
      args: buildInfobaseConfigExportArgs(prepared.connection, params.outDir, {
        file: params.cfPath,
        force: true,
      }),
      timeoutMs: deps.getTimeoutMs(),
      cancellation: params.token,
      consoleOutputEncoding: deps.getConsoleOutputEncoding(),
    });
    const interpreted = interpretIbcmdInfobaseOutcome('export', outcome);
    return {
      status: interpreted.status,
      userMessage: interpreted.userMessage,
      logExcerpt: interpreted.logExcerpt,
      exitCode: interpreted.exitCode,
    };
  } finally {
    await cleanupTempRoot(tempRoot);
  }
}

export async function buildCfFromXmlConfiguration(
  params: BuildCfFromXmlConfigurationParams,
  deps: CfConfigurationServiceDeps = defaultDeps(),
): Promise<CfConfigurationOperationResult> {
  const rootValidation = await ensureConfigurationRoot(params.configRoot);
  if (rootValidation) {
    return rootValidation;
  }
  await fs.promises.mkdir(path.dirname(params.outFile), { recursive: true });

  const resolved = deps.resolveExecutablePath();
  if (resolved.kind !== 'resolved') {
    return ibcmdNotFoundResult(resolved);
  }

  let tempRoot: string | null = null;
  try {
    const prepared = await prepareTempConnection(resolved.path, deps, params.token);
    tempRoot = prepared.tempRoot;
    if (!prepared.ok) {
      return prepared.result;
    }

    const outcome = await deps.runStreaming({
      executablePath: resolved.path,
      args: buildInfobaseConfigImportArgs(prepared.connection, params.configRoot, {
        outFile: params.outFile,
      }),
      timeoutMs: deps.getTimeoutMs(),
      cancellation: params.token,
      consoleOutputEncoding: deps.getConsoleOutputEncoding(),
    });
    const interpreted = interpretIbcmdInfobaseOutcome('import', outcome);
    return {
      status: interpreted.status,
      userMessage: interpreted.userMessage,
      logExcerpt: interpreted.logExcerpt,
      exitCode: interpreted.exitCode,
    };
  } finally {
    await cleanupTempRoot(tempRoot);
  }
}
