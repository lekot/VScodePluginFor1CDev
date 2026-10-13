import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { readGitHead } from '../../src/templateEditor/templateDiffPanel';
import { resetVscodeTestState, vscodeExtensionsTestState } from '../helpers/vscodeModuleStub';

interface ExecFileCall {
  readonly command: unknown;
  readonly args: unknown;
  readonly options: unknown;
}

type ExecFileStub = (...args: unknown[]) => unknown;

const childProcess = require('child_process') as { execFile: ExecFileStub };

function stubExecFile(implementation: (...args: unknown[]) => void): () => void {
  const original = childProcess.execFile;
  childProcess.execFile = implementation;
  return () => {
    childProcess.execFile = original;
  };
}

function setGitApiPath(gitPath: string): void {
  vscodeExtensionsTestState.getExtensionImpl = (id) => id === 'vscode.git'
    ? {
        activate: async () => ({
          getAPI: (_version: 1) => ({ git: { path: gitPath } }),
        }),
      }
    : undefined;
}

function captureExecFile(stdout: string, stderr = '', error: Error | null = null): {
  readonly calls: ExecFileCall[];
  readonly restore: () => void;
} {
  const calls: ExecFileCall[] = [];
  const restore = stubExecFile((...args) => {
    calls.push({ command: args[0], args: args[1], options: args[2] });
    const callback = args[3] as (err: Error | null, output: string, errorOutput: string) => void;
    callback(error, stdout, stderr);
  });
  return { calls, restore };
}

suite('templateDiff readGitHead', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  test('uses vscode.git absolute path and preserves the full UTF-8 stdout for a Unicode path with spaces', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer макет с пробелом '));
    const file = path.join(directory, 'Макет формы.xml');
    const gitPath = path.join(directory, 'git executable.exe');
    const body = 'x'.repeat(512 * 1024);
    let activated = false;
    vscodeExtensionsTestState.getExtensionImpl = (id) => id === 'vscode.git'
      ? {
          activate: async () => {
            activated = true;
            return { getAPI: (_version: 1) => ({ git: { path: gitPath } }) };
          },
        }
      : undefined;
    const { calls, restore } = captureExecFile(`\uFEFF${body}`);

    try {
      const text = await readGitHead(file);
      assert.strictEqual(calls[0]?.command, gitPath);
      assert.strictEqual(activated, true);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].args, [
        '-c',
        'core.quotepath=off',
        'show',
        'HEAD:./Макет формы.xml',
      ]);
      assert.deepStrictEqual(calls[0].options, {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
      assert.strictEqual(text, body);
    } finally {
      restore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails in Russian before spawning if vscode.git is unavailable or activation fails', async () => {
    const processCall = captureExecFile('unused');
    const file = path.join(os.tmpdir(), 'Макет.xml');

    try {
      vscodeExtensionsTestState.getExtensionImpl = () => undefined;
      await assert.rejects(readGitHead(file), /Git.*VS Code|VS Code.*Git/i);
      assert.strictEqual(processCall.calls.length, 0);

      vscodeExtensionsTestState.getExtensionImpl = (id) => id === 'vscode.git'
        ? { activate: async () => { throw new Error('extension disabled'); } }
        : undefined;
      await assert.rejects(readGitHead(file), /Git.*VS Code|VS Code.*Git/i);
      assert.strictEqual(processCall.calls.length, 0);
    } finally {
      processCall.restore();
    }
  });

  test('rejects empty and relative executable paths before spawning', async () => {
    const processCall = captureExecFile('unused');
    const file = path.join(os.tmpdir(), 'Макет.xml');

    try {
      for (const gitPath of ['', 'git.cmd', 'relative/git']) {
        setGitApiPath(gitPath);
        await assert.rejects(readGitHead(file), /абсолютн.*Git/i, gitPath || '(empty path)');
      }
      assert.strictEqual(processCall.calls.length, 0);
    } finally {
      processCall.restore();
    }
  });

  test('keeps the missing-file empty side and rejects other Git errors', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    setGitApiPath(path.join(os.tmpdir(), 'git.exe'));
    for (const stderr of [
      'fatal: path exists on disk, but not in HEAD',
      'fatal: path does not exist in HEAD',
    ]) {
      const missingFile = captureExecFile('', stderr, new Error('git show failed'));
      try {
        assert.strictEqual(await readGitHead(file), '');
        assert.strictEqual(missingFile.calls.length, 1);
      } finally {
        missingFile.restore();
      }
    }

    const outsideRepository = captureExecFile('', 'fatal: not a git repository', new Error('git failed'));
    try {
      await assert.rejects(readGitHead(file), /fatal: not a git repository/);
      assert.strictEqual(outsideRepository.calls.length, 1);
    } finally {
      outsideRepository.restore();
    }

    const emptyErrorOutput = captureExecFile('', '', new Error('git show failed without stderr'));
    try {
      await assert.rejects(readGitHead(file), /git show failed without stderr/);
    } finally {
      emptyErrorOutput.restore();
    }
  });
});
