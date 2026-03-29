/**
 * ibcmd в режиме offline ожидает каталог данных автономного сервера (`--data=…`), см. Administrator Guide
 * и `ibcmdrunner.УстановитьПараметрыАвтономногоСервера`. Без него подключение по YAML из spawn часто
 * «падает» в `…/db-data/1Cv8.1CD.cfl` под `%LocalAppData%` или рядом с несуществующей разметкой.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

function resolveExistingPathToLongOnWin32Local(absPath: string): string {
  const t = absPath.trim();
  if (process.platform !== 'win32' || !t) {
    return t;
  }
  try {
    if (fs.existsSync(t)) {
      return fs.realpathSync.native(t);
    }
  } catch {
    /* keep logical path */
  }
  return t;
}

export interface IbcmdOfflineDataDirHandle {
  readonly path: string;
  readonly dispose: () => Promise<void>;
}

/**
 * Пустой каталог под `--data` для одной операции ibcmd; после операции удалить {@link dispose}.
 */
export async function createIbcmdOfflineServerDataDir(entryId: string): Promise<IbcmdOfflineDataDirHandle> {
  const safeId = entryId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'ib';
  const prefix = path.join(os.tmpdir(), `1cviewer-ibcmd-data-${safeId}-`);
  const dir = await fs.promises.mkdtemp(prefix);
  const logical = path.resolve(dir);
  const canonical = resolveExistingPathToLongOnWin32Local(logical);
  const dispose = async (): Promise<void> => {
    try {
      await fs.promises.rm(canonical, { recursive: true, force: true });
    } catch {
      try {
        await fs.promises.rm(logical, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
  return { path: canonical, dispose };
}

/** Уникальный суффикс для имён в tmp (тесты / несколько параллельных вызовов). */
export function randomIbcmdTempSuffix(): string {
  return randomBytes(8).toString('hex');
}
