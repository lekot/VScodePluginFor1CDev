/**
 * Нормализация относительного пути к Configuration.xml для стабильного ключа привязки.
 */
export function normalizeConfigRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  const noDot = trimmed.replace(/^\.\/+/, '');
  return noDot.replace(/\/+/g, '/');
}

/** Составной ключ привязки внутри одного workspace folder. */
export function bindingKey(workspaceFolder: string, configRelativePath: string): string {
  return `${workspaceFolder}\0${normalizeConfigRelativePath(configRelativePath)}`;
}
