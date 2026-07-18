import * as path from 'path';
import {
  createDefaultPathResolverDeps,
  resolveIbcmdPath,
  type IbcmdPathResolveResult,
  type IbcmdPathResolverDeps,
} from './IbcmdPathResolver';
import { resolveIbcmdTimeoutMs, runIbcmdExecutable, type ExecFileFn } from './IbcmdProcessRunner';
import {
  getIbcmdAutoDetectSetting,
  getIbcmdConsoleOutputEncodingSetting,
  getIbcmdPathSetting,
  getIbcmdTimeoutMsSetting,
} from '../metadataTreeSettings';
import { invalidateIbcmdVersionQueryCache, invalidateIncrementalSupportProbeCache } from './ibcmdVersionSupport';

const POSITIVE_PATH_CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_PATH_CACHE_TTL_MS = 30_000;

interface IbcmdPathCacheEntry {
  key: string;
  result: IbcmdPathResolveResult;
  expiresAt: number;
}

export interface IbcmdServiceDeps {
  resolvePath?: typeof resolveIbcmdPath;
  createPathResolverDeps?: () => IbcmdPathResolverDeps;
  readSettings?: () => { ibcmdPath: string; ibcmdTimeoutMs: number; autoDetect: boolean };
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  positiveCacheTtlMs?: number;
  negativeCacheTtlMs?: number;
}

/** Facade: coalesced async discovery, positive/negative cache, unified execution. */
export class IbcmdService {
  private cache: IbcmdPathCacheEntry | undefined;
  private inFlight: { key: string; promise: Promise<IbcmdPathResolveResult> } | undefined;
  private cacheGeneration = 0;

  constructor(private readonly deps: IbcmdServiceDeps = {}) {}

  invalidatePathCache(): void {
    this.cache = undefined;
    this.inFlight = undefined;
    this.cacheGeneration += 1;
    invalidateIbcmdVersionQueryCache();
    invalidateIncrementalSupportProbeCache();
  }

  private readSettings(): { ibcmdPath: string; ibcmdTimeoutMs: number; autoDetect: boolean } {
    if (this.deps.readSettings) {
      return this.deps.readSettings();
    }
    return {
      ibcmdPath: getIbcmdPathSetting(),
      ibcmdTimeoutMs: getIbcmdTimeoutMsSetting(),
      autoDetect: getIbcmdAutoDetectSetting(),
    };
  }

  /** Cache-only compatibility accessor. It never performs filesystem/process discovery. */
  resolveExecutablePath(): IbcmdPathResolveResult {
    const { key } = this.createResolutionInput();
    if (this.cache?.key === key && this.cache.expiresAt > this.now()) {
      return this.cache.result;
    }

    return {
      kind: 'notFound',
      hint: 'ibcmd discovery has not completed. Use resolveExecutablePathAsync().',
    };
  }

  async resolveExecutablePathAsync(): Promise<IbcmdPathResolveResult> {
    const resolution = this.createResolutionInput();
    if (this.cache?.key === resolution.key && this.cache.expiresAt > this.now()) {
      return this.cache.result;
    }
    if (this.inFlight?.key === resolution.key) {
      return this.inFlight.promise;
    }

    const resolver = this.deps.resolvePath ?? resolveIbcmdPath;
    const generation = this.cacheGeneration;
    const promise = resolver(resolution.input).then((result) => {
      const ttl =
        result.kind === 'resolved'
          ? (this.deps.positiveCacheTtlMs ?? POSITIVE_PATH_CACHE_TTL_MS)
          : (this.deps.negativeCacheTtlMs ?? NEGATIVE_PATH_CACHE_TTL_MS);
      if (generation === this.cacheGeneration) {
        this.cache = {
          key: resolution.key,
          result,
          expiresAt: this.now() + Math.max(0, ttl),
        };
      }
      return result;
    });
    this.inFlight = { key: resolution.key, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
      }
    }
  }

  getTimeoutMs(): number {
    const { ibcmdTimeoutMs } = this.readSettings();
    return resolveIbcmdTimeoutMs(ibcmdTimeoutMs, process.env.IBCMD_TIMEOUT_MS);
  }

  async run(args: string[], execImpl?: ExecFileFn): Promise<{ stdout: string; stderr: string }> {
    const resolved = await this.resolveExecutablePathAsync();
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

  private createResolutionInput(): {
    key: string;
    input: Parameters<typeof resolveIbcmdPath>[0];
  } {
    const { ibcmdPath, autoDetect } = this.readSettings();
    const environment = this.deps.env ?? process.env;
    const envIbcmdPath = environment.IBCMD_PATH;
    const resolverDeps = this.deps.createPathResolverDeps?.() ?? createDefaultPathResolverDeps();
    return {
      key: JSON.stringify([ibcmdPath.trim(), envIbcmdPath?.trim() ?? '', autoDetect]),
      input: {
        settingsPath: ibcmdPath,
        envIbcmdPath,
        deps: { ...resolverDeps, env: environment },
        autoDetect,
      },
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
