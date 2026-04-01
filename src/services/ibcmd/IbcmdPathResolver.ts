import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function joinForPlatform(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32' ? path.win32.join(...segments) : path.posix.join(...segments);
}

/**
 * Resolves the ibcmd executable path without importing `vscode` (testable via dependency injection).
 *
 * Priority:
 * 1. Non-empty settings path (`settingsPath`) after trim — must exist on disk.
 * 2. Non-empty `IBCMD_PATH` from env (`envIbcmdPath`) after trim — must exist on disk.
 * 3. When `autoDetect` is true: `where ibcmd` / `which ibcmd`, then typical install roots.
 */
export type IbcmdPathResolveResult =
  | { kind: 'resolved'; path: string }
  | { kind: 'notFound'; hint: string };

export type IbcmdPathResolverDeps = {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Optional override for unit tests; default uses `where` / `which`. */
  findOnSystemPath?: () => string | null;
};

function sortVersionishDesc(names: string[]): string[] {
  return [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
}

function isDir(deps: IbcmdPathResolverDeps, p: string): boolean {
  try {
    return deps.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(deps: IbcmdPathResolverDeps, p: string): string[] {
  try {
    return deps.readdirSync(p);
  } catch {
    return [];
  }
}

function collectProgramRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(
      (x): x is string => typeof x === 'string' && x.length > 0
    );
    return [...new Set(roots)];
  }
  return ['/opt'];
}

function isValidIbcmdPath(resolvedPath: string, platform: NodeJS.Platform): boolean {
  // Must be an absolute path
  if (!path.isAbsolute(resolvedPath)) {
    return false;
  }
  // On Windows, must end with ibcmd.exe; on other platforms, must end with ibcmd
  const expectedExeName = platform === 'win32' ? 'ibcmd.exe' : 'ibcmd';
  const basename = path.basename(resolvedPath).toLowerCase();
  return basename === expectedExeName;
}

function defaultFindOnSystemPath(deps: IbcmdPathResolverDeps): string | null {
  try {
    if (deps.platform === 'win32') {
      const out = execFileSync('where.exe', ['ibcmd'], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (line && isValidIbcmdPath(line, deps.platform) && deps.existsSync(line)) {
        return line;
      }
    } else {
      const out = execFileSync('which', ['ibcmd'], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 65536,
      });
      const line = out.trim().split('\n')[0]?.trim();
      if (line && isValidIbcmdPath(line, deps.platform) && deps.existsSync(line)) {
        return line;
      }
    }
  } catch {
    // PATH lookup is best-effort only
  }
  return null;
}

function tryScan1cv8InstallRoot(
  installRoot: string,
  deps: IbcmdPathResolverDeps,
  exeName: string
): string | null {
  if (!deps.existsSync(installRoot)) {
    return null;
  }
  const level1 = sortVersionishDesc(safeReaddir(deps, installRoot));
  for (const name1 of level1) {
    const p1 = joinForPlatform(deps.platform, installRoot, name1);
    if (!isDir(deps, p1)) {
      continue;
    }
    const bin1 = joinForPlatform(deps.platform, p1, 'bin', exeName);
    if (deps.existsSync(bin1)) {
      return bin1;
    }
    const level2 = sortVersionishDesc(safeReaddir(deps, p1));
    for (const name2 of level2) {
      const p2 = joinForPlatform(deps.platform, p1, name2);
      if (!isDir(deps, p2)) {
        continue;
      }
      const bin2 = joinForPlatform(deps.platform, p2, 'bin', exeName);
      if (deps.existsSync(bin2)) {
        return bin2;
      }
    }
  }
  return null;
}

export function createDefaultPathResolverDeps(): IbcmdPathResolverDeps {
  return {
    existsSync: fs.existsSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    statSync: fs.statSync.bind(fs),
    env: process.env,
    platform: process.platform,
  };
}

/**
 * Pure resolution: validates candidates with `existsSync`; no caching (cache lives in IbcmdService).
 */
export function resolveIbcmdPath(input: {
  settingsPath: string | undefined;
  envIbcmdPath: string | undefined;
  deps: IbcmdPathResolverDeps;
  /** When false, skip PATH and install-dir discovery after settings + env. Default true. */
  autoDetect?: boolean;
}): IbcmdPathResolveResult {
  const { settingsPath, envIbcmdPath, deps } = input;
  const autoDetect = input.autoDetect !== false;
  const exeName = deps.platform === 'win32' ? 'ibcmd.exe' : 'ibcmd';

  const s1 = settingsPath?.trim();
  if (s1) {
    if (deps.existsSync(s1)) {
      return { kind: 'resolved', path: s1 };
    }
    return {
      kind: 'notFound',
      hint: `Configured path does not exist: ${s1}`,
    };
  }

  const s2 = envIbcmdPath?.trim();
  if (s2) {
    if (deps.existsSync(s2)) {
      return { kind: 'resolved', path: s2 };
    }
    return {
      kind: 'notFound',
      hint: `IBCMD_PATH is set but the file does not exist: ${s2}`,
    };
  }

  if (!autoDetect) {
    return {
      kind: 'notFound',
      hint: 'Auto-detect is disabled (1cMetadataTree.ibcmd.autoDetect). Set 1cMetadataTree.ibcmd.path or IBCMD_PATH.',
    };
  }

  const fromPath = deps.findOnSystemPath?.() ?? defaultFindOnSystemPath(deps);
  if (fromPath) {
    return { kind: 'resolved', path: fromPath };
  }

  for (const root of collectProgramRoots(deps.env, deps.platform)) {
    const hit = tryScan1cv8InstallRoot(joinForPlatform(deps.platform, root, '1cv8'), deps, exeName);
    if (hit) {
      return { kind: 'resolved', path: hit };
    }
  }

  return {
    kind: 'notFound',
    hint: 'Not found in settings, IBCMD_PATH, PATH, or typical 1cv8 install directories.',
  };
}
