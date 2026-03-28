import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runIbcmdConfigCheckGate } from '../../src/services/ibcmdConfigCheckGate';
import { resetIbcmdServiceSingletonForTests } from '../../src/infobaseManager/ibcmd/ibcmdServiceSingleton';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const suiteOrSkip = process.platform === 'win32' ? suite.skip : suite;

suiteOrSkip('ibcmdConfigCheckGate', () => {
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
    resetVscodeTestState();
    resetIbcmdServiceSingletonForTests();
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-gate-'));
  });

  teardown(() => {
    resetVscodeTestState();
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

  test('fails when ibcmd path from env points to a missing file', async () => {
    process.env.IBCMD_PATH = path.join(tempDir, 'no-such-ibcmd');
    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'IBCMD_NOT_FOUND');
    assert.ok(result.message.includes('IBCMD_PATH'));
    assert.ok(result.message.includes('1cInfobaseManager.ibcmdPath'));
  });

  test('fails when YAML config path is missing', async () => {
    const scriptPath = path.join(tempDir, 'stub-ibcmd.sh');
    fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    process.env.IBCMD_PATH = scriptPath;
    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('IBCMD_INFOBASE_CONFIG is not set'));
  });

  test('returns ok when ibcmd exits successfully', async () => {
    const scriptPath = path.join(tempDir, 'fake-ibcmd.sh');
    fs.writeFileSync(
      scriptPath,
      '#!/usr/bin/env bash\nif [ \"$1\" = \"infobase\" ] && [ \"$2\" = \"config\" ] && [ \"$3\" = \"check\" ]; then\n  echo \"check ok\"\n  exit 0\nfi\necho \"bad args\" >&2\nexit 2\n',
      'utf-8'
    );
    fs.chmodSync(scriptPath, 0o755);
    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('check ok'));
  });

  test('returns failure details when ibcmd exits non-zero', async () => {
    const scriptPath = path.join(tempDir, 'fake-ibcmd-fail.sh');
    fs.writeFileSync(
      scriptPath,
      '#!/usr/bin/env bash\necho \"validation failed\" >&2\nexit 17\n',
      'utf-8'
    );
    fs.chmodSync(scriptPath, 0o755);
    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('ibcmd config check failed'));
    assert.ok(result.message.includes('exitCode=17'));
    assert.ok(result.message.includes('validation failed'));
  });

  test('appends --force when IBCMD_CONFIG_CHECK_FORCE=1', async () => {
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
  echo "force ok"
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

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('force ok'));
  });

  test('resolves relative IBCMD_INFOBASE_CONFIG to absolute --config argument', async () => {
    const prevCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const cfgDir = path.join(tempDir, 'cfg');
      fs.mkdirSync(cfgDir);
      const rel = path.join('cfg', 'ib.yml');
      fs.writeFileSync(rel, 'kind: fake\n', 'utf-8');

      const scriptPath = path.join(tempDir, 'abs-config-check.sh');
      fs.writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do
  case "$a" in
    --config=*)
      p="\${a#--config=}"
      case "$p" in
        /*) exit 0 ;;
        *) echo "config path not absolute: $p" >&2; exit 6 ;;
      esac
      ;;
  esac
done
echo "missing --config" >&2
exit 7
`,
        'utf-8'
      );
      fs.chmodSync(scriptPath, 0o755);
      process.env.IBCMD_PATH = scriptPath;
      process.env.IBCMD_INFOBASE_CONFIG = rel;

      const result = await runIbcmdConfigCheckGate();
      assert.strictEqual(result.ok, true);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test('passes ibcmd user and password flags when set', async () => {
    const scriptPath = path.join(tempDir, 'fake-ibcmd-auth.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" != *"--user=alice"* || "$joined" != *"--password=secret"* ]]; then
  echo "missing cred flags: $joined" >&2
  exit 3
fi
if [ "$1" = "infobase" ] && [ "$2" = "config" ] && [ "$3" = "check" ]; then
  echo "auth ok"
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
    process.env.IBCMD_USER = 'alice';
    process.env.IBCMD_PASSWORD = 'secret';

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('auth ok'));
  });

  test('fails when ibcmd binary from env does not exist (before config check)', async () => {
    process.env.IBCMD_PATH = path.join(tempDir, 'missing-ibcmd-binary');
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'IBCMD_NOT_FOUND');
    assert.ok(result.message.includes('does not exist'));
  });

  test('resolves ibcmd from workspace 1cInfobaseManager.ibcmdPath when IBCMD_PATH is unset', async () => {
    const scriptPath = path.join(tempDir, 'ws-settings-ibcmd.sh');
    fs.writeFileSync(
      scriptPath,
      '#!/usr/bin/env bash\nif [ \"$1\" = \"infobase\" ] && [ \"$2\" = \"config\" ] && [ \"$3\" = \"check\" ]; then\n  echo \"ws ok\"\n  exit 0\nfi\necho \"bad args\" >&2\nexit 2\n',
      'utf-8'
    );
    fs.chmodSync(scriptPath, 0o755);
    vscodeTestState.workspaceConfig['1cInfobaseManager.ibcmdPath'] = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib-ws.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('ws ok'));
  });
});
