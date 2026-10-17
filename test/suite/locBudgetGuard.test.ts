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

  test('fails when CLI threshold is non-numeric or non-positive', () => {
    const resNaN = runGuard('--threshold', 'oops');
    assert.strictEqual(resNaN.status, 1, 'Guard must fail on non-numeric threshold');
    assert.match(resNaN.stderr, /Invalid CLI --threshold/i);

    const resNeg = runGuard('--threshold', '-5');
    assert.strictEqual(resNeg.status, 1, 'Guard must fail on negative threshold');
    assert.match(resNeg.stderr, /Invalid CLI --threshold/i);

    const resZero = runGuard('--threshold', '0');
    assert.strictEqual(resZero.status, 1, 'Guard must fail on zero threshold');
    assert.match(resZero.stderr, /Invalid CLI --threshold/i);
  });

  test('fails when source root does not exist', () => {
    const res = runGuard('--source-root', path.join(tmpDir, 'non-existent-dir'));
    assert.strictEqual(res.status, 1, 'Guard must fail when source directory does not exist');
    assert.match(res.stderr, /Source directory does not exist/i);
  });

  test('fails when baseline JSON is malformed syntax', async () => {
    await fs.promises.writeFile(baselinePath, '{ malformed json syntax: ', 'utf8');
    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail on malformed JSON baseline');
    assert.match(res.stderr, /Failed to parse baseline JSON/i);
  });

  test('fails when baseline version is missing or unsupported', async () => {
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({ version: 99, threshold: 50, allowedHotspots: {} }),
      'utf8',
    );
    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail on unsupported baseline version');
    assert.match(res.stderr, /Unsupported baseline version/i);
  });

  test('fails when baseline threshold is non-numeric or non-positive', async () => {
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({ version: 1, threshold: 'oops', allowedHotspots: {} }),
      'utf8',
    );
    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail on non-numeric baseline threshold');
    assert.match(res.stderr, /Invalid baseline threshold/i);

    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({ version: 1, threshold: -10, allowedHotspots: {} }),
      'utf8',
    );
    const resNeg = runGuard();
    assert.strictEqual(resNeg.status, 1, 'Guard must fail on negative baseline threshold');
    assert.match(resNeg.stderr, /Invalid baseline threshold/i);
  });

  test('fails when hotspot entry has missing or invalid maxLines (fail-closed)', async () => {
    const largeContent = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n');
    await fs.promises.writeFile(path.join(sourceRoot, 'large.ts'), largeContent, 'utf8');

    // Hotspot without maxLines must NOT bypass the check!
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({
        version: 1,
        threshold: 50,
        allowedHotspots: {
          'src/large.ts': { reason: 'No maxLines limit specified' },
        },
      }),
      'utf8',
    );
    const resMissing = runGuard();
    assert.strictEqual(resMissing.status, 1, 'Guard must fail when maxLines is missing');
    assert.match(resMissing.stderr, /Invalid or missing maxLines/i);

    // Hotspot with invalid maxLines: 'oops' or -10
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({
        version: 1,
        threshold: 50,
        allowedHotspots: {
          'src/large.ts': { maxLines: -10, reason: 'Negative limit' },
        },
      }),
      'utf8',
    );
    const resNeg = runGuard();
    assert.strictEqual(resNeg.status, 1, 'Guard must fail when maxLines is negative');
    assert.match(resNeg.stderr, /Invalid or missing maxLines/i);
  });

  test('fails when hotspot entry has missing or empty reason', async () => {
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({
        version: 1,
        threshold: 50,
        allowedHotspots: {
          'src/large.ts': { maxLines: 65, reason: '   ' },
        },
      }),
      'utf8',
    );
    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail when reason is empty');
    assert.match(res.stderr, /Missing or empty reason/i);
  });

  test('fails when allowedHotspots is not an object', async () => {
    await fs.promises.writeFile(
      baselinePath,
      JSON.stringify({
        version: 1,
        threshold: 50,
        allowedHotspots: ['src/large.ts'],
      }),
      'utf8',
    );
    const res = runGuard();
    assert.strictEqual(res.status, 1, 'Guard must fail when allowedHotspots is an array');
    assert.match(res.stderr, /allowedHotspots must be an object/i);
  });

  for (const invalidInput of ['missing source', 'source file', 'malformed baseline', 'invalid budget'] as const) {
    test(`--write-baseline rejects ${invalidInput} without changing the baseline`, async () => {
      const args = ['--write-baseline'];
      if (invalidInput === 'missing source') {
        args.push('--source-root', path.join(tmpDir, 'missing-source'));
      } else if (invalidInput === 'source file') {
        args.push('--source-root', path.join(sourceRoot, 'small.ts'));
      } else if (invalidInput === 'malformed baseline') {
        await fs.promises.writeFile(baselinePath, '{ invalid JSON', 'utf8');
      } else {
        await fs.promises.writeFile(baselinePath, JSON.stringify({
          version: 1,
          threshold: 50,
          allowedHotspots: { 'src/large.ts': { reason: 'Missing approved budget' } },
        }), 'utf8');
      }

      const before = await fs.promises.readFile(baselinePath, 'utf8');
      const result = runGuard(...args);
      assert.strictEqual(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /FAIL \[INVALID_(SOURCE_ROOT|BASELINE)\]/);
      assert.strictEqual(await fs.promises.readFile(baselinePath, 'utf8'), before);
      assert.doesNotMatch(result.stdout, /Updated baseline/);
    });
  }

  test('--write-baseline creates a missing baseline and the result passes verification', async () => {
    await fs.promises.unlink(baselinePath);
    await fs.promises.writeFile(path.join(sourceRoot, 'large.ts'), Array(60).fill('// line').join('\n'), 'utf8');
    const result = runGuard('--write-baseline', '--threshold', '50');
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const baseline = JSON.parse(await fs.promises.readFile(baselinePath, 'utf8'));
    assert.strictEqual(baseline.allowedHotspots['src/large.ts'].maxLines, 60);
    const check = runGuard();
    assert.strictEqual(check.status, 0, check.stderr || check.stdout);
  });

  test('production src directory satisfies production loc-budget-baseline.json', () => {
    const res = spawnSync(process.execPath, [guardScript], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /\[LOC Budget Guard\] Passed/);
  });
});
