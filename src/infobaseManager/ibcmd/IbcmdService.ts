import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  createDefaultPathResolverDeps,
  resolveIbcmdPath,
  type IbcmdPathResolveResult,
} from './IbcmdPathResolver';
import { resolveIbcmdTimeoutMs, runIbcmdExecutable, type ExecFileFn } from './IbcmdProcessRunner';

/**
 * Facade: cached ibcmd path (successful resolve only) + unified process execution.
 */
export class IbcmdService {
  private cachedExecutablePath: string | null = null;

  invalidatePathCache(): void {
    this.cachedExecutablePath = null;
  }

  private readSettings(): { ibcmdPath: string; ibcmdTimeoutMs: number } {
    const cfg = vscode.workspace.getConfiguration();
    const ibcmdPath = cfg.get<string>('1cInfobaseManager.ibcmdPath') ?? '';
    const ibcmdTimeoutMs = cfg.get<number>('1cInfobaseManager.ibcmdTimeoutMs', 0);
    return { ibcmdPath, ibcmdTimeoutMs };
  }

  /**
   * Returns cached path if it still exists; otherwise re-resolves.
   */
  resolveExecutablePath(): IbcmdPathResolveResult {
    if (this.cachedExecutablePath && fs.existsSync(this.cachedExecutablePath)) {
      return { kind: 'resolved', path: this.cachedExecutablePath };
    }
    this.cachedExecutablePath = null;
    const { ibcmdPath } = this.readSettings();
    const result = resolveIbcmdPath({
      settingsPath: ibcmdPath,
      envIbcmdPath: process.env.IBCMD_PATH,
      deps: createDefaultPathResolverDeps(),
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
    return runIbcmdExecutable(resolved.path, args, this.getTimeoutMs(), execImpl);
  }
}
