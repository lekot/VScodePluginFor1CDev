import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runIbcmdConfigCheckGate } from '../../src/services/ibcmdConfigCheckGate';

suite('ibcmdConfigCheckGate', () => {
  const envKeys = [
    'IBCMD_PATH',
    'IBCMD_INFOBASE_CONFIG',
    'IBCMD_USER',
    'IBCMD_PASSWORD',
    'IBCMD_TIMEOUT_MS',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let tempDir: string;

  setup(() => {
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-gate-'));
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

  test('fails when ibcmd path is missing', async () => {
    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('IBCMD_PATH is not set'));
  });

  test('fails when YAML config path is missing', async () => {
    process.env.IBCMD_PATH = '/tmp/ibcmd';
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

  test('fails when ibcmd binary cannot be executed', async () => {
    process.env.IBCMD_PATH = path.join(tempDir, 'missing-ibcmd-binary');
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdConfigCheckGate();
    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('ibcmd config check failed'));
    assert.ok(result.message.includes('failed'));
  });
});
