import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandBslSiblings } from '../../src/bindings/bslExpansion';

function rmDirQuiet(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Builds a minimal Designer-layout temp config root:
 *
 *   CommonModules/
 *     Foo.xml              ← descriptor for Foo
 *     Foo/
 *       Ext/
 *         Module.bsl
 *     Bar.xml              ← descriptor for Bar
 *     Bar/
 *       Ext/
 *         Module.bsl
 */
function buildTempConfig(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-bsl-exp-'));

  const fooDir = path.join(root, 'CommonModules', 'Foo', 'Ext');
  fs.mkdirSync(fooDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'CommonModules', 'Foo.xml'), '<meta/>');
  fs.writeFileSync(path.join(fooDir, 'Module.bsl'), '// foo');

  const barDir = path.join(root, 'CommonModules', 'Bar', 'Ext');
  fs.mkdirSync(barDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'CommonModules', 'Bar.xml'), '<meta/>');
  fs.writeFileSync(path.join(barDir, 'Module.bsl'), '// bar');

  return root;
}

suite('bslExpansion expandBslSiblings', () => {
  let root: string;

  setup(() => {
    root = buildTempConfig();
  });

  teardown(() => {
    rmDirQuiet(root);
  });

  test('bsl inside object dir expands to descriptor + all sibling files', () => {
    const input = ['CommonModules/Foo/Ext/Module.bsl'];
    const result = expandBslSiblings(input, root);
    assert.ok(result.includes('CommonModules/Foo.xml'), 'descriptor XML must be present');
    assert.ok(result.includes('CommonModules/Foo/Ext/Module.bsl'), 'original bsl must be present');
    assert.strictEqual(result.length, 2);
  });

  test('two bsl files from different objects expand independently', () => {
    const input = [
      'CommonModules/Foo/Ext/Module.bsl',
      'CommonModules/Bar/Ext/Module.bsl',
    ];
    const result = expandBslSiblings(input, root);
    assert.ok(result.includes('CommonModules/Foo.xml'));
    assert.ok(result.includes('CommonModules/Bar.xml'));
    assert.ok(result.includes('CommonModules/Foo/Ext/Module.bsl'));
    assert.ok(result.includes('CommonModules/Bar/Ext/Module.bsl'));
    assert.strictEqual(result.length, 4);
  });

  test('bsl without a descriptor XML is left as-is without throwing', () => {
    // orphan.bsl has no sibling descriptor anywhere up the tree
    const orphanDir = path.join(root, 'Orphan', 'Ext');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'Module.bsl'), '// orphan');

    const input = ['Orphan/Ext/Module.bsl'];
    const result = expandBslSiblings(input, root);
    assert.deepStrictEqual(result, ['Orphan/Ext/Module.bsl']);
  });

  test('non-bsl files pass through unchanged', () => {
    const input = ['CommonModules/Foo.xml', 'some/other.os'];
    // create other.os so walkDir doesn't matter
    const otherDir = path.join(root, 'some');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'other.os'), '');

    const result = expandBslSiblings(input, root);
    assert.ok(result.includes('CommonModules/Foo.xml'));
    assert.ok(result.includes('some/other.os'));
  });

  test('descriptor already in list is not duplicated', () => {
    const input = [
      'CommonModules/Foo.xml',
      'CommonModules/Foo/Ext/Module.bsl',
    ];
    const result = expandBslSiblings(input, root);
    const xmlOccurrences = result.filter((f) => f === 'CommonModules/Foo.xml');
    assert.strictEqual(xmlOccurrences.length, 1, 'descriptor should not be duplicated');
  });

  test('first-occurrence order is preserved with dedup', () => {
    const input = [
      'CommonModules/Bar/Ext/Module.bsl',
      'CommonModules/Foo/Ext/Module.bsl',
    ];
    const result = expandBslSiblings(input, root);
    // Bar descriptor must come before Foo descriptor (Bar was first in input)
    const barIdx = result.indexOf('CommonModules/Bar.xml');
    const fooIdx = result.indexOf('CommonModules/Foo.xml');
    assert.ok(barIdx < fooIdx, 'Bar should appear before Foo');
  });
});
