import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseLaunchSettings } from '../infobases/models/infobaseEntry';
import {
  createDefaultPlatformDetectorDeps,
  discoverPlatformInstallations,
  filterPlatformInstallsForLaunch,
  type PlatformBitness,
  type PlatformDetectorDeps,
  type PlatformInstall,
} from './platformDetector';
import { getPlatformPathSetting, PLATFORM_PATH_SETTINGS_QUERY } from './metadataTreeSettings';

/**
 * WOW Infobase Manager §1F — resolve 1cv8/1cv8c and build CLI for Enterprise / Designer.
 */

export type PlatformLaunchMode = 'enterprise' | 'designer';

function defaultPreferredBitness(): PlatformBitness {
  return os.arch() === 'x64' || os.arch() === 'arm64' ? '64' : '32';
}

/** Если в настройках указан толстый клиент, подменяем на 1cv8c рядом (WOW §3C #55 — веб по /WS). */
function coerceSettingsPathToThinClient(
  fromSettings: string,
  deps: ReturnType<typeof createDefaultPlatformDetectorDeps>,
): string | undefined {
  const base = path.basename(fromSettings);
  const lower = base.toLowerCase();
  const dir = path.dirname(fromSettings);
  if (deps.platform === 'win32') {
    if (lower === '1cv8c.exe') {
      return fromSettings;
    }
    if (lower === '1cv8.exe') {
      const thin = path.join(dir, '1cv8c.exe');
      return deps.existsSync(thin) ? thin : undefined;
    }
  } else {
    if (lower === '1cv8c') {
      return fromSettings;
    }
    if (lower === '1cv8') {
      const thin = path.join(dir, '1cv8c');
      return deps.existsSync(thin) ? thin : undefined;
    }
  }
  return undefined;
}

function tryResolveSettingsPlatformPath(raw: string, deps: ReturnType<typeof createDefaultPlatformDetectorDeps>): string | null {
  const t = raw.trim();
  if (!t) {
    return null;
  }
  try {
    if (deps.existsSync(t) && !deps.statSync(t).isDirectory()) {
      return t;
    }
    if (deps.existsSync(t) && deps.statSync(t).isDirectory()) {
      const thick = deps.platform === 'win32' ? '1cv8.exe' : '1cv8';
      const thin = deps.platform === 'win32' ? '1cv8c.exe' : '1cv8c';
      const candidates = [
        path.join(t, thick),
        path.join(t, thin),
        path.join(t, 'bin', thick),
        path.join(t, 'bin', thin),
      ];
      for (const c of candidates) {
        if (deps.existsSync(c)) {
          return c;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function preferBitnessOrder(installs: PlatformInstall[], preferred: PlatformBitness): PlatformInstall[] {
  const pri = installs.filter((i) => i.bitness === preferred);
  const sec = installs.filter((i) => i.bitness !== preferred);
  return [...pri, ...sec];
}

function pickExeForClient(
  install: PlatformInstall,
  client: InfobaseLaunchSettings['clientType'] | undefined,
  mode: PlatformLaunchMode,
): string {
  if (mode === 'designer') {
    return install.thickExe;
  }
  if (client === 'thick') {
    return install.thickExe;
  }
  if (client === 'thin' || client === 'web' || client === undefined) {
    return install.thinExe ?? install.thickExe;
  }
  return install.thinExe ?? install.thickExe;
}

function labelForInstall(i: PlatformInstall): string {
  const clientHint = i.thinExe ? 'тонкий+толстый' : 'толстый';
  return `${i.version} (${i.bitness}-bit, ${clientHint}) — ${i.thickExe}`;
}

async function quickPickInstall(
  items: PlatformInstall[],
  mode: PlatformLaunchMode,
): Promise<PlatformInstall | undefined> {
  const sorted = [...items].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const picked = await vscode.window.showQuickPick(
    sorted.map((i) => ({
      label: labelForInstall(i),
      install: i,
    })),
    {
      title: mode === 'designer' ? 'Конфигуратор — выбор платформы' : '1С:Предприятие — выбор платформы',
      placeHolder: 'Выберите версию и разрядность',
    },
  );
  if (!picked) {
    return undefined;
  }
  return picked.install;
}

async function openSettingsHint(message: string): Promise<void> {
  const pick = await vscode.window.showErrorMessage(message, 'Открыть настройки');
  if (pick === 'Открыть настройки') {
    await vscode.commands.executeCommand('workbench.action.openSettings', PLATFORM_PATH_SETTINGS_QUERY);
  }
}

export type ResolveLaunchExecutableOptions = {
  /** Override discovery (used by tests; default: full scan via {@link discoverPlatformInstallations}). */
  discoverInstalls?: (deps: PlatformDetectorDeps) => PlatformInstall[];
};

/**
 * Resolves path to 1cv8.exe / 1cv8c.exe (or POSIX `1cv8` / `1cv8c`) for the given catalog entry.
 * В режиме конфигуратора всегда толстый клиент (1cv8).
 */
export async function resolveLaunchExecutable(
  entry: InfobaseEntry,
  mode: PlatformLaunchMode = 'enterprise',
  options?: ResolveLaunchExecutableOptions,
): Promise<string | undefined> {
  const deps = createDefaultPlatformDetectorDeps();
  const settingsRaw = getPlatformPathSetting();

  const fromSettings = tryResolveSettingsPlatformPath(settingsRaw, deps);
  if (fromSettings) {
    if (mode === 'designer') {
      const thick = deps.platform === 'win32' ? '1cv8.exe' : '1cv8';
      const base = path.basename(fromSettings);
      if (base.toLowerCase() !== thick.toLowerCase()) {
        await openSettingsHint(
          'Для Конфигуратора нужен толстый клиент (1cv8). В настройках указан другой исполняемый файл.',
        );
        return undefined;
      }
    }
    if (entry.type === 'web' && entry.launchSettings?.clientType === 'thin') {
      const thin = coerceSettingsPathToThinClient(fromSettings, deps);
      if (thin) {
        return thin;
      }
      await openSettingsHint(
        'Для запуска веб-базы в тонком клиенте укажите в настройках путь к 1cv8c (или к каталогу bin, где есть 1cv8c).',
      );
      return undefined;
    }
    return fromSettings;
  }
  if (settingsRaw.trim()) {
    await openSettingsHint(`Путь к платформе 1С не найден: ${settingsRaw}`);
    return undefined;
  }

  const all = (options?.discoverInstalls ?? discoverPlatformInstallations)(deps);
  const constrained = filterPlatformInstallsForLaunch(all, entry.launchSettings);
  if (entry.launchSettings?.platformVersion && constrained.length === 0) {
    await openSettingsHint(
      `Платформа версии «${entry.launchSettings.platformVersion}» не найдена. Укажите путь вручную или проверьте установку 1С.`,
    );
    return undefined;
  }
  if (entry.launchSettings?.bitness && constrained.length === 0) {
    await openSettingsHint(
      `Не найдена установка 1С с разрядностью ${entry.launchSettings.bitness}. Укажите путь к платформе в настройках.`,
    );
    return undefined;
  }

  const pool = constrained.length > 0 ? constrained : all;
  const ordered = preferBitnessOrder(pool, defaultPreferredBitness());
  const client = entry.launchSettings?.clientType;

  if (ordered.length === 1) {
    return pickExeForClient(ordered[0], client, mode);
  }

  const picked = await quickPickInstall(ordered, mode);
  if (!picked) {
    return undefined;
  }
  return pickExeForClient(picked, client, mode);
}

function modeToken(mode: PlatformLaunchMode): string {
  return mode === 'designer' ? 'DESIGNER' : 'ENTERPRISE';
}

/** `/F"path"` for Windows file infobase; POSIX-safe quoting. */
function fileConnectionArg(filePath: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === 'win32' ? path.win32.resolve(filePath).replace(/\//g, '\\') : path.posix.resolve(filePath);
  const safe = normalized.replace(/"/g, '');
  return `/F"${safe}"`;
}

function ibNameArg(name: string, platform: NodeJS.Platform): string {
  const safe = name.replace(/"/g, '');
  return platform === 'win32' ? `/IBName"${safe}"` : `/IBName"${safe}"`;
}

function serverArg(server: string, platform: NodeJS.Platform): string {
  const safe = server.replace(/"/g, '');
  return platform === 'win32' ? `/S"${safe}"` : `/S"${safe}"`;
}

function userArg(user: string, platform: NodeJS.Platform): string {
  const safe = user.replace(/"/g, '');
  return platform === 'win32' ? `/N"${safe}"` : `/N"${safe}"`;
}

function passwordArg(password: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `/P"${password.replace(/"/g, '')}"` : `/P"${password.replace(/"/g, '')}"`;
}

/**
 * Builds 1C startup arguments (after executable name).
 */
export function buildLaunchArgs(
  entry: InfobaseEntry,
  mode: PlatformLaunchMode,
  platform: NodeJS.Platform,
  creds?: { user?: string; password?: string },
): string[] {
  const args: string[] = [modeToken(mode)];

  if (entry.type === 'file') {
    const fp = entry.filePath;
    if (!fp?.trim()) {
      throw new Error('Infobase filePath is empty');
    }
    args.push(fileConnectionArg(fp, platform));
  } else if (entry.type === 'server') {
    const srv = entry.server?.trim();
    const db = entry.database?.trim();
    if (!srv || !db) {
      throw new Error('Server infobase requires server and database');
    }
    args.push(serverArg(srv, platform), ibNameArg(db, platform));
  } else {
    throw new Error('Web infobase does not use 1cv8 CLI');
  }

  if (creds?.user?.trim()) {
    args.push(userArg(creds.user.trim(), platform));
    if (creds.password !== undefined && creds.password.length > 0) {
      args.push(passwordArg(creds.password, platform));
    }
  }

  return args;
}

export async function openWebInfobaseInBrowser(webUrl: string): Promise<boolean> {
  const u = webUrl.trim();
  if (!u) {
    return false;
  }
  return vscode.env.openExternal(vscode.Uri.parse(u));
}

/**
 * Аргументы командной строки для тонкого клиента: подключение к опубликованной веб-базе (WOW §3C #55).
 * См. документацию платформы 1С: режим ENTERPRISE и ключ `/WS` с URL публикации.
 */
export function buildWebInfobaseEnterpriseArgs(webUrl: string): string[] {
  const u = webUrl.trim();
  if (!u) {
    throw new Error('Web URL is empty');
  }
  const safe = u.replace(/"/g, '');
  return [modeToken('enterprise'), `/WS"${safe}"`];
}

/**
 * Запуск веб-базы через 1cv8c с ключом `/WS` (в отличие от {@link openWebInfobaseInBrowser}).
 */
export async function launchWebInfobaseThinClient(
  entry: InfobaseEntry,
  options?: ResolveLaunchExecutableOptions,
): Promise<boolean> {
  const url = entry.webUrl?.trim() ?? '';
  if (!url || entry.type !== 'web') {
    return false;
  }
  const exe = await resolveLaunchExecutable(entry, 'enterprise', options);
  if (!exe) {
    return false;
  }
  const deps = createDefaultPlatformDetectorDeps();
  const thin = coerceSettingsPathToThinClient(exe, deps);
  const launchExe = thin ?? exe;
  const base = path.basename(launchExe).toLowerCase();
  const okThin = deps.platform === 'win32' ? base === '1cv8c.exe' : base === '1cv8c';
  if (!okThin) {
    await openSettingsHint(
      'Для веб-базы в тонком клиенте нужен исполняемый файл 1cv8c. Укажите путь к платформе в настройках.',
    );
    return false;
  }
  try {
    const args = buildWebInfobaseEnterpriseArgs(url);
    spawnPlatformProcess(launchExe, args);
  } catch (err) {
    void vscode.window.showErrorMessage(`Запуск тонкого клиента (веб): ${(err as Error).message}`);
    return false;
  }
  return true;
}

/**
 * Starts 1C platform detached from the extension host.
 */
export function spawnPlatformProcess(exe: string, args: string[]): void {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.on('error', (err) => {
    void vscode.window.showErrorMessage(`Не удалось запустить платформу 1С: ${(err as Error).message}`);
  });
  child.unref();
}

