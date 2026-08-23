import { validateWorkspaceRelativePath } from '../services/configurationSession/pathBoundary';

/**
 * Нормализация относительного пути к Configuration.xml для стабильного ключа привязки.
 */
export function normalizeConfigRelativePath(relativePath: string): string {
  return validateWorkspaceRelativePath(relativePath);
}

export function isSafeConfigRelativePath(relativePath: string): boolean {
  try {
    validateWorkspaceRelativePath(relativePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Имя расширения из пути EDT `.../Extensions/<Имя>/.../Configuration.xml`
 * или Designer `.../ConfigurationExtensions/<Имя>/.../Configuration.xml`.
 */
export function detectIbcmdExtensionNameFromConfigRelativePath(configRelativePath: string): string | undefined {
  const norm = configRelativePath.replace(/\\/g, '/');
  const segments = norm.split('/');
  const containerIndex = segments.findIndex((segment) => {
    const lower = segment.trim().toLowerCase();
    return lower === 'extensions' || lower === 'configurationextensions';
  });
  if (containerIndex < 0) { return undefined; }
  const extensionName = segments.slice(containerIndex + 1).find((segment) => segment.trim().length > 0)?.trim();
  return extensionName || undefined;
}

/**
 * Составной ключ привязки внутри одного workspace folder.
 * Без имени расширения формат совпадает с Phase 2 (`folder\0path`) для обратной совместимости.
 */
export function bindingKey(
  workspaceFolder: string,
  configRelativePath: string,
  ibcmdExtensionName?: string,
): string {
  const norm = normalizeConfigRelativePath(configRelativePath);
  const ext = (ibcmdExtensionName ?? '').trim();
  if (!ext) {
    return `${workspaceFolder}\0${norm}`;
  }
  return `${workspaceFolder}\0${norm}\0${ext}`;
}
