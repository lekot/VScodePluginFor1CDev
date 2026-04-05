import * as assert from 'assert';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  collectFilesForSelection,
  collectObjectFiles,
} from '../../src/services/ibcmd/objectFileCollector';

// Absolute path to the fixture configuration root.
const FIXTURE_ROOT = path.resolve(__dirname, '../../FormatSamples/empty_conf');

function makeNode(filePath?: string): TreeNode {
  return {
    id: 'test',
    name: 'test',
    type: MetadataType.CommonModule,
    properties: {},
    filePath,
  };
}

suite('objectFileCollector', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('collectObjectFiles: тестМодуль — descriptor XML and .bsl module are included', () => {
    const descriptorAbs = path.join(FIXTURE_ROOT, 'CommonModules', 'тестМодуль.xml');
    const node = makeNode(descriptorAbs);

    const files = collectObjectFiles(node, FIXTURE_ROOT);

    // All paths must be forward-slash relative
    for (const f of files) {
      assert.ok(!f.includes('\\'), `Path should use forward slashes: ${f}`);
      assert.ok(!path.isAbsolute(f), `Path should be relative: ${f}`);
    }

    const descriptorRel = 'CommonModules/тестМодуль.xml';
    assert.ok(
      files.some((f) => f.toLowerCase() === descriptorRel.toLowerCase()),
      `Expected descriptor ${descriptorRel} in result. Got: ${JSON.stringify(files)}`,
    );

    // The Ext/Module directory contains a .bsl file
    assert.ok(
      files.some((f) => f.toLowerCase().endsWith('.bsl')),
      `Expected at least one .bsl file. Got: ${JSON.stringify(files)}`,
    );
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('collectObjectFiles: node without filePath returns empty array', () => {
    const node = makeNode(undefined);
    const files = collectObjectFiles(node, FIXTURE_ROOT);
    assert.deepStrictEqual(files, []);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('collectFilesForSelection: deduplicates overlapping nodes', () => {
    // Select тестМодуль twice — should produce no duplicates.
    const descriptorAbs = path.join(FIXTURE_ROOT, 'CommonModules', 'тестМодуль.xml');
    const node1 = makeNode(descriptorAbs);
    const node2 = makeNode(descriptorAbs);

    const files = collectFilesForSelection([node1, node2], FIXTURE_ROOT);

    // Check no duplicates (case-insensitive)
    const lowerKeys = files.map((f) => f.toLowerCase());
    const uniqueKeys = new Set(lowerKeys);
    assert.strictEqual(
      lowerKeys.length,
      uniqueKeys.size,
      `Expected no duplicates. Got: ${JSON.stringify(files)}`,
    );
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('collectFilesForSelection: empty nodes array returns empty array', () => {
    const files = collectFilesForSelection([], FIXTURE_ROOT);
    assert.deepStrictEqual(files, []);
  });
});
