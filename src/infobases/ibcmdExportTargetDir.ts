import * as fs from 'fs';
import * as path from 'path';

/**
 * Удаляет всё содержимое каталога; сам каталог остаётся.
 * `ibcmd infobase config export` требует пустой каталог назначения.
 */
export async function emptyDirectoryContents(dir: string): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map((e) => fs.promises.rm(path.join(dir, e.name), { recursive: true, force: true })),
  );
}
