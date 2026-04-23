import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectDeployGuards } from '../../src/bindings/deployPreflightGuards';

function rmDirQuiet(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

suite('deployPreflightGuards detectDeployGuards', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-preflight-'));
    fs.writeFileSync(path.join(tmpDir, 'Module.xml'), '<meta/>');
    fs.writeFileSync(path.join(tmpDir, 'Module.bsl'), '// code');
  });

  teardown(() => {
    rmDirQuiet(tmpDir);
  });

  test('Configuration.xml in list sets hasConfigurationXml true', () => {
    const result = detectDeployGuards(['Configuration.xml', 'Module.xml'], tmpDir);
    assert.strictEqual(result.hasConfigurationXml, true);
  });

  test('nested forward-slash Configuration.xml sets hasConfigurationXml true', () => {
    const result = detectDeployGuards(['sub/Configuration.xml', 'Module.xml'], tmpDir);
    assert.strictEqual(result.hasConfigurationXml, true);
  });

  test('no Configuration.xml leaves hasConfigurationXml false', () => {
    const result = detectDeployGuards(['Module.xml', 'Module.bsl'], tmpDir);
    assert.strictEqual(result.hasConfigurationXml, false);
  });

  test('existing file does not appear in missingFiles', () => {
    const result = detectDeployGuards(['Module.xml'], tmpDir);
    assert.deepStrictEqual(result.missingFiles, []);
  });

  test('missing file appears in missingFiles', () => {
    const result = detectDeployGuards(['Module.xml', 'Ghost.xml'], tmpDir);
    assert.ok(result.missingFiles.includes('Ghost.xml'));
    assert.strictEqual(result.missingFiles.length, 1);
  });

  test('mix: Configuration.xml and missing file both detected', () => {
    const result = detectDeployGuards(['Configuration.xml', 'Ghost.xml'], tmpDir);
    assert.strictEqual(result.hasConfigurationXml, true);
    assert.ok(result.missingFiles.includes('Ghost.xml'));
  });

  test('empty list returns clean detection', () => {
    const result = detectDeployGuards([], tmpDir);
    assert.strictEqual(result.hasConfigurationXml, false);
    assert.deepStrictEqual(result.missingFiles, []);
  });
});
