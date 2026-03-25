/**
 * Regression tests for `test/matrix/ibcmdAdapter.ts` (container matrix / instrument-smoke path),
 * separate from `src/services/ibcmdConfigCheckGate.ts` used by the extension.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runIbcmdConfigCheck, runIbcmdOnWorkDir } from '../matrix/ibcmdAdapter';

suite('ibcmdMatrixAdapter', () => {
  const envKeys = [
    'IBCMD_PATH',
    'IBCMD_INFOBASE_CONFIG',
    'IBCMD_USER',
    'IBCMD_PASSWORD',
    'IBCMD_TIMEOUT_MS',
    'IBCMD_CONFIG_CHECK_FORCE',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let tempDir: string;

  setup(() => {
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-matrix-'));
  });

  teardown(() => {
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('runIbcmdOnWorkDir skipped when IBCMD_PATH unset', async () => {
    const result = await runIbcmdOnWorkDir(path.join(tempDir, 'cfg'));
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.exitCode, null);
  });

  test('runIbcmdConfigCheck skipped when IBCMD_PATH unset', async () => {
    const result = await runIbcmdConfigCheck();
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.exitCode, null);
  });

  test('runIbcmdConfigCheck passes --force when IBCMD_CONFIG_CHECK_FORCE=1', async () => {
    const scriptPath = path.join(tempDir, 'fake-ibcmd-force.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" != *"--force"* ]]; then
  echo "missing --force: $joined" >&2
  exit 3
fi
if [ "$1" = "infobase" ] && [ "$2" = "config" ] && [ "$3" = "check" ]; then
  echo "matrix check ok"
  exit 0
fi
exit 2
`,
      'utf-8'
    );
    fs.chmodSync(scriptPath, 0o755);
    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');
    process.env.IBCMD_CONFIG_CHECK_FORCE = '1';

    const result = await runIbcmdConfigCheck();
    assert.strictEqual(result.status, 'executed');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.logSnippet.includes('matrix check ok'));
  });

  test('runIbcmdConfigCheck fails when ibcmd output contains fake-ibcmd', async () => {
    const scriptPath =
      process.platform === 'win32'
        ? (() => {
            const p = path.join(tempDir, 'ibcmd-fake.cmd');
            fs.writeFileSync(p, '@echo fake-ibcmd\r\n@exit /b 0\r\n', 'utf8');
            return p;
          })()
        : (() => {
            const p = path.join(tempDir, 'ibcmd-fake');
            fs.writeFileSync(p, '#!/usr/bin/env sh\necho fake-ibcmd\nexit 0\n', 'utf8');
            fs.chmodSync(p, 0o755);
            return p;
          })();

    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');
    delete process.env.IBCMD_CONFIG_CHECK_FORCE;

    const result = await runIbcmdConfigCheck();
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.logSnippet.toLowerCase().includes('fake-ibcmd'));
  });

  test('runIbcmdOnWorkDir fails when ibcmd output contains fake-ibcmd', async () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'Configuration.xml'), '<Configuration></Configuration>', 'utf8');

    const scriptPath =
      process.platform === 'win32'
        ? (() => {
            const p = path.join(tempDir, 'ibcmd-fake-import.cmd');
            fs.writeFileSync(p, '@echo fake-ibcmd\r\n@exit /b 0\r\n', 'utf8');
            return p;
          })()
        : (() => {
            const p = path.join(tempDir, 'ibcmd-fake-import');
            fs.writeFileSync(p, '#!/usr/bin/env sh\necho fake-ibcmd\nexit 0\n', 'utf8');
            fs.chmodSync(p, 0o755);
            return p;
          })();

    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdOnWorkDir(workDir);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.logSnippet.toLowerCase().includes('fake-ibcmd'));
  });
});
