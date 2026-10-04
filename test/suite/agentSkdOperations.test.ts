/**
 * Smoke-тесты для agentSkdOperations + powershellRunner.
 * Работают без VS Code runtime (core suite / mocha TDD).
 *
 * Если PowerShell не обнаружен в системе — все тесты пропускаются.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import '../helpers/vscodeStubRegister';
import {
    resolvePowerShellExecutable,
    _resetPwshCache,
    runPowerShellScript,
    type PowerShellRunResult,
    type PowerShellRunnerDependencies,
} from '../../src/services/skd/powershellRunner';
import { SkdOperations } from '../../src/agent/agentSkdOperations';
import type { ProcessTreeTerminationOutcome } from '../../src/services/ibcmd/processTreeTermination';

// Фиктивный extensionPath — скрипты будут не найдены, но это ок для smoke-теста
// который только проверяет структуру ответа при валидации несуществующего файла.
const FAKE_EXTENSION_PATH = path.join(__dirname, '..', '..'); // root of repo — не содержит resources/skd реально

// Реальный extensionPath (если запускается из собранного расширения)
const REAL_EXTENSION_PATH = path.resolve(__dirname, '..', '..', '..', '..', '..');

suite('SkdOperations — smoke', function () {
    this.timeout(15000);

    let pwsh: string | undefined;

    suiteSetup(async () => {
        _resetPwshCache();
        pwsh = await resolvePowerShellExecutable();
    });

    suiteTeardown(() => {
        _resetPwshCache();
    });

    // ─── resolvePowerShellExecutable ─────────────────────────────────────────

    test('resolvePowerShellExecutable — возвращает string или undefined', async () => {
        // Уже вызван в suiteSetup, просто убеждаемся в типе
        assert.ok(pwsh === undefined || typeof pwsh === 'string');
    });

    test('resolvePowerShellExecutable — кеш: второй вызов возвращает тот же результат', async () => {
        const second = await resolvePowerShellExecutable();
        assert.strictEqual(pwsh, second);
    });

    // ─── skdValidate с несуществующим файлом ─────────────────────────────────

    test('skdValidate(non-existent file) — success=false с ошибкой', async function () {
        if (!pwsh) {
            this.skip();
            return;
        }

        // Используем реальный extensionPath если resources/skd существует, иначе fake
        const extensionPath = detectExtensionPath();
        const ops = new SkdOperations({ extensionPath });

        const result = await ops.skdValidate({
            templatePath: '/non/existent/path/Template.xml',
        });

        assert.strictEqual(result.success, false, 'ожидается success=false для несуществующего файла');
        assert.ok(result.error, 'ожидается поле error');
    });

    // ─── skdCompile — валидация params ───────────────────────────────────────

    test('skdCompile без outputPath — success=false с ошибкой валидации', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error — намеренно передаём невалидные params для теста валидации
        const result = await ops.skdCompile({ definitionFile: 'some.json' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('outputPath'));
    });

    test('skdCompile без definitionFile и value — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        const result = await ops.skdCompile({ outputPath: '/tmp/out.xml' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('definitionFile') || result.error?.includes('value'));
    });

    test('skdCompile с обоими definitionFile и value — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        const result = await ops.skdCompile({
            definitionFile: 'a.json',
            value: '{}',
            outputPath: '/tmp/out.xml',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('definitionFile') || result.error?.includes('value') || result.error?.includes('оба'));
    });

    // ─── skdInfo — валидация params ───────────────────────────────────────────

    test('skdInfo без templatePath — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error — намеренно пустые params
        const result = await ops.skdInfo({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('templatePath'));
    });

    // ─── skdEdit — валидация params ───────────────────────────────────────────

    test('skdEdit без templatePath — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error
        const result = await ops.skdEdit({ operation: 'add-field', value: '{}' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('templatePath'));
    });

    test('skdEdit без operation — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error
        const result = await ops.skdEdit({ templatePath: '/tmp/t.xml', value: '{}' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('operation'));
    });

    // ─── skdValidate — валидация params ──────────────────────────────────────

    test('skdValidate без templatePath — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error
        const result = await ops.skdValidate({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('templatePath'));
    });
});

suite('SkdOperations — background cancellation contract', () => {
    test('forwards task cancellation into PowerShell and preserves a typed inDoubt result', async () => {
        let receivedToken: import('vscode').CancellationToken | undefined;
        const operations = new SkdOperations({
            extensionPath: FAKE_EXTENSION_PATH,
            runPowerShellScript: async (options) => {
                receivedToken = options.token;
                options.onOutput?.('СКД worker started\n');
                return {
                    stdout: 'partial output',
                    stderr: '',
                    exitCode: -1,
                    started: true,
                    effectPossible: true,
                    cancelled: true,
                };
            },
        });
        const source = new vscode.CancellationTokenSource();
        const reported: string[] = [];

        const result = await operations.skdEdit({
            templatePath: '/tmp/template.xml',
            operation: 'add-field',
            value: '{}',
        }, source.token, (message) => reported.push(message));

        assert.strictEqual(receivedToken, source.token);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.code, 'SKD_OPERATION_IN_DOUBT');
        assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
        assert.ok(reported.some((message) => message.includes('СКД worker started')));
        source.dispose();
    });

    test('rejects a pre-cancelled request before invoking PowerShell', async () => {
        let invoked = false;
        const source = new vscode.CancellationTokenSource();
        source.cancel();
        const operations = new SkdOperations({
            extensionPath: FAKE_EXTENSION_PATH,
            runPowerShellScript: async () => {
                invoked = true;
                return { stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const result = await operations.skdInfo({ templatePath: '/tmp/template.xml' }, source.token);

        assert.strictEqual(invoked, false);
        assert.strictEqual(result.code, 'REQUEST_CANCELLED');
        source.dispose();
    });
});

suite('PowerShell runner process-tree termination', () => {
    test('cancellation reports survivor PIDs and leaves SKD outcome inDoubt', async () => {
        const child = new InjectedPowerShellChild();
        const terminationGate = createTerminationGate();
        let terminationCalls = 0;
        let runnerResult: PowerShellRunResult | undefined;
        const dependencies = makePowerShellDependencies(child, async () => {
            terminationCalls += 1;
            return terminationGate.promise;
        });
        const operations = new SkdOperations({
            extensionPath: FAKE_EXTENSION_PATH,
            runPowerShellScript: async (options) => {
                runnerResult = await runPowerShellScript(options, dependencies);
                return runnerResult;
            },
        });
        const source = new vscode.CancellationTokenSource();

        try {
            const resultPromise = operations.skdValidate({ templatePath: 'missing-template.xml' }, source.token);
            await child.waitForSpawn();
            source.cancel();
            await delay(40);
            const callsWhenSettling = terminationCalls;
            const settledBeforeTerminationConfirmed = runnerResult !== undefined;
            terminationGate.release({
                terminated: false,
                hardKillUsed: true,
                survivingPids: [45678, 45679],
                errors: ['injected survivor'],
            });

            const result = await resultPromise;
            assert.strictEqual(callsWhenSettling, 1, 'cancellation must request process-tree termination');
            assert.strictEqual(settledBeforeTerminationConfirmed, false, 'the operation must wait for termination outcome');
            assert.deepStrictEqual(child.signals, [], 'the runner must not signal only the PowerShell root');
            assert.strictEqual(runnerResult?.cancellationRequested, true);
            assert.strictEqual(runnerResult?.cancelled, false, 'surviving children do not confirm cancellation');
            assert.strictEqual(runnerResult?.termination?.terminated, false);
            assert.deepStrictEqual(runnerResult?.termination?.survivingPids, [45678, 45679]);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, 'SKD_OPERATION_IN_DOUBT');
            assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
            assert.match(result.error ?? '', /45678.*45679/);
        } finally {
            child.completeExit(null, 'SIGTERM');
            source.dispose();
        }
    });

    test('timeout uses process-tree termination and preserves surviving process diagnostics', async () => {
        const child = new InjectedPowerShellChild();
        const terminationGate = createTerminationGate();
        let terminationCalls = 0;
        let runnerResult: PowerShellRunResult | undefined;
        const dependencies = makePowerShellDependencies(child, async () => {
            terminationCalls += 1;
            return terminationGate.promise;
        });
        const operations = new SkdOperations({
            extensionPath: FAKE_EXTENSION_PATH,
            runPowerShellScript: async (options) => {
                runnerResult = await runPowerShellScript({ ...options, timeoutMs: 15 }, dependencies);
                return runnerResult;
            },
        });

        try {
            const resultPromise = operations.skdValidate({ templatePath: 'missing-template.xml' });
            await child.waitForSpawn();
            await delay(40);
            const callsWhenSettling = terminationCalls;
            const settledBeforeTerminationConfirmed = runnerResult !== undefined;
            terminationGate.release({
                terminated: false,
                hardKillUsed: true,
                survivingPids: [56789],
                errors: ['injected timeout survivor'],
            });

            const result = await resultPromise;
            assert.strictEqual(callsWhenSettling, 1, 'timeout must request process-tree termination');
            assert.strictEqual(settledBeforeTerminationConfirmed, false, 'the operation must wait for termination outcome');
            assert.deepStrictEqual(child.signals, [], 'timeout must not signal only the PowerShell root');
            assert.strictEqual(runnerResult?.timedOut, true);
            assert.strictEqual(runnerResult?.termination?.terminated, false);
            assert.deepStrictEqual(runnerResult?.termination?.survivingPids, [56789]);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, 'SKD_OPERATION_IN_DOUBT');
            assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
            assert.match(result.error ?? '', /56789/);
        } finally {
            child.completeExit(null, 'SIGTERM');
        }
    });
});

class InjectedPowerShellChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly signals: Array<NodeJS.Signals | number | undefined> = [];
    readonly pid = 12345;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    private spawned = false;
    private spawnWaiters: Array<() => void> = [];
    private closed = false;

    constructor() {
        super();
        setImmediate(() => {
            this.spawned = true;
            this.emit('spawn');
            for (const resolve of this.spawnWaiters.splice(0)) { resolve(); }
        });
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        this.signals.push(signal);
        setImmediate(() => this.completeExit(null, typeof signal === 'string' ? signal : 'SIGTERM'));
        return true;
    }

    async waitForSpawn(): Promise<void> {
        if (this.spawned) { return; }
        await new Promise<void>((resolve) => this.spawnWaiters.push(resolve));
    }

    completeExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.closed) { return; }
        this.closed = true;
        this.exitCode = code;
        this.signalCode = signal;
        this.stdout.end();
        this.stderr.end();
        this.emit('close', code, signal);
    }
}

function makePowerShellDependencies(
    child: InjectedPowerShellChild,
    terminate: PowerShellRunnerDependencies['terminateProcessTreeImpl'],
): PowerShellRunnerDependencies {
    return {
        resolveExecutable: async () => 'injected-powershell',
        spawnImpl: (() => {
            return child as unknown as ChildProcess;
        }) as NonNullable<PowerShellRunnerDependencies['spawnImpl']>,
        terminateProcessTreeImpl: terminate,
    };
}

function createTerminationGate(): {
    promise: Promise<ProcessTreeTerminationOutcome>;
    release: (outcome: ProcessTreeTerminationOutcome) => void;
} {
    let release!: (outcome: ProcessTreeTerminationOutcome) => void;
    const promise = new Promise<ProcessTreeTerminationOutcome>((resolve) => { release = resolve; });
    return { promise, release };
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function detectExtensionPath(): string {
    // Проверяем, есть ли реальные PS1-скрипты рядом
    try {
        const fs = require('fs') as typeof import('fs');
        const candidate = path.resolve(__dirname, '..', '..');
        if (fs.existsSync(path.join(candidate, 'resources', 'skd', 'skd-validate.ps1'))) {
            return candidate;
        }
    } catch {
        // ignore
    }
    return FAKE_EXTENSION_PATH;
}
