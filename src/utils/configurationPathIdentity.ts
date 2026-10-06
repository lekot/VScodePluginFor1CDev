import * as path from 'path';

/** Returns the normalized absolute host path used to identify one configuration root. */
export function configurationPathKey(configPath: string): string {
  const resolved = path.resolve(configPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
