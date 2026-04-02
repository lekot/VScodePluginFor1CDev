/**
 * E2E: subsystem composition editor → XML write → ibcmd import/check.
 *
 * Copies `FormatSamples/empty_conf` (which includes `Subsystems/TestSubsystem1.xml`)
 * into a temp dir, exercises `applySubsystemCompositionFileUpdate`, then optionally
 * runs ibcmd if `IBCMD_PATH` + `IBCMD_INFOBASE_CONFIG` are set.
 *
 * Without ibcmd env vars the ibcmd steps self-skip (mocha `this.skip()`).
 * The XML-level assertions always run.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applySubsystemCompositionFileUpdate,
  readSubsystemCompositionRefsFromFile,
} from '../../src/services/subsystemCompositionFileUpdater';
import { runIbcmdConfigCheck, runIbcmdOnWorkDir } from '../matrix/ibcmdAdapter';

/** Repo root when compiled to `out/test/suite`. */
function repoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function emptyConfSource(): string {
  return path.join(repoRoot(), 'FormatSamples', 'empty_conf');
}

suite('subsystem composition e2e with ibcmd', function () {
  // eslint-disable-next-line @typescript-eslint/no-invalid-this
  this.timeout(120_000);

  let workDir: string;

  setup(() => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), '1c-subsystem-e2e-'));
    workDir = path.join(tmpBase, 'empty_conf');
    fs.cpSync(emptyConfSource(), workDir, { recursive: true });
  });

  teardown(() => {
    if (workDir && fs.existsSync(workDir)) {
      try {
        fs.rmSync(path.dirname(workDir), { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Helper: catalog name present in empty_conf/Configuration.xml ChildObjects
  // ---------------------------------------------------------------------------
  const KNOWN_CATALOG = 'Catalog.Справочник55';

  // ---------------------------------------------------------------------------
  test('fixture: TestSubsystem1.xml exists in empty_conf', () => {
    const subsystemXml = path.join(workDir, 'Subsystems', 'TestSubsystem1.xml');
    assert.ok(fs.existsSync(subsystemXml), `Subsystem fixture must exist at: ${subsystemXml}`);
  });

  test('fixture: TestSubsystem1 registered in Configuration.xml ChildObjects', () => {
    const configXml = path.join(workDir, 'Configuration.xml');
    const content = fs.readFileSync(configXml, 'utf-8');
    assert.ok(
      content.includes('<Subsystem>TestSubsystem1</Subsystem>'),
      'Configuration.xml must list TestSubsystem1 in ChildObjects'
    );
  });

  // ---------------------------------------------------------------------------
  test('add object to subsystem composition → ibcmd import + check passes', async function () {
    const subsystemXml = path.join(workDir, 'Subsystems', 'TestSubsystem1.xml');

    // 1. Read initial composition — should be empty
    const initialRefs = await readSubsystemCompositionRefsFromFile(subsystemXml);
    assert.strictEqual(initialRefs.length, 0, 'Initial composition should be empty');

    // 2. Add a known object from empty_conf
    const result = await applySubsystemCompositionFileUpdate(subsystemXml, {
      add: [KNOWN_CATALOG],
      remove: [],
    });
    assert.strictEqual(result.rejected.length, 0, 'No refs should be rejected');
    assert.ok(result.refs.includes(KNOWN_CATALOG), 'Result refs should contain the added ref');

    // 3. Verify composition was written
    const afterRefs = await readSubsystemCompositionRefsFromFile(subsystemXml);
    assert.ok(afterRefs.includes(KNOWN_CATALOG), 'Added ref should be persisted in XML');

    // 4. Verify raw XML contains the ref string
    const rawXml = fs.readFileSync(subsystemXml, 'utf-8');
    assert.ok(rawXml.includes(KNOWN_CATALOG), 'Raw XML must contain the ref value');

    // 5. ibcmd import (skips if env vars not set)
    const importResult = await runIbcmdOnWorkDir(workDir);
    if (importResult.status === 'skipped') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
      return;
    }
    assert.strictEqual(
      importResult.exitCode,
      0,
      `ibcmd import should succeed.\nLog: ${importResult.logSnippet}`
    );

    // 6. ibcmd config check
    const checkResult = await runIbcmdConfigCheck();
    if (checkResult.status !== 'skipped') {
      assert.strictEqual(
        checkResult.exitCode,
        0,
        `ibcmd config check should succeed.\nLog: ${checkResult.logSnippet}`
      );
    }
  });

  // ---------------------------------------------------------------------------
  test('remove object from subsystem composition → ibcmd import passes', async function () {
    const subsystemXml = path.join(workDir, 'Subsystems', 'TestSubsystem1.xml');

    // 1. Add then remove
    await applySubsystemCompositionFileUpdate(subsystemXml, {
      add: [KNOWN_CATALOG],
      remove: [],
    });

    const result = await applySubsystemCompositionFileUpdate(subsystemXml, {
      add: [],
      remove: [KNOWN_CATALOG],
    });
    assert.strictEqual(result.rejected.length, 0, 'Remove should not produce rejections');

    // 2. Verify empty
    const afterRefs = await readSubsystemCompositionRefsFromFile(subsystemXml);
    assert.strictEqual(afterRefs.length, 0, 'Composition should be empty after remove');

    // 3. Verify raw XML does NOT contain the removed ref
    const rawXml = fs.readFileSync(subsystemXml, 'utf-8');
    assert.ok(!rawXml.includes(KNOWN_CATALOG), 'Removed ref must not appear in raw XML');

    // 4. ibcmd import (skips if env vars not set)
    const importResult = await runIbcmdOnWorkDir(workDir);
    if (importResult.status === 'skipped') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
      return;
    }
    assert.strictEqual(
      importResult.exitCode,
      0,
      `ibcmd import should succeed after remove.\nLog: ${importResult.logSnippet}`
    );
  });

  // ---------------------------------------------------------------------------
  test('add multiple objects then partial remove → composition is correct', async () => {
    const subsystemXml = path.join(workDir, 'Subsystems', 'TestSubsystem1.xml');
    const ALL_CATALOGS = ['Catalog.Справочник55', 'Catalog.СтарееСтарых', 'Catalog.табатаба'];

    // Add all
    const addResult = await applySubsystemCompositionFileUpdate(subsystemXml, {
      add: ALL_CATALOGS,
      remove: [],
    });
    assert.strictEqual(addResult.rejected.length, 0);
    assert.strictEqual(addResult.refs.length, ALL_CATALOGS.length);

    // Remove only the first one
    const removeResult = await applySubsystemCompositionFileUpdate(subsystemXml, {
      add: [],
      remove: [ALL_CATALOGS[0]],
    });
    assert.strictEqual(removeResult.rejected.length, 0);
    assert.strictEqual(removeResult.refs.length, 2);
    assert.ok(!removeResult.refs.includes(ALL_CATALOGS[0]), 'Removed ref must not be in result');
    assert.ok(removeResult.refs.includes(ALL_CATALOGS[1]), 'Remaining ref 1 must survive');
    assert.ok(removeResult.refs.includes(ALL_CATALOGS[2]), 'Remaining ref 2 must survive');

    // Verify persistent state
    const persisted = await readSubsystemCompositionRefsFromFile(subsystemXml);
    assert.deepStrictEqual(persisted, removeResult.refs);
  });
});
