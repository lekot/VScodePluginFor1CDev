import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function joinForPlatform(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32' ? path.win32.join(...segments) : path.posix.join(...segments);
}

export type IbcmdPathResolveResult =
  | { kind: 'resolved'; path: string }
  | { kind: 'notFound'; hint: string };

type Awaitable<T> = T | Promise<T>;

export interface IbcmdPathResolverDeps {
  exists: (filePath: string) => Awaitable<boolean>;
  readdir: (folderPath: string) => Awaitable<string[]>;
  stat: (filePath: string) => Awaitable<{ isDirectory(): boolean }>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Optional override for tests; default uses asynchronous `where` / `which`. */
  findOnSystemPath?: () => Awaitable<string | null>;
}

function sortVersionishDesc(names: string[]): string[] {
  return [...names].sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' })
  );
}

async function isDir(deps: IbcmdPathResolverDeps, candidatePath: string): Promise<boolean> {
  try {
    return (await deps.stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function safeReaddir(
  deps: IbcmdPathResolverDeps,
  folderPath: string
): Promise<string[]> {
  try {
    return await deps.readdir(folderPath);
  } catch {
    return [];
  }
}

function collectProgramRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    return [...new Set(roots)];
  }
  return ['/opt'];
}

function isValidIbcmdPath(resolvedPath: string, platform: NodeJS.Platform): boolean {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const expectedExeName = platform === 'win32' ? 'ibcmd.exe' : 'ibcmd';
  return (
    platformPath.isAbsolute(resolvedPath) &&
    platformPath.basename(resolvedPath).toLowerCase() === expectedExeName
  );
}

async function defaultFindOnSystemPath(deps: IbcmdPathResolverDeps): Promise<string | null> {
  try {
    const command = deps.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, ['ibcmd'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: deps.platform === 'win32' ? 1024 * 1024 : 65536,
    });
    const line = String(stdout)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (line && isValidIbcmdPath(line, deps.platform) && (await deps.exists(line))) {
      return line;
    }
  } catch {
    // PATH lookup is best-effort only.
  }
  return null;
}

async function tryScan1cv8InstallRoot(
  installRoot: string,
  deps: IbcmdPathResolverDeps,
  exeName: string
): Promise<string | null> {
  if (!(await deps.exists(installRoot))) {
    return null;
  }
  const level1 = sortVersionishDesc(await safeReaddir(deps, installRoot));
  for (const name1 of level1) {
    const firstLevelPath = joinForPlatform(deps.platform, installRoot, name1);
    if (!(await isDir(deps, firstLevelPath))) {
      continue;
    }
    const firstLevelExecutable = joinForPlatform(
      deps.platform,
      firstLevelPath,
      'bin',
      exeName
    );
    if (await deps.exists(firstLevelExecutable)) {
      return firstLevelExecutable;
    }
    const level2 = sortVersionishDesc(await safeReaddir(deps, firstLevelPath));
    for (const name2 of level2) {
      const secondLevelPath = joinForPlatform(deps.platform, firstLevelPath, name2);
      if (!(await isDir(deps, secondLevelPath))) {
        continue;
      }
      const secondLevelExecutable = joinForPlatform(
        deps.platform,
        secondLevelPath,
        'bin',
        exeName
      );
      if (await deps.exists(secondLevelExecutable)) {
        return secondLevelExecutable;
      }
    }
  }
  return null;
}

export function createDefaultPathResolverDeps(): IbcmdPathResolverDeps {
  return {
    exists: async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (folderPath) => fs.readdir(folderPath),
    stat: (filePath) => fs.stat(filePath),
    env: process.env,
    platform: process.platform,
  };
}

/**
 * Resolves the executable without blocking the extension-host event loop.
 * Priority: configured path, IBCMD_PATH, system PATH, typical 1cv8 install roots.
 */
export async function resolveIbcmdPath(input: {
  settingsPath: string | undefined;
  envIbcmdPath: string | undefined;
  deps: IbcmdPathResolverDeps;
  autoDetect?: boolean;
}): Promise<IbcmdPathResolveResult> {
  const { settingsPath, envIbcmdPath, deps } = input;
  const autoDetect = input.autoDetect !== false;
  const exeName = deps.platform === 'win32' ? 'ibcmd.exe' : 'ibcmd';

  const configuredPath = settingsPath?.trim();
  if (configuredPath) {
    if (await deps.exists(configuredPath)) {
      return { kind: 'resolved', path: configuredPath };
    }
    return {
      kind: 'notFound',
      hint: `Configured path does not exist: ${configuredPath}`,
    };
  }

  const environmentPath = envIbcmdPath?.trim();
  if (environmentPath) {
    if (await deps.exists(environmentPath)) {
      return { kind: 'resolved', path: environmentPath };
    }
    return {
      kind: 'notFound',
      hint: `IBCMD_PATH is set but the file does not exist: ${environmentPath}`,
    };
  }

  if (!autoDetect) {
    return {
      kind: 'notFound',
      hint: 'Auto-detect is disabled (1cMetadataTree.ibcmd.autoDetect). Set 1cMetadataTree.ibcmd.path or IBCMD_PATH.',
    };
  }

  const fromPath = deps.findOnSystemPath
    ? await deps.findOnSystemPath()
    : await defaultFindOnSystemPath(deps);
  if (fromPath) {
    return { kind: 'resolved', path: fromPath };
  }

  for (const root of collectProgramRoots(deps.env, deps.platform)) {
    const hit = await tryScan1cv8InstallRoot(
      joinForPlatform(deps.platform, root, '1cv8'),
      deps,
      exeName
    );
    if (hit) {
      return { kind: 'resolved', path: hit };
    }
  }

  return {
    kind: 'notFound',
    hint: 'Not found in settings, IBCMD_PATH, PATH, or typical 1cv8 install directories.',
  };
}
