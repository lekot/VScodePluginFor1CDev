import { decodeIbcmdProcessStreams } from './ibcmd/consoleStreamDecoder';
import { getIbcmdService } from './ibcmd/ibcmdServiceSingleton';
import { runIbcmdExecutable, type ExecFileFn } from './ibcmd/IbcmdProcessRunner';
import { getIbcmdConsoleOutputEncodingSetting } from './metadataTreeSettings';
import { getIbcmdYamlInfobaseConfigUnsupportedMessage } from './ibcmd/ibcmdVersionSupport';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { prepareIbcmdConfigYaml } from '../infobases/ibcmdConfigPathResolver';
import {
  buildInfobaseConfigImportArgs,
  ibcmdOfflineConnectionFromPrepared,
  type IbcmdConfigCliCredentials,
} from './ibcmd/ibcmdInfobaseConfigArgs';

const PREVIEW_MAX = 8000;

export type IbcmdXmlPreflightCode =
  | 'IBCMD_NOT_FOUND'
  | 'UNSUPPORTED_VERSION'
  | 'PREPARE_FAILED'
  | 'IMPORT_FAILED';

export interface IbcmdXmlPreflightResult {
  ok: boolean;
  code?: IbcmdXmlPreflightCode;
  message: string;
  durationMs: number;
}

function combineOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().slice(0, PREVIEW_MAX);
}

export async function runIbcmdXmlImportPreflight(params: {
  entry: InfobaseEntry;
  storage: InfobaseStorageService;
  absoluteSourceDir: string;
  ibcmdExtensionName?: string;
  execImpl?: ExecFileFn;
}): Promise<IbcmdXmlPreflightResult> {
  const startedAt = Date.now();
  const ibcmd = getIbcmdService();
  const pathResult = ibcmd.resolveExecutablePath();
  if (pathResult.kind !== 'resolved') {
    return {
      ok: false,
      code: 'IBCMD_NOT_FOUND',
      durationMs: Date.now() - startedAt,
      message:
        'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.',
    };
  }

  const unsupportedMessage = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (unsupportedMessage) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      durationMs: Date.now() - startedAt,
      message: unsupportedMessage,
    };
  }

  const prep = await prepareIbcmdConfigYaml(params.entry, (id) => params.storage.readPasswordSecret(id));
  if (!prep.ok) {
    return {
      ok: false,
      code: 'PREPARE_FAILED',
      durationMs: Date.now() - startedAt,
      message: prep.userMessage,
    };
  }

  try {
    const entryUser = params.entry.user?.trim();
    const entryPassword = params.entry.hasStoredPassword
      ? (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined
      : undefined;
    const credentials: IbcmdConfigCliCredentials | undefined =
      entryUser || (entryPassword !== undefined && entryPassword.length > 0)
        ? { user: entryUser || undefined, password: entryPassword }
        : undefined;
    const args = buildInfobaseConfigImportArgs(
      ibcmdOfflineConnectionFromPrepared(prep),
      params.absoluteSourceDir,
      {
        extension: params.ibcmdExtensionName?.trim() || undefined,
        credentials,
      },
    );

    const { stdout, stderr } = await runIbcmdExecutable(
      pathResult.path,
      args,
      ibcmd.getTimeoutMs(),
      params.execImpl,
      getIbcmdConsoleOutputEncodingSetting(),
    );
    const details = combineOutput(stdout, stderr);
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      message: details || 'ibcmd config import preflight завершился успешно.',
    };
  } catch (err: unknown) {
    const e = err as {
      code?: string | number;
      status?: number;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    if (e.code === 'ENOENT') {
      ibcmd.invalidatePathCache();
    }
    const code =
      typeof e.status === 'number'
        ? `exitCode=${e.status}`
        : typeof e.code === 'number'
          ? `exitCode=${e.code}`
          : e.signal
            ? `signal=${e.signal}`
            : 'failed';
    const rawOut = e.stdout != null ? e.stdout : Buffer.alloc(0);
    const rawErr = e.stderr != null ? e.stderr : Buffer.alloc(0);
    const { stdout: decOut, stderr: decErr } = decodeIbcmdProcessStreams(
      rawOut,
      rawErr,
      getIbcmdConsoleOutputEncodingSetting(),
    );
    const details = combineOutput(decOut, decErr);
    const tail = details ? `\n${details}` : e.message ? `\n${e.message}` : '';
    return {
      ok: false,
      code: 'IMPORT_FAILED',
      durationMs: Date.now() - startedAt,
      message: `ibcmd config import preflight failed (${code}).${tail}`,
    };
  } finally {
    await prep.dispose();
  }
}
