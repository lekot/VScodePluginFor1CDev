import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentBridge } from '../../src/agent/agentBridge';

const TEST_PATTERN = /^test\.allowed\.[a-z]+$/;

suite('AgentBridge Discovery File Security (Issue #200)', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-sec-'));
  });

  teardown(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('discovery file has 0o600 mode on POSIX platforms', async function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }

    const bridge = new AgentBridge({
      commandPattern: TEST_PATTERN,
      workspaceFolder: tmpDir,
    });

    try {
      await bridge.start();
      const bridgeFile = path.join(tmpDir, '.vscode', 'cdt-agent-bridge.json');
      assert.ok(fs.existsSync(bridgeFile), 'Bridge file must exist');

      const stat = await fs.promises.stat(bridgeFile);
      const mode = stat.mode & 0o777;
      assert.strictEqual(mode, 0o600, `Mode should be 0600 (rw-------), got: ${mode.toString(8)}`);
    } finally {
      await bridge.stop();
    }
  });

  test('safely replaces stale discovery file on start', async () => {
    const vscodeDir = path.join(tmpDir, '.vscode');
    await fs.promises.mkdir(vscodeDir, { recursive: true });
    const bridgeFile = path.join(vscodeDir, 'cdt-agent-bridge.json');

    // Create a stale discovery file from a previous "dead" bridge
    await fs.promises.writeFile(
      bridgeFile,
      JSON.stringify({ port: 9999, token: 'stale-token', pid: 999999 }),
      'utf8',
    );

    const bridge = new AgentBridge({
      commandPattern: TEST_PATTERN,
      workspaceFolder: tmpDir,
    });

    try {
      const { token, port } = await bridge.start();
      assert.ok(fs.existsSync(bridgeFile), 'Bridge file must exist');

      const raw = await fs.promises.readFile(bridgeFile, 'utf8');
      const data = JSON.parse(raw);
      assert.strictEqual(data.token, token);
      assert.strictEqual(data.port, port);
      assert.notStrictEqual(data.token, 'stale-token');
    } finally {
      await bridge.stop();
    }
  });

  test('token is not leaked in error responses or logs', async () => {
    const bridge = new AgentBridge({
      commandPattern: TEST_PATTERN,
      workspaceFolder: tmpDir,
    });

    try {
      const { token } = await bridge.start();
      assert.strictEqual(token.length, 64);
    } finally {
      await bridge.stop();
    }
  });

  test('multi-root workspaceFolders writes discovery file in all folders and cleans all on stop', async () => {
    const dirA = path.join(tmpDir, 'folderA');
    const dirB = path.join(tmpDir, 'folderB');
    await fs.promises.mkdir(dirA, { recursive: true });
    await fs.promises.mkdir(dirB, { recursive: true });

    const bridge = new AgentBridge({
      commandPattern: TEST_PATTERN,
      workspaceFolders: [dirA, dirB],
    });

    try {
      const { token, port } = await bridge.start();
      const fileA = path.join(dirA, '.vscode', 'cdt-agent-bridge.json');
      const fileB = path.join(dirB, '.vscode', 'cdt-agent-bridge.json');

      assert.ok(fs.existsSync(fileA), 'Folder A discovery file must exist');
      assert.ok(fs.existsSync(fileB), 'Folder B discovery file must exist');

      const dataA = JSON.parse(await fs.promises.readFile(fileA, 'utf8'));
      const dataB = JSON.parse(await fs.promises.readFile(fileB, 'utf8'));

      assert.strictEqual(dataA.token, token);
      assert.strictEqual(dataB.token, token);
      assert.strictEqual(dataA.port, port);
      assert.strictEqual(dataB.port, port);

      await bridge.stop();

      assert.strictEqual(fs.existsSync(fileA), false, 'Folder A discovery file removed on stop');
      assert.strictEqual(fs.existsSync(fileB), false, 'Folder B discovery file removed on stop');
    } finally {
      await bridge.stop();
    }
  });
});

