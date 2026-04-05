import * as assert from 'assert';
import {
  detectChangedConfigFiles,
  type GitRepository,
  type IncrementalChangeDetectorDeps,
} from '../../src/services/ibcmd/incrementalChangeDetector';

const CONFIG_ROOT = 'C:/project/config';

function makeRepo(
  workingTreePaths: string[],
  indexPaths: string[] = [],
): GitRepository {
  return {
    rootUri: { fsPath: 'C:/project' },
    state: {
      workingTreeChanges: workingTreePaths.map((p) => ({ uri: { fsPath: p } })),
      indexChanges: indexPaths.map((p) => ({ uri: { fsPath: p } })),
      mergeChanges: [],
    },
  };
}

function makeDeps(repo: GitRepository | undefined): IncrementalChangeDetectorDeps {
  return { getGitRepository: () => repo };
}

suite('incrementalChangeDetector', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('detectChangedConfigFiles: inside configRoot are included, outside are skipped', async () => {
    const inside1 = `${CONFIG_ROOT}/CommonModules/тестМодуль.xml`;
    const inside2 = `${CONFIG_ROOT}/Catalogs/Items.xml`;
    const outside = 'C:/project/README.md';

    const repo = makeRepo([inside1, inside2, outside]);
    const result = await detectChangedConfigFiles(CONFIG_ROOT, makeDeps(repo));

    assert.ok(!('error' in result), 'Expected DetectedChanges, got error');
    if ('error' in result) return;

    assert.strictEqual(result.relativePaths.length, 2);
    assert.ok(result.relativePaths.includes('CommonModules/тестМодуль.xml'));
    assert.ok(result.relativePaths.includes('Catalogs/Items.xml'));
    assert.strictEqual(result.skippedCount, 1); // the outside file
    assert.strictEqual(result.source, 'git-working-tree');
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('detectChangedConfigFiles: empty workingTreeChanges returns empty paths', async () => {
    const repo = makeRepo([]);
    const result = await detectChangedConfigFiles(CONFIG_ROOT, makeDeps(repo));

    assert.ok(!('error' in result));
    if ('error' in result) return;

    assert.deepStrictEqual(result.relativePaths, []);
    assert.deepStrictEqual(result.absolutePaths, []);
    assert.strictEqual(result.skippedCount, 0);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('detectChangedConfigFiles: getGitRepository undefined → error result', async () => {
    const result = await detectChangedConfigFiles(CONFIG_ROOT, makeDeps(undefined));

    assert.ok('error' in result, 'Expected error result when no repo');
    if (!('error' in result)) return;
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('detectChangedConfigFiles: scope staged uses indexChanges', async () => {
    const stagedPath = `${CONFIG_ROOT}/CommonModules/тестМодуль.xml`;
    const workingPath = `${CONFIG_ROOT}/Catalogs/Items.xml`;

    const repo = makeRepo([workingPath], [stagedPath]);
    const result = await detectChangedConfigFiles(CONFIG_ROOT, makeDeps(repo), { scope: 'staged' });

    assert.ok(!('error' in result));
    if ('error' in result) return;

    assert.strictEqual(result.source, 'git-staged');
    assert.strictEqual(result.relativePaths.length, 1);
    assert.ok(result.relativePaths.includes('CommonModules/тестМодуль.xml'));
    // workingPath should NOT appear because we used staged scope
    assert.ok(!result.relativePaths.includes('Catalogs/Items.xml'));
  });
});
