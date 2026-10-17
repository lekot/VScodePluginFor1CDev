import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

suite('LOC budget architecture guard (#201)', () => {
  let tmpDir: string;
  let sourceRoot: string;
  let baselinePath: string;
  const repoRoot = path.resolve(__dirname, '../../..');
  const guardScript = path.join(repoRoot, 'scripts', 'check-loc-budget.js');

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-loc-budget-guard-');
    sourceRoot = path.join(tmpDir, 'src');
    baselinePath = path.join(tmpDir, 'baseline.json');
    await fs.promises.mkdir(sourceRoot, { recursive: true });

    // Create a small compliant file (10 lines)
    const smallContent = Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n');
    await fs.promises.writeFile(path.join(sourceRoot, 'small.ts'), smallContent, 'utf8');

    // Create baseline with threshold 50 for testing
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify(
        {
          version: 1,
          threshold: 50,
          allowedHotspots: {},
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  function runGuard(...args: string[]) {
    return spawnSync(
      process.execPath,
      [guardScript, '--source-root', sourceRoot, '--baseline', baselinePath, ...args],
      { encoding: 'utf8' },
    );
  }

  test('passes when all files are under the threshold', () => {
    const res = runGuard();
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Passed: verified 1 TypeScript files/);
  });

  test('fails when a new file exceeds the threshold without baseline entry', async () => {
    // 60 lines file when threshold is 50
    const largeContent = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n');
    await fs.promises.writeFile(path.join(sourceRoot, 'large.ts'), largeContent, 'utf8');

    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail on unbaselined file exceeding threshold');
    assert.match(res.stderr, /FAIL \[NEW_LARGE_FILE\]/);
    assert.match(res.stderr, /exceeds LOC threshold of 50 lines/);
  });

  test('passes when file is baselined within allowed limit', async () => {
    const largeContent = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n');
    await fs.promises.writeFile(path.join(sourceRoot, 'large.ts'), largeContent, 'utf8');

    // Add to baseline with maxLines: 65
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify(
        {
          version: 1,
          threshold: 50,
          allowedHotspots: {
            'src/large.ts': { maxLines: 65, reason: 'Test hotspot' },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const res = runGuard();
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /1 legacy hotspots within approved baseline limits/);
  });

  test('fails when a baselined file exceeds its approved limit', async () => {
    // 70 lines file when baseline limit is 65
    const grownContent = Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`).join('\n');
    await fs.promises.writeFile(path.join(sourceRoot, 'large.ts'), grownContent, 'utf8');

    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify(
        {
          version: 1,
          threshold: 50,
          allowedHotspots: {
            'src/large.ts': { maxLines: 65, reason: 'Test hotspot' },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail when baselined file grows beyond limit');
    assert.match(res.stderr, /FAIL \[BASELINE_GROWTH\]/);
    assert.match(res.stderr, /exceeding its baseline limit of 65 lines/);
  });

  test('--write-baseline updates baseline with current file sizes', async () => {
    const largeContent = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n');
    await fs.promises.writeFile(path.join(sourceRoot, 'large.ts'), largeContent, 'utf8');

    const updateRes = runGuard('--write-baseline', '--threshold', '50');
    assert.strictEqual(updateRes.status, 0, updateRes.stderr || updateRes.stdout);

    const updated = JSON.parse(await fs.promises.readFile(baselinePath, 'utf8'));
    assert.ok(updated.allowedHotspots['src/large.ts']);
    assert.strictEqual(updated.allowedHotspots['src/large.ts'].maxLines, 60);

    // Subsequent normal check now passes
    const checkRes = runGuard('--threshold', '50');
    assert.strictEqual(checkRes.status, 0, checkRes.stderr || checkRes.stdout);
  });

  test('production src directory satisfies production loc-budget-baseline.json', () => {
    const res = spawnSync(process.execPath, [guardScript], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /\[LOC Budget Guard\] Passed/);
  });
});
