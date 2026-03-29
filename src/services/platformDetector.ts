import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * WOW Infobase Manager §1F — discover installed 1C platform builds (1cv8 / 1cv8c).
 * Mirrors scan strategy of {@link ./ibcmd/IbcmdPathResolver} for `1cv8` install roots.
 */

export type PlatformBitness = '32' | '64';

export interface PlatformInstall {
  /** Directory name under `1cv8` (e.g. `8.3.24.1467`). */
  version: string;
  bitness: PlatformBitness;
  thickExe: string;
  /** Thin client when present in the same `bin` folder. */
  thinExe?: string;
}

export type PlatformDetectorDeps = {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  findOnSystemPath?: (exeName: string) => string | null;
};

function joinForPlatform(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32' ? path.win32.join(...segments) : path.posix.join(...segments);
}

function sortVersionishDesc(names: string[]): string[] {
  return [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
}

function isDir(deps: PlatformDetectorDeps, p: string): boolean {
  try {
    return deps.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(deps: PlatformDetectorDeps, p: string): string[] {
  try {
    return deps.readdirSync(p);
  } catch {
    return [];
  }
}

function collectProgramRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return [...new Set(roots)];
  }
  return ['/opt'];
}

function thickName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '1cv8.exe' : '1cv8';
}

function thinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '1cv8c.exe' : '1cv8c';
}

function pushIfThick(
  deps: PlatformDetectorDeps,
  version: string,
  bitness: PlatformBitness,
  binDir: string,
  out: PlatformInstall[],
): void {
  const thick = joinForPlatform(deps.platform, binDir, thickName(deps.platform));
  if (!deps.existsSync(thick)) {
    return;
  }
  const thinPath = joinForPlatform(deps.platform, binDir, thinName(deps.platform));
  const thinExe = deps.existsSync(thinPath) ? thinPath : undefined;
  out.push({ version, bitness, thickExe: thick, thinExe });
}

function scanVersionTree(installRoot: string, deps: PlatformDetectorDeps, bitness: PlatformBitness, out: PlatformInstall[]): void {
  if (!deps.existsSync(installRoot)) {
    return;
  }
  const level1 = sortVersionishDesc(safeReaddir(deps, installRoot));
  for (const name1 of level1) {
    const p1 = joinForPlatform(deps.platform, installRoot, name1);
    if (!isDir(deps, p1)) {
      continue;
    }
    const bin1 = joinForPlatform(deps.platform, p1, 'bin');
    if (isDir(deps, bin1)) {
      pushIfThick(deps, name1, bitness, bin1, out);
    }
    const level2 = sortVersionishDesc(safeReaddir(deps, p1));
    for (const name2 of level2) {
      const p2 = joinForPlatform(deps.platform, p1, name2);
      if (!isDir(deps, p2)) {
        continue;
      }
      const bin2 = joinForPlatform(deps.platform, p2, 'bin');
      if (isDir(deps, bin2)) {
        pushIfThick(deps, name2, bitness, bin2, out);
      }
    }
  }
}

function defaultFindExeOnPath(deps: PlatformDetectorDeps, exeName: string): string | null {
  try {
    if (deps.platform === 'win32') {
      const out = execFileSync('where.exe', [exeName], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (line && deps.existsSync(line)) {
        return line;
      }
    } else {
      const out = execFileSync('which', [exeName], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 65536,
      });
      const line = out.trim().split('\n')[0]?.trim();
      if (line && deps.existsSync(line)) {
        return line;
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

/**
 * Infer `8.3.x` folder name from a path like `...\1cv8\8.3.xx\bin\1cv8.exe`.
 */
export function inferVersionFromExePath(exePath: string, platform: NodeJS.Platform): string | undefined {
  const norm = platform === 'win32' ? exePath.replace(/\//g, '\\') : exePath;
  const parts = norm.split(platform === 'win32' ? '\\' : '/').filter(Boolean);
  const binIdx = parts.lastIndexOf('bin');
  if (binIdx <= 0) {
    return undefined;
  }
  return parts[binIdx - 1];
}

function installFromExePath(fullPath: string, deps: PlatformDetectorDeps): PlatformInstall | null {
  const thick = thickName(deps.platform);
  const base = path.basename(fullPath);
  if (base.toLowerCase() !== thick.toLowerCase()) {
    return null;
  }
  const ver = inferVersionFromExePath(fullPath, deps.platform) ?? 'PATH';
  const binDir = path.dirname(fullPath);
  const thinPath = joinForPlatform(deps.platform, binDir, thinName(deps.platform));
  const thinExe = deps.existsSync(thinPath) ? thinPath : undefined;
  const bitness: PlatformBitness = fullPath.toLowerCase().includes('program files (x86)') ? '32' : '64';
  return { version: ver, bitness, thickExe: fullPath, thinExe };
}

function dedupeByThick(installs: PlatformInstall[]): PlatformInstall[] {
  const seen = new Set<string>();
  const out: PlatformInstall[] = [];
  for (const i of installs) {
    const k = i.thickExe.toLowerCase();
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(i);
  }
  return out;
}

/**
 * Lists installed platforms under standard roots and PATH (thick client), newest-friendly order preserved per root scan.
 */
export function discoverPlatformInstallations(deps: PlatformDetectorDeps): PlatformInstall[] {
  const out: PlatformInstall[] = [];
  const thick = thickName(deps.platform);

  for (const root of collectProgramRoots(deps.env, deps.platform)) {
    const bitness: PlatformBitness = root.toLowerCase().includes('(x86)') ? '32' : '64';
    scanVersionTree(joinForPlatform(deps.platform, root, '1cv8'), deps, bitness, out);
  }

  const findPath = deps.findOnSystemPath ?? ((n: string) => defaultFindExeOnPath(deps, n));
  const fromPath = findPath(thick);
  if (fromPath) {
    const ins = installFromExePath(fromPath, deps);
    if (ins) {
      out.push(ins);
    }
  }

  return dedupeByThick(out);
}

export function createDefaultPlatformDetectorDeps(): PlatformDetectorDeps {
  return {
    existsSync: fs.existsSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    statSync: fs.statSync.bind(fs),
    env: process.env,
    platform: process.platform,
  };
}

/** Совместимо с {@link InfobaseEntry.launchSettings} (design §15). */
export type InfobaseLaunchSettingsLike = {
  platformVersion?: string;
  clientType?: 'thin' | 'thick' | 'web';
  bitness?: '32' | '64';
};

/**
 * Сужает список установок по {@link InfobaseEntry.launchSettings} (design §15.2, WOW §1F #24).
 * Если указана версия платформы, но нет ни точного, ни «мягкого» совпадения — возвращает пустой список.
 */
export function filterPlatformInstallsForLaunch(
  installs: PlatformInstall[],
  ls: InfobaseLaunchSettingsLike | undefined,
): PlatformInstall[] {
  let r = installs;
  if (ls?.bitness) {
    r = r.filter((i) => i.bitness === ls.bitness);
  }
  if (ls?.platformVersion?.trim()) {
    const v = ls.platformVersion.trim();
    const exact = r.filter((i) => i.version === v);
    if (exact.length) {
      r = exact;
    } else {
      const loose = r.filter(
        (i) => i.version.startsWith(v) || v.startsWith(i.version) || i.version.includes(v),
      );
      r = loose;
    }
  }
  return r;
}

/**
 * Выбор exe для режима Предприятие / Конфигуратор.
 */
export function pickPlatformClientExecutable(
  install: PlatformInstall,
  ls: InfobaseLaunchSettingsLike | undefined,
  role: 'enterprise' | 'designer',
): { exe: string; usedClient: 'thick' | 'thin' } | null {
  if (role === 'designer') {
    return { exe: install.thickExe, usedClient: 'thick' };
  }
  const wantThin = ls?.clientType !== 'thick';
  if (wantThin && install.thinExe) {
    return { exe: install.thinExe, usedClient: 'thin' };
  }
  return { exe: install.thickExe, usedClient: 'thick' };
}
