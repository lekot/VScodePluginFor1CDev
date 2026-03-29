/**
 * Нормализация относительного пути к Configuration.xml для стабильного ключа привязки.
 */
export function normalizeConfigRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  const noDot = trimmed.replace(/^\.\/+/, '');
  return noDot.replace(/\/+/g, '/');
}

/**
 * Имя расширения из пути вида `.../Extensions/<Имя>/.../Configuration.xml` (WOW Phase 4 #64).
 */
export function detectIbcmdExtensionNameFromConfigRelativePath(configRelativePath: string): string | undefined {
  const norm = configRelativePath.replace(/\\/g, '/');
  const lower = norm.toLowerCase();
  const token = '/extensions/';
  const idx = lower.indexOf(token);
  if (idx < 0) {
    return undefined;
  }
  const after = norm.slice(idx + token.length);
  const seg = after.split('/').find((s) => s.trim().length > 0)?.trim();
  return seg || undefined;
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
