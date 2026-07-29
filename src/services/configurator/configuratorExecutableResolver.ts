import * as path from 'path';
import type { InfobaseEntry } from '../../infobases/models/infobaseEntry';
import {
  createDefaultPlatformDetectorDeps,
  discoverPlatformInstallations,
  inferVersionFromExePath,
  type PlatformDetectorDeps,
  type PlatformInstall,
} from '../platformDetector';
import { getPlatformPathSetting } from '../metadataTreeSettings';

export type ConfiguratorExecutableSource = 'settings' | 'discovery';

export type ConfiguratorExecutableResolution =
  | {
      status: 'resolved';
      path: string;
      version: string;
      source: ConfiguratorExecutableSource;
    }
  | {
      status: 'failed';
      errorCode:
        | 'CONFIGURATOR_TARGET_UNSUPPORTED'
        | 'CONFIGURATOR_EXECUTABLE_NOT_FOUND'
        | 'CONFIGURATOR_EXECUTABLE_INVALID'
        | 'CONFIGURATOR_PLATFORM_VERSION_UNKNOWN'
        | 'CONFIGURATOR_PLATFORM_VERSION_MISMATCH';
      message: string;
    };

export interface ConfiguratorExecutableResolverOptions {
  configuredPath?: string;
  requiredVersion?: string;
  detectorDeps?: PlatformDetectorDeps;
  discoverInstalls?: (deps: PlatformDetectorDeps) => PlatformInstall[];
}

/** Non-interactive, deterministic resolver for the thick 1C Designer executable. */
export function resolveConfiguratorExecutable(
  entry: InfobaseEntry,
  options: ConfiguratorExecutableResolverOptions = {}
): ConfiguratorExecutableResolution {
  if (entry.type !== 'file') {
    return {
      status: 'failed',
      errorCode: 'CONFIGURATOR_TARGET_UNSUPPORTED',
      message: 'Configurator support operations require a file infobase.',
    };
  }

  const deps = options.detectorDeps ?? createDefaultPlatformDetectorDeps();
  const requiredVersion = (
    options.requiredVersion ?? entry.launchSettings?.platformVersion ?? ''
  ).trim();
  const configuredPath = options.configuredPath ?? getPlatformPathSetting();

  if (configuredPath.trim()) {
    const executable = resolveConfiguredThickExecutable(configuredPath, deps);
    if (!executable) {
      return {
        status: 'failed',
        errorCode: 'CONFIGURATOR_EXECUTABLE_INVALID',
        message: `Configured platform path does not resolve to the thick Designer executable: ${configuredPath}`,
      };
    }
    const version = inferVersionFromExePath(executable, deps.platform);
    if (!version || version === 'PATH') {
      return {
        status: 'failed',
        errorCode: 'CONFIGURATOR_PLATFORM_VERSION_UNKNOWN',
        message: `Cannot determine the exact platform version from configured executable: ${executable}`,
      };
    }
    if (requiredVersion && version !== requiredVersion) {
      return {
        status: 'failed',
        errorCode: 'CONFIGURATOR_PLATFORM_VERSION_MISMATCH',
        message: `Configured platform version ${version} does not match required ${requiredVersion}.`,
      };
    }
    return { status: 'resolved', path: executable, version, source: 'settings' };
  }

  const discover = options.discoverInstalls ?? discoverPlatformInstallations;
  const discovered = discover(deps)
    .filter((install) => !requiredVersion || install.version === requiredVersion)
    .filter((install) => !entry.launchSettings?.bitness || install.bitness === entry.launchSettings.bitness)
    .filter((install) => install.version !== 'PATH')
    .sort(compareInstallsDeterministically);

  const selected = discovered[0];
  if (!selected) {
    return {
      status: 'failed',
      errorCode: 'CONFIGURATOR_EXECUTABLE_NOT_FOUND',
      message: requiredVersion
        ? `Thick 1C platform ${requiredVersion} was not found.`
        : 'A versioned thick 1C platform installation was not found.',
    };
  }
  return {
    status: 'resolved',
    path: selected.thickExe,
    version: selected.version,
    source: 'discovery',
  };
}

function resolveConfiguredThickExecutable(
  configuredPath: string,
  deps: PlatformDetectorDeps
): string | undefined {
  const value = configuredPath.trim();
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix;
  const thickName = deps.platform === 'win32' ? '1cv8.exe' : '1cv8';
  try {
    if (!deps.existsSync(value)) {
      return undefined;
    }
    if (!deps.statSync(value).isDirectory()) {
      return pathApi.basename(value).toLocaleLowerCase() === thickName.toLocaleLowerCase()
        ? value
        : undefined;
    }
    const candidates = [
      pathApi.join(value, thickName),
      pathApi.join(value, 'bin', thickName),
    ];
    return candidates.find((candidate) => deps.existsSync(candidate));
  } catch {
    return undefined;
  }
}

function compareInstallsDeterministically(left: PlatformInstall, right: PlatformInstall): number {
  const versionOrder = right.version.localeCompare(left.version, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (versionOrder !== 0) {
    return versionOrder;
  }
  if (left.bitness !== right.bitness) {
    return left.bitness === '64' ? -1 : 1;
  }
  return left.thickExe.localeCompare(right.thickExe, undefined, { sensitivity: 'base' });
}
