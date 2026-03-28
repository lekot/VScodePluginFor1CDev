import type { ConfigurationBinding, InfobaseBindingsFileRoot } from './models/configurationBinding';
import { Logger } from '../utils/logger';

const DEFAULT_ROOT: InfobaseBindingsFileRoot = { schemaVersion: 1, bindings: [] };

/**
 * Парсит содержимое `infobase-bindings.json`. При ошибке возвращает пустой корень.
 */
export function parseBindingsFileJson(text: string): InfobaseBindingsFileRoot {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_ROOT };
    }
    const obj = parsed as Record<string, unknown>;
    const ver = obj.schemaVersion;
    if (ver !== 1) {
      Logger.warn(`bindingStorage: unsupported schemaVersion ${String(ver)}, resetting file shape`);
      return { ...DEFAULT_ROOT };
    }
    const raw = obj.bindings;
    if (!Array.isArray(raw)) {
      return { schemaVersion: 1, bindings: [] };
    }
    const bindings: ConfigurationBinding[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const b = item as Record<string, unknown>;
      const workspaceFolder = typeof b.workspaceFolder === 'string' ? b.workspaceFolder.trim() : '';
      const configRelativePath = typeof b.configRelativePath === 'string' ? b.configRelativePath.trim() : '';
      const massDeployment = b.massDeployment === true;
      const idsRaw = b.infobaseIds;
      const infobaseIds = Array.isArray(idsRaw)
        ? idsRaw.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      if (!workspaceFolder || !configRelativePath) {
        continue;
      }
      bindings.push({
        workspaceFolder,
        configRelativePath,
        infobaseIds,
        massDeployment,
      });
    }
    return { schemaVersion: 1, bindings };
  } catch (err) {
    Logger.warn('bindingStorage: failed to parse infobase-bindings.json', err);
    return { ...DEFAULT_ROOT };
  }
}

export function serializeBindingsFileJson(root: InfobaseBindingsFileRoot): string {
  const payload: InfobaseBindingsFileRoot = {
    schemaVersion: 1,
    bindings: root.bindings.map((b) => ({
      workspaceFolder: b.workspaceFolder,
      configRelativePath: b.configRelativePath,
      infobaseIds: [...b.infobaseIds],
      massDeployment: b.massDeployment,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
