import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

suite('Mutation writer architecture guard', () => {
  let tmpDir: string;
  let sourceRoot: string;
  let baselinePath: string;
  const repoRoot = path.resolve(__dirname, '../../..');
  const guardPath = path.join(repoRoot, 'scripts', 'check-mutation-writer-baseline.js');

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-mutation-writer-guard-');
    sourceRoot = path.join(tmpDir, 'src');
    baselinePath = path.join(tmpDir, 'baseline.json');
    await fs.promises.mkdir(sourceRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceRoot, 'writer.ts'),
      `import * as fs from 'fs';
export async function save(target: string): Promise<void> {
  await fs.promises.writeFile(target, 'content', 'utf8');
}
`,
      'utf8',
    );
    await fs.promises.writeFile(baselinePath, JSON.stringify({ version: 1, sites: [] }), 'utf8');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  function runGuard(...args: string[]) {
    return spawnSync(
      process.execPath,
      [guardPath, '--source-root', sourceRoot, '--baseline', baselinePath, ...args],
      { encoding: 'utf8' },
    );
  }

  test('warns for new filesystem writes and remains non-blocking in baseline mode', () => {
    const result = runGuard();
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /unbaselined direct filesystem mutation call/);
    assert.match(result.stderr, /src\/writer\.ts:\d+ writeFile in save/);
  });

  test('detects mutations through a named fs.promises import alias', async () => {
    await fs.promises.writeFile(
      path.join(sourceRoot, 'writer.ts'),
      `import { promises as io } from 'fs';
export async function save(target: string): Promise<void> {
  await io.writeFile(target, 'content', 'utf8');
}
`,
      'utf8',
    );

    const result = runGuard();
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /unbaselined direct filesystem mutation call/);
    assert.match(result.stderr, /src\/writer\.ts:\d+ writeFile in save/);
  });

  test('baseline suppresses existing calls but reports an added writer', () => {
    const update = runGuard('--write-baseline');
    assert.strictEqual(update.status, 0, update.stderr);

    const clean = runGuard();
    assert.strictEqual(clean.status, 0, clean.stderr);
    assert.doesNotMatch(clean.stderr, /unbaselined/);

    fs.appendFileSync(
      path.join(sourceRoot, 'writer.ts'),
      `\nexport async function move(source: string, target: string): Promise<void> {
  await fs.promises.rename(source, target);
}
`,
      'utf8',
    );
    const added = runGuard();
    assert.strictEqual(added.status, 0, added.stderr);
    assert.match(added.stderr, /rename in move/);
  });

  test('strict XML writer boundary rejects a counterfactual raw write regardless of baseline', async () => {
    const protectedWriterPath = path.join(sourceRoot, 'utils', 'XMLWriter.ts');
    await fs.promises.mkdir(path.dirname(protectedWriterPath), { recursive: true });
    await fs.promises.writeFile(
      protectedWriterPath,
      `export async function createMinimalElementFile(): Promise<void> {
  return;
}
`,
      'utf8',
    );

    const clean = runGuard('--enforce-files', 'src/utils/XMLWriter.ts');
    assert.strictEqual(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /XML writer boundary passed/);

    await fs.promises.writeFile(
      protectedWriterPath,
      `import * as fs from 'fs';
export async function createMinimalElementFile(target: string): Promise<void> {
  await fs.promises.writeFile(target, '<Catalog/>', 'utf8');
}
`,
      'utf8',
    );

    const violating = runGuard('--enforce-files', 'src/utils/XMLWriter.ts');
    assert.notStrictEqual(violating.status, 0);
    assert.match(violating.stderr, /XML writer boundary failed/);
    assert.match(violating.stderr, /src\/utils\/XMLWriter\.ts:\d+ writeFile in createMinimalElementFile/);
  });
});
