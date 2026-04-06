import * as fs from 'fs';
import * as path from 'path';
import {
  createDefaultPathResolverDeps,
  resolveIbcmdPath,
  type IbcmdPathResolveResult,
} from './IbcmdPathResolver';
import { resolveIbcmdTimeoutMs, runIbcmdExecutable, type ExecFileFn } from './IbcmdProcessRunner';
import {
  getIbcmdAutoDetectSetting,
  getIbcmdConsoleOutputEncodingSetting,
  getIbcmdPathSetting,
  getIbcmdTimeoutMsSetting,
} from '../metadataTreeSettings';
import { invalidateIbcmdVersionQueryCache, invalidateIncrementalSupportProbeCache } from './ibcmdVersionSupport';

/**
 * Facade: cached ibcmd path (successful resolve only) + unified process execution.
 */
export class IbcmdService {
  private cachedExecutablePath: string | null = null;

  invalidatePathCache(): void {
    this.cachedExecutablePath = null;
    invalidateIbcmdVersionQueryCache();
    invalidateIncrementalSupportProbeCache();
  }

  private readSettings(): { ibcmdPath: string; ibcmdTimeoutMs: number; autoDetect: boolean } {
    return {
      ibcmdPath: getIbcmdPathSetting(),
      ibcmdTimeoutMs: getIbcmdTimeoutMsSetting(),
      autoDetect: getIbcmdAutoDetectSetting(),
    };
  }

  /**
   * Returns cached path if it still exists; otherwise re-resolves.
   */
  resolveExecutablePath(): IbcmdPathResolveResult {
    if (this.cachedExecutablePath && fs.existsSync(this.cachedExecutablePath)) {
      return { kind: 'resolved', path: this.cachedExecutablePath };
    }
    this.cachedExecutablePath = null;
    const { ibcmdPath, autoDetect } = this.readSettings();
    const result = resolveIbcmdPath({
      settingsPath: ibcmdPath,
      envIbcmdPath: process.env.IBCMD_PATH,
      deps: createDefaultPathResolverDeps(),
      autoDetect,
    });
    if (result.kind === 'resolved') {
      this.cachedExecutablePath = result.path;
    }
    return result;
  }

  getTimeoutMs(): number {
    const { ibcmdTimeoutMs } = this.readSettings();
    return resolveIbcmdTimeoutMs(ibcmdTimeoutMs, process.env.IBCMD_TIMEOUT_MS);
  }

  async run(args: string[], execImpl?: ExecFileFn): Promise<{ stdout: string; stderr: string }> {
    const resolved = this.resolveExecutablePath();
    if (resolved.kind !== 'resolved') {
      throw Object.assign(new Error('ibcmd path not resolved'), { code: 'IBCMD_NOT_RESOLVED' });
    }
    return runIbcmdExecutable(
      resolved.path,
      args,
      this.getTimeoutMs(),
      execImpl,
      getIbcmdConsoleOutputEncodingSetting(),
    );
  }

  /**
   * WOW plan §3A #47 — файловая ИБ: `ibcmd infobase create --db-path=<abs>` (см. docs/WOW/ibcmd-api-reference.md).
   */
  async runInfobaseCreateFileDb(dbPath: string, execImpl?: ExecFileFn): Promise<{ stdout: string; stderr: string }> {
    const abs = path.resolve(dbPath);
    return this.run(['infobase', 'create', `--db-path=${abs}`], execImpl);
  }
}
