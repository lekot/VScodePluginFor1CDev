import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess, SpawnOptions, spawn } from 'child_process';
import { PassThrough } from 'stream';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import { registerTemplateDiffCommands, readGitHead } from '../../src/templateEditor/templateDiffPanel';
import { resetVscodeTestState, vscodeExtensionsTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const childProcess = require('child_process') as { spawn: typeof spawn };
const processTreeTermination = require('../../src/services/ibcmd/processTreeTermination') as {
  terminateProcessTree: (
    child: ChildProcess,
    options: { graceMs: number }
  ) => Promise<{ terminated: boolean; hardKillUsed: boolean; survivingPids: number[]; errors: string[] }>;
};
const fakeGitExecutable = path.join(os.tmpdir(), 'git.exe');

function setGitApiPath(gitPath: string): void {
  vscodeExtensionsTestState.getExtensionImpl = (id) => id === 'vscode.git'
    ? {
        activate: async () => ({
          getAPI: (_version: 1) => ({ git: { path: gitPath } }),
        }),
      }
    : undefined;
}

function createTestCancellation(initiallyCancelled = false): {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
  cancel(): void;
} {
  let cancelled = initiallyCancelled;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) listener();
    },
  };
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
}

interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

function fakeGitProcess(options: {
  readonly stdout?: readonly Buffer[];
  readonly stderr?: readonly Buffer[];
  readonly exitCode?: number;
  readonly staysOpen?: boolean;
  readonly onSpawn?: () => void;
}): { readonly child: ChildProcess; readonly spawnImpl: typeof spawn; readonly calls: FakeSpawnCall[] } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4132;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;

  const finishWhenStreamsEnd = (): void => {
    let ended = 0;
    const onEnd = (): void => {
      ended += 1;
      if (ended === 2) {
        child.exitCode = options.exitCode ?? 0;
        child.emit('close', child.exitCode, null);
      }
    };
    child.stdout.once('end', onEnd);
    child.stderr.once('end', onEnd);
  };

  const calls: FakeSpawnCall[] = [];
  const spawnImpl = ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args: [...args], options: spawnOptions });
    setImmediate(() => {
      child.emit('spawn');
      options.onSpawn?.();
      finishWhenStreamsEnd();
      for (const chunk of options.stdout ?? []) child.stdout.write(chunk);
      for (const chunk of options.stderr ?? []) child.stderr.write(chunk);
      if (options.staysOpen) return;
      child.stdout.end();
      child.stderr.end();
    });
    return child;
  }) as unknown as typeof spawn;

  return { child: child as unknown as ChildProcess, spawnImpl, calls };
}

function shortDelay(ms: number): Promise<'pending'> {
  return new Promise((resolve) => setTimeout(() => resolve('pending'), ms));
}

function installDocumentContentProviderStub(): () => void {
  const original = Reflect.get(vscode.workspace, 'registerTextDocumentContentProvider');
  Reflect.set(vscode.workspace, 'registerTextDocumentContentProvider', () => ({ dispose: () => undefined }));
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(vscode.workspace, 'registerTextDocumentContentProvider');
    } else {
      Reflect.set(vscode.workspace, 'registerTextDocumentContentProvider', original);
    }
  };
}

function installUriConstructorStub(): {
  readonly create: (fsPath: string) => vscode.Uri;
  readonly restore: () => void;
} {
  const vscodeModule = require('vscode') as { Uri: unknown };
  const original = vscodeModule.Uri;
  class TestUri {
    readonly scheme = 'file';

    constructor(readonly fsPath: string) {}

    toString(): string {
      return `file:///${this.fsPath.replace(/\\/g, '/')}`;
    }
  }
  Reflect.set(vscodeModule, 'Uri', TestUri);
  return {
    create: (fsPath) => new TestUri(fsPath) as unknown as vscode.Uri,
    restore: () => { Reflect.set(vscodeModule, 'Uri', original); },
  };
}

suite('templateDiff readGitHead', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  test('uses vscode.git absolute path and preserves the full UTF-8 stdout for a Unicode path with spaces', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer макет с пробелом '));
    const file = path.join(directory, 'Макет формы.xml');
    const gitPath = path.join(directory, 'git executable.exe');
    const body = 'Ж😀\r\nX'.repeat(50000);
    const payload = Buffer.from(`\uFEFF${body}`, 'utf8');
    const fake = fakeGitProcess({
      stdout: [payload.subarray(0, 2), payload.subarray(2, 7), payload.subarray(7)],
    });
    let activated = false;
    vscodeExtensionsTestState.getExtensionImpl = (id) => id === 'vscode.git'
      ? {
          activate: async () => {
            activated = true;
            return { getAPI: (_version: 1) => ({ git: { path: gitPath } }) };
          },
        }
      : undefined;

    try {
      const text = await readGitHead(file, {}, { spawnImpl: fake.spawnImpl });
      assert.strictEqual(fake.calls[0]?.command, gitPath);
      assert.strictEqual(activated, true);
      assert.strictEqual(fake.calls.length, 1);
      assert.deepStrictEqual(fake.calls[0].args, [
        '-c',
        'core.quotepath=off',
        'show',
        'HEAD:./Макет формы.xml',
      ]);
      assert.strictEqual(fake.calls[0].options.cwd, directory);
      assert.strictEqual(fake.calls[0].options.windowsHide, true);
      assert.deepStrictEqual(fake.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.strictEqual(text, body);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails in Russian before spawning if vscode.git is unavailable or activation fails', async () => {
    const fake = fakeGitProcess({ stdout: [Buffer.from('unused')] });
    const file = path.join(os.tmpdir(), 'Макет.xml');

    try {
      vscodeExtensionsTestState.getExtensionImpl = () => undefined;
      await assert.rejects(readGitHead(file, {}, { spawnImpl: fake.spawnImpl }), /Git.*VS Code|VS Code.*Git/i);
      assert.strictEqual(fake.calls.length, 0);

      vscodeExtensionsTestState.getExtensionImpl = (id) => id === 'vscode.git'
        ? { activate: async () => { throw new Error('extension disabled'); } }
        : undefined;
      await assert.rejects(readGitHead(file, {}, { spawnImpl: fake.spawnImpl }), /Git.*VS Code|VS Code.*Git/i);
      assert.strictEqual(fake.calls.length, 0);
    } finally {
      resetVscodeTestState();
    }
  });

  test('rejects empty and relative executable paths before spawning', async () => {
    const fake = fakeGitProcess({ stdout: [Buffer.from('unused')] });
    const file = path.join(os.tmpdir(), 'Макет.xml');

    try {
      for (const gitPath of ['', 'git.cmd', 'relative/git']) {
        setGitApiPath(gitPath);
        await assert.rejects(
          readGitHead(file, {}, { spawnImpl: fake.spawnImpl }),
          /абсолютн.*Git/i,
          gitPath || '(empty path)'
        );
      }
      assert.strictEqual(fake.calls.length, 0);
    } finally {
      resetVscodeTestState();
    }
  });

  test('keeps the missing-file empty side and rejects other Git errors', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    setGitApiPath(path.join(os.tmpdir(), 'git.exe'));
    for (const stderr of [
      'fatal: path exists on disk, but not in HEAD',
      'fatal: path does not exist in HEAD',
    ]) {
      const missingFile = fakeGitProcess({ stderr: [Buffer.from(stderr)], exitCode: 128 });
      assert.strictEqual(await readGitHead(file, {}, { spawnImpl: missingFile.spawnImpl }), '');
      assert.strictEqual(missingFile.calls.length, 1);
    }

    const outsideRepository = fakeGitProcess({
      stderr: [Buffer.from('fatal: not a git repository')],
      exitCode: 128,
    });
    await assert.rejects(
      readGitHead(file, {}, { spawnImpl: outsideRepository.spawnImpl }),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'GIT_FAILED' &&
        /fatal: not a git repository/.test((error as { message?: string }).message ?? '')
    );
    assert.strictEqual(outsideRepository.calls.length, 1);

    const emptyErrorOutput = fakeGitProcess({ exitCode: 128 });
    await assert.rejects(
      readGitHead(file, {}, { spawnImpl: emptyErrorOutput.spawnImpl }),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'GIT_FAILED' &&
        /код(?:ом)? 128/.test((error as { message?: string }).message ?? '')
    );
  });

  test('returns a typed cancellation before resolving Git or spawning, and rechecks after async resolution', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const token = createTestCancellation(true);
    let resolveCalls = 0;
    let spawnCalls = 0;
    const fake = fakeGitProcess({ stdout: [Buffer.from('unexpected')] });

    await assert.rejects(
      readGitHead(file, { token }, {
        resolveGitExecutable: async () => { resolveCalls += 1; return fakeGitExecutable; },
        spawnImpl: (() => { spawnCalls += 1; return fake.child; }) as unknown as typeof spawn,
      }),
      (error: unknown) => (error as { code?: string }).code === 'CANCELLED'
    );
    assert.strictEqual(resolveCalls, 0);
    assert.strictEqual(spawnCalls, 0);

    const activatedToken = createTestCancellation();
    let secondSpawnCalls = 0;
    await assert.rejects(
      readGitHead(file, { token: activatedToken }, {
        resolveGitExecutable: async () => {
          activatedToken.cancel();
          return fakeGitExecutable;
        },
        spawnImpl: (() => { secondSpawnCalls += 1; return fake.child; }) as unknown as typeof spawn,
      }),
      (error: unknown) => (error as { code?: string }).code === 'CANCELLED'
    );
    assert.strictEqual(secondSpawnCalls, 0);
  });

  test('enforces the process timeout through tree termination', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const fake = fakeGitProcess({ staysOpen: true });
    let terminations = 0;

    const result = await Promise.race([
      readGitHead(file, { timeoutMs: 20 }, {
        resolveGitExecutable: async () => fakeGitExecutable,
        spawnImpl: fake.spawnImpl,
        terminateProcessTreeImpl: async () => {
          terminations += 1;
          return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
        },
      }).then(
        () => 'resolved',
        (error: unknown) => (error as { code?: string }).code ?? 'rejected'
      ),
      shortDelay(250),
    ]);
    assert.strictEqual(result, 'TIMEOUT');
    assert.strictEqual(terminations, 1);
  });

  test('does not treat missing-HEAD text as success when the process times out', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const fake = fakeGitProcess({
      stderr: [Buffer.from('fatal: path does not exist in HEAD')],
      staysOpen: true,
    });

    await assert.rejects(
      readGitHead(file, { timeoutMs: 20 }, {
        resolveGitExecutable: async () => fakeGitExecutable,
        spawnImpl: fake.spawnImpl,
        terminateProcessTreeImpl: async () => ({
          terminated: true,
          hardKillUsed: false,
          survivingPids: [],
          errors: [],
        }),
      }),
      (error: unknown) => (error as { code?: string }).code === 'TIMEOUT'
    );
  });

  test('stops oversized stdout through the supervisor and never returns a partial HEAD', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const fake = fakeGitProcess({ stdout: [Buffer.from('0123456789abcdef')] });
    let terminations = 0;

    await assert.rejects(
      readGitHead(file, {}, {
        resolveGitExecutable: async () => fakeGitExecutable,
        spawnImpl: fake.spawnImpl,
        terminateProcessTreeImpl: async () => {
          terminations += 1;
          return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
        },
        maxStdoutBytes: 8,
        maxStderrBytes: 32,
      }),
      (error: unknown) => (error as { code?: string }).code === 'OUTPUT_LIMIT'
    );
    assert.strictEqual(terminations, 1);
  });

  test('enforces the independent stderr limit before classifying a missing path', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const fake = fakeGitProcess({
      stderr: [Buffer.from('fatal: path does not exist in HEAD plus extra diagnostics')],
      exitCode: 128,
    });
    let terminations = 0;

    await assert.rejects(
      readGitHead(file, {}, {
        resolveGitExecutable: async () => fakeGitExecutable,
        spawnImpl: fake.spawnImpl,
        terminateProcessTreeImpl: async () => {
          terminations += 1;
          return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
        },
        maxStdoutBytes: 16,
        maxStderrBytes: 8,
      }),
      (error: unknown) => (error as { code?: string }).code === 'OUTPUT_LIMIT'
    );
    assert.strictEqual(terminations, 1);
  });

  test('reports executable spawn failures with their process outcome', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const spawnImpl = (() => {
      throw Object.assign(new Error('git executable not found'), { code: 'ENOENT' });
    }) as unknown as typeof spawn;

    await assert.rejects(
      readGitHead(file, {}, {
        resolveGitExecutable: async () => fakeGitExecutable,
        spawnImpl,
      }),
      (error: unknown) => {
        const typed = error as {
          code?: string;
          processOutcome?: { started?: boolean; effectPossible?: boolean; spawnErrorCode?: string };
        };
        return typed.code === 'SPAWN_FAILED' &&
          typed.processOutcome?.started === false &&
          typed.processOutcome.effectPossible === false &&
          typed.processOutcome.spawnErrorCode === 'ENOENT';
      }
    );
  });

  test('preserves tree termination failure when cancellation arrives after spawn', async () => {
    const file = path.join(os.tmpdir(), 'Макет.xml');
    const token = createTestCancellation();
    const fake = fakeGitProcess({ staysOpen: true, onSpawn: () => token.cancel() });

    const result = await Promise.race([
      readGitHead(file, { token }, {
        resolveGitExecutable: async () => fakeGitExecutable,
        spawnImpl: fake.spawnImpl,
        terminateProcessTreeImpl: async () => ({
          terminated: false,
          hardKillUsed: true,
          survivingPids: [4132],
          errors: ['child survived'],
        }),
      }).then(
        () => 'resolved',
        (error: unknown) => (error as { code?: string; processOutcome?: { termination?: { terminated?: boolean } } })
      ),
      shortDelay(250),
    ]);
    assert.notStrictEqual(result, 'pending');
    assert.strictEqual((result as { code?: string }).code, 'TERMINATION_FAILED');
    assert.strictEqual(
      (result as { processOutcome?: { termination?: { terminated?: boolean } } }).processOutcome?.termination?.terminated,
      false
    );
  });

  test('uses cancellable progress and suppresses the diff and generic error on UI cancellation', async () => {
    const uriStub = installUriConstructorStub();
    const uri = uriStub.create(path.join(os.tmpdir(), 'Template.xml'));
    const originalDocuments = Reflect.get(vscode.workspace, 'textDocuments');
    const restoreContentProvider = installDocumentContentProviderStub();
    Reflect.set(vscode.workspace, 'textDocuments', [{ uri, getText: () => '<Template />' }]);
    vscodeTestState.progressCancellationRequested = true;
    const context = {
      extensionUri: uri,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    try {
      registerTemplateDiffCommands(context);
      const handler = vscodeTestState.registeredCommandHandlers.get(
        '1c-template-editor.compareWithHead'
      );
      assert.ok(handler);
      await handler(uri);
      assert.strictEqual(vscodeTestState.progressOptionsLog.at(-1)?.cancellable, true);
      assert.deepStrictEqual(vscodeTestState.errorLog, []);
      assert.deepStrictEqual(vscodeTestState.executedCommands, []);
    } finally {
      restoreContentProvider();
      uriStub.restore();
      if (originalDocuments === undefined) {
        Reflect.deleteProperty(vscode.workspace, 'textDocuments');
      } else {
        Reflect.set(vscode.workspace, 'textDocuments', originalDocuments);
      }
    }
  });

  test('waits for Git tree termination when reading the current side fails', async () => {
    const uriStub = installUriConstructorStub();
    const uri = uriStub.create(path.join(os.tmpdir(), 'Template.xml'));
    const originalDocuments = Reflect.get(vscode.workspace, 'textDocuments');
    const restoreContentProvider = installDocumentContentProviderStub();
    const originalSpawn = childProcess.spawn;
    const originalTerminate = processTreeTermination.terminateProcessTree;
    const fake = fakeGitProcess({ staysOpen: true });
    let terminations = 0;
    Reflect.set(vscode.workspace, 'textDocuments', [{
      uri,
      getText: () => new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('current document read failed')), 20);
      }),
    }]);
    setGitApiPath(path.join(os.tmpdir(), 'git.exe'));
    childProcess.spawn = fake.spawnImpl;
    processTreeTermination.terminateProcessTree = async () => {
      terminations += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { terminated: false, hardKillUsed: true, survivingPids: [4132], errors: ['child survived'] };
    };
    const context = {
      extensionUri: uri,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    try {
      registerTemplateDiffCommands(context);
      const handler = vscodeTestState.registeredCommandHandlers.get(
        '1c-template-editor.compareWithHead'
      );
      assert.ok(handler);
      const startedAt = Date.now();
      await handler(uri);
      assert.strictEqual(terminations, 1);
      assert.ok(Date.now() - startedAt >= 45, 'progress task should await the termination result');
      assert.ok(
        vscodeTestState.errorLog.some((message) => /остановку Git/.test(message)),
        vscodeTestState.errorLog.join('\n')
      );
    } finally {
      childProcess.spawn = originalSpawn;
      processTreeTermination.terminateProcessTree = originalTerminate;
      restoreContentProvider();
      uriStub.restore();
      if (originalDocuments === undefined) {
        Reflect.deleteProperty(vscode.workspace, 'textDocuments');
      } else {
        Reflect.set(vscode.workspace, 'textDocuments', originalDocuments);
      }
    }
  });
});
