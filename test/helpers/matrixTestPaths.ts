import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Repo root when compiled under `out/test/helpers/`.
 */
export function getRepoRootFromCompiledTestFile(): string {
  return path.resolve(path.join(__dirname, '..', '..', '..'));
}

/**
 * Copies `FormatSamples/empty_conf` into a unique directory under the system temp dir.
 */
export function copyEmptyConfFixtureToTemp(): string {
  const repoRoot = getRepoRootFromCompiledTestFile();
  const src = path.join(repoRoot, 'FormatSamples', 'empty_conf');
  if (!fs.existsSync(src)) {
    throw new Error(`Fixture not found: ${src}`);
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-matrix-empty-conf-'));
  const dest = path.join(parent, 'empty_conf');
  fs.cpSync(src, dest, { recursive: true });
  return path.resolve(dest);
}

/**
 * Minimal `ExtensionContext` for template resolution (no `vscode` runtime — for Node core tests).
 */
export function createMatrixExtensionContext(): { asAbsolutePath: (rel: string) => string } {
  const repoRoot = getRepoRootFromCompiledTestFile();
  return {
    asAbsolutePath: (rel: string) => path.join(repoRoot, rel),
  };
}
