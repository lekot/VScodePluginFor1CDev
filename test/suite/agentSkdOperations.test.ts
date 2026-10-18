/**
 * Smoke-тесты для agentSkdOperations + powershellRunner.
 * Работают без VS Code runtime (core suite / mocha TDD).
 *
 * Если PowerShell не обнаружен в системе — все тесты пропускаются.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import iconv from 'iconv-lite';
import '../helpers/vscodeStubRegister';
import {
    resolvePowerShellExecutable,
    _resetPwshCache,
    runPowerShellScript,
    type PowerShellRunResult,
    type PowerShellRunnerDependencies,
} from '../../src/services/skd/powershellRunner';
import { SkdOperations } from '../../src/agent/agentSkdOperations';
import type { AgentResult } from '../../src/agent/types';
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

suite('SkdOperations — effective paths and SKD report targets', () => {
    let tempRoot: string;
    let configRoot: string;
    let outsideRoot: string;
    let calls: Array<{ scriptPath: string; args: string[] }>;
    let operations: SkdOperations;

    setup(async () => {
        tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skd-effective-path-'));
        configRoot = path.join(tempRoot, 'config');
        outsideRoot = path.join(tempRoot, 'outside');
        await fs.promises.mkdir(configRoot, { recursive: true });
        await fs.promises.mkdir(outsideRoot, { recursive: true });
        calls = [];
        operations = new SkdOperations({
            extensionPath: REAL_EXTENSION_PATH,
            configRoot,
            runPowerShellScript: async ({ scriptPath, args }) => {
                calls.push({ scriptPath, args });
                if (scriptPath.endsWith('skd-edit.ps1')) {
                    return { stdout: `[OK] Saved ${argValue(args, '-TemplatePath')}`, stderr: '', exitCode: 0 };
                }
                if (scriptPath.endsWith('skd-validate.ps1')) {
                    return { stdout: '=== Validation OK: Template.xml (1 checks) ===', stderr: '', exitCode: 0 };
                }
                if (scriptPath.endsWith('skd-compile.ps1')) {
                    const output = argValue(args, '-OutputPath');
                    return { stdout: `OK  ${output}\n    DataSets: 1  Fields: 0  Calculated: 0  Totals: 0  Params: 0  Variants: 0\n    Size: 1 bytes`, stderr: '', exitCode: 0 };
                }
                return { stdout: 'SKD report', stderr: '', exitCode: 0 };
            },
        });
    });

    teardown(async () => {
        await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    async function writeTemplate(filePath: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, '<DataCompositionSchema/>', 'utf8');
    }

    async function linkDirectory(target: string, link: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(link), { recursive: true });
        await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    }

    test('rejects folder input whose effective Ext/Template.xml escapes through a nested junction before invoking PowerShell', async () => {
        const outsideExt = path.join(outsideRoot, 'external', 'Ext');
        const outsideTemplate = path.join(outsideExt, 'Template.xml');
        await writeTemplate(outsideTemplate);
        const folder = path.join(configRoot, 'Reports', 'UnsafeTemplate');
        await fs.promises.mkdir(folder, { recursive: true });
        await linkDirectory(outsideExt, path.join(folder, 'Ext'));

        const result = await operations.skdEdit({ templatePath: folder, operation: 'set-query', value: 'SELECT 1' });

        assert.strictEqual(result.success, false, 'effective target outside config must be rejected');
        assert.ok(result.code === 'PATH_OUTSIDE_ROOT' || result.code === 'TARGET_OUTSIDE_ROOT');
        assert.strictEqual(calls.length, 0, 'the process boundary must not receive an unresolved folder');
        assert.strictEqual(await fs.promises.readFile(outsideTemplate, 'utf8'), '<DataCompositionSchema/>');
    });

    test('normalizes relative paths from configRoot and passes the effective absolute XML path', async () => {
        const template = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Main', 'Ext', 'Template.xml');
        await writeTemplate(template);
        const relative = path.relative(configRoot, template);

        const result = await operations.skdInfo({ templatePath: relative });

        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(argValue(calls[0].args, '-TemplatePath'), await fs.promises.realpath(template));
    });

    test('resolves an existing metadata descriptor to its DCS Template.xml before boundary checking and dispatch', async () => {
        const template = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Main', 'Ext', 'Template.xml');
        const descriptor = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Main.xml');
        await writeTemplate(template);
        await fs.promises.mkdir(path.dirname(descriptor), { recursive: true });
        await fs.promises.writeFile(descriptor, '<MetaDataObject><Template><Properties><TemplateType>DataCompositionSchema</TemplateType></Properties></Template></MetaDataObject>', 'utf8');

        const result = await operations.skdValidate({ templatePath: descriptor });

        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(argValue(calls[0].args, '-TemplatePath'), await fs.promises.realpath(template));
    });

    test('preserves validate legacy fallback from Templates/<name>/Template.xml to Ext/Template.xml and checks the resolved target', async () => {
        const templateDir = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Main');
        const template = path.join(templateDir, 'Ext', 'Template.xml');
        const legacyPath = path.join(templateDir, 'Template.xml');
        await writeTemplate(template);

        const valid = await operations.skdValidate({ templatePath: legacyPath });
        assert.strictEqual(valid.success, true, valid.error);
        assert.strictEqual(argValue(calls[0].args, '-TemplatePath'), await fs.promises.realpath(template));

        calls = [];
        const outsideExt = path.join(outsideRoot, 'external', 'Ext');
        const outsideTemplate = path.join(outsideExt, 'Template.xml');
        await writeTemplate(outsideTemplate);
        const escapedDir = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Unsafe');
        await fs.promises.mkdir(escapedDir, { recursive: true });
        await linkDirectory(outsideExt, path.join(escapedDir, 'Ext'));
        const escaped = await operations.skdValidate({ templatePath: path.join(escapedDir, 'Template.xml') });
        assert.strictEqual(escaped.success, false);
        assert.ok(escaped.code === 'TARGET_OUTSIDE_ROOT' || escaped.code === 'PATH_OUTSIDE_ROOT');
        assert.strictEqual(calls.length, 0, 'the resolved fallback must be boundary-checked before process launch');
    });

    test('preserves validate legacy fallback from a missing template descriptor to its Ext/Template.xml companion', async () => {
        const templates = path.join(configRoot, 'Reports', 'Monthly', 'Templates');
        const template = path.join(templates, 'Main', 'Ext', 'Template.xml');
        await writeTemplate(template);

        const valid = await operations.skdValidate({ templatePath: path.join(templates, 'Main.xml') });
        assert.strictEqual(valid.success, true, valid.error);
        assert.strictEqual(argValue(calls[0].args, '-TemplatePath'), await fs.promises.realpath(template));

        calls = [];
        const outsideTemplate = path.join(outsideRoot, 'External', 'Ext', 'Template.xml');
        await writeTemplate(outsideTemplate);
        const unsafe = path.join(templates, 'Unsafe');
        await fs.promises.mkdir(unsafe, { recursive: true });
        await linkDirectory(path.dirname(outsideTemplate), path.join(unsafe, 'Ext'));
        const escaped = await operations.skdValidate({ templatePath: path.join(templates, 'Unsafe.xml') });
        assert.strictEqual(escaped.success, false);
        assert.ok(escaped.code === 'TARGET_OUTSIDE_ROOT' || escaped.code === 'PATH_OUTSIDE_ROOT');
        assert.strictEqual(calls.length, 0, 'the descriptor fallback target must be checked before process launch');
    });

    test('resolves info auto-discovery by object folder and rejects an external template reached through a Templates junction', async () => {
        const objectRoot = path.join(configRoot, 'DataProcessors', 'Monthly');
        const outsideTemplate = path.join(outsideRoot, 'External', 'Ext', 'Template.xml');
        await writeTemplate(outsideTemplate);
        await fs.promises.mkdir(path.join(objectRoot, 'Templates'), { recursive: true });
        await fs.promises.writeFile(
            path.join(objectRoot, 'Templates', 'Main.xml'),
            '<MetaDataObject><Template><Properties><TemplateType>DataCompositionSchema</TemplateType></Properties></Template></MetaDataObject>',
            'utf8',
        );
        await fs.promises.mkdir(path.join(objectRoot, 'Templates', 'Main'), { recursive: true });
        await linkDirectory(path.dirname(outsideTemplate), path.join(objectRoot, 'Templates', 'Main', 'Ext'));

        const result = await operations.skdInfo({ templatePath: objectRoot });

        assert.strictEqual(result.success, false, 'auto-discovered effective target outside config must be rejected');
        assert.ok(result.code === 'PATH_OUTSIDE_ROOT' || result.code === 'TARGET_OUTSIDE_ROOT');
        assert.strictEqual(calls.length, 0);
    });

    test('validates definitionFile and outputPath before compile and normalizes both relative paths', async () => {
        const definition = path.join(configRoot, 'skd.json');
        const output = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Main', 'Ext', 'Template.xml');
        await fs.promises.writeFile(definition, '{"dataSets":[{}]}', 'utf8');

        const escaped = await operations.skdCompile({ outputPath: output, definitionFile: path.join(outsideRoot, 'foreign.json') });
        assert.strictEqual(escaped.success, false, 'definitionFile outside config must be rejected');
        assert.strictEqual(calls.length, 0, 'invalid inputs must fail before process launch');

        const success = await operations.skdCompile({
            outputPath: path.relative(configRoot, output),
            definitionFile: path.relative(configRoot, definition),
        });
        assert.strictEqual(success.success, true, success.error);
        assert.strictEqual(argValue(calls[0].args, '-DefinitionFile'), await fs.promises.realpath(definition));
        assert.strictEqual(
            argValue(calls[0].args, '-OutputPath'),
            path.resolve(await fs.promises.realpath(configRoot), path.relative(configRoot, output)),
        );
    });

    test('allows only safe report extensions and prevents report output from aliasing the effective template', async () => {
        const template = path.join(configRoot, 'Reports', 'Monthly', 'Templates', 'Main', 'Ext', 'Template.xml');
        await writeTemplate(template);
        const reportDir = path.join(configRoot, 'Reports', 'Monthly', 'AgentReports');
        await fs.promises.mkdir(reportDir, { recursive: true });
        const unsafeTargets = ['metadata.xml', 'source.bsl', 'module.mdo', 'support.bin', 'v8-project.json', 'notes.md'];

        for (const fileName of unsafeTargets) {
            const beforeCalls = calls.length;
            const result = await operations.skdInfo({ templatePath: template, outFile: path.join(reportDir, fileName) });
            assert.strictEqual(result.success, false, `${fileName} must not be a report target`);
            assert.strictEqual(calls.length, beforeCalls, 'unsafe report suffix must fail before process launch');
        }

        const aliasReport = path.join(reportDir, 'template.log');
        try {
            await fs.promises.symlink(template, aliasReport, 'file');
        } catch {
            await fs.promises.link(template, aliasReport);
        }
        const aliasResult = await operations.skdValidate({ templatePath: template, outFile: aliasReport });
        assert.strictEqual(aliasResult.success, false, 'canonical output alias must not overwrite the input template');
        assert.strictEqual(calls.length, 0);
    });
});

function argValue(args: readonly string[], name: string): string {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? '' : '';
}

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

suite('SkdOperations — truncated PowerShell payload contract', () => {
    const operationsUnderTest = [
        {
            name: 'skdValidate (valid prefix, omitted later errors)',
            stdout: '[OK] СКД валидна\n',
            invoke: (operations: SkdOperations) => operations.skdValidate({ templatePath: 'template.xml' }),
        },
        {
            name: 'skdCompile',
            stdout: 'OK  /tmp/output.xml\nDataSets: 3  Fields: 10  Calculated: 2  Totals: 4  Params: 5  Variants: 1\nSize: 2048 bytes\n',
            invoke: (operations: SkdOperations) => operations.skdCompile({ outputPath: '/tmp/output.xml', value: '{}' }),
        },
        {
            name: 'skdInfo',
            stdout: 'DataSet: Main\nFields: 10\n',
            invoke: (operations: SkdOperations) => operations.skdInfo({ templatePath: 'template.xml' }),
        },
        {
            name: 'skdEdit',
            stdout: '[OK] Saved /tmp/template.xml\n',
            invoke: (operations: SkdOperations) => operations.skdEdit({
                templatePath: '/tmp/template.xml',
                operation: 'add-field',
                value: '{}',
            }),
        },
    ];

    for (const operation of operationsUnderTest) {
        for (const stream of ['stdout', 'stderr'] as const) {
            test(`${operation.name} fails closed before parsing when ${stream} is truncated after exit 0`, async () => {
                const operations = new SkdOperations({
                    extensionPath: FAKE_EXTENSION_PATH,
                    runPowerShellScript: async () => ({
                        stdout: operation.stdout,
                        stderr: 'partial PowerShell diagnostic',
                        exitCode: 0,
                        ...(stream === 'stdout' ? { stdoutTruncated: true } : { stderrTruncated: true }),
                    }),
                });

                const result = await operation.invoke(operations);

                assert.strictEqual(result.success, false);
                assert.strictEqual(result.code, 'SKD_OUTPUT_TRUNCATED');
                assert.match(result.error ?? '', new RegExp(stream, 'i'));
                assert.strictEqual(result.data, undefined);
            });
        }
    }

    test('skdInfo preserves its existing application-level [TRUNCATED] result', async () => {
        const operations = new SkdOperations({
            extensionPath: FAKE_EXTENSION_PATH,
            runPowerShellScript: async () => ({
                stdout: 'Overview\n[TRUNCATED]\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await operations.skdInfo({ templatePath: 'template.xml' });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data && 'info' in result.data ? result.data.truncated : undefined, true);
    });
});

suite('SkdOperations — cancellation and timeout after possible effects', () => {
    const operationsUnderTest: Array<{
        name: string;
        stdout: string;
        invoke: (operations: SkdOperations, token?: vscode.CancellationToken) => Promise<AgentResult<unknown>>;
    }> = [
        {
            name: 'skdCompile',
            stdout: 'OK  /tmp/output.xml\nDataSets: 3  Fields: 10\nSize: 2048 bytes\n',
            invoke: (operations, token) => operations.skdCompile({ outputPath: '/tmp/output.xml', value: '{}' }, token),
        },
        {
            name: 'skdInfo',
            stdout: 'DataSet: Main\nFields: 10\n',
            invoke: (operations, token) => operations.skdInfo({ templatePath: 'template.xml' }, token),
        },
        {
            name: 'skdEdit',
            stdout: '[OK] Saved /tmp/template.xml\n',
            invoke: (operations, token) => operations.skdEdit({
                templatePath: '/tmp/template.xml',
                operation: 'add-field',
                value: '{}',
            }, token),
        },
        {
            name: 'skdValidate',
            stdout: '[OK] СКД валидна\n',
            invoke: (operations, token) => operations.skdValidate({ templatePath: 'template.xml' }, token),
        },
    ];

    for (const operation of operationsUnderTest) {
        test(`${operation.name} treats close(0) during confirmed cancellation termination as inDoubt`, async () => {
            const child = new InjectedPowerShellChild();
            const terminationGate = createTerminationGate();
            let terminationStarted!: () => void;
            const terminationStartedPromise = new Promise<void>((resolve) => { terminationStarted = resolve; });
            let runnerResult: PowerShellRunResult | undefined;
            const dependencies = makePowerShellDependencies(child, async () => {
                terminationStarted();
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
            const confirmedTermination: ProcessTreeTerminationOutcome = {
                terminated: true,
                hardKillUsed: false,
                survivingPids: [],
                errors: [],
            };

            try {
                const resultPromise = operation.invoke(operations, source.token);
                await child.waitForSpawn();
                source.cancel();
                await terminationStartedPromise;
                child.completeExit(0, null);
                terminationGate.release(confirmedTermination);

                const result = await resultPromise;
                assert.strictEqual(runnerResult?.exitCode, 0, 'the close(0) race must be preserved');
                assert.strictEqual(runnerResult?.effectPossible, true);
                assert.strictEqual(runnerResult?.cancellationRequested, true);
                assert.strictEqual(runnerResult?.cancelled, true, 'termination confirmation does not acknowledge the SKD result');
                assert.strictEqual(runnerResult?.termination?.terminated, true);
                assert.strictEqual(result.success, false);
                assert.strictEqual(result.code, 'SKD_OPERATION_IN_DOUBT');
                assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
            } finally {
                terminationGate.release(confirmedTermination);
                child.completeExit(null, 'SIGTERM');
                source.dispose();
            }
        });

        test(`${operation.name} treats a timed-out exitCode 0 with possible effects as inDoubt`, async () => {
            const operations = new SkdOperations({
                extensionPath: FAKE_EXTENSION_PATH,
                runPowerShellScript: async () => ({
                    stdout: operation.stdout,
                    stderr: '',
                    exitCode: 0,
                    started: true,
                    effectPossible: true,
                    timedOut: true,
                    termination: {
                        terminated: true,
                        hardKillUsed: false,
                        survivingPids: [],
                        errors: [],
                    },
                }),
            });

            const result = await operation.invoke(operations);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, 'SKD_OPERATION_IN_DOUBT');
            assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
        });
    }
});

suite('PowerShell runner process-tree termination', () => {
    test('decodes UTF-8 characters split across stdout and stderr chunks', async () => {
        const child = new InjectedPowerShellChild();
        const outputChunks: string[] = [];
        const run = runPowerShellScript({
            scriptPath: 'injected.ps1',
            args: [],
            onOutput: (chunk) => outputChunks.push(chunk),
        }, makePowerShellDependencies(child, async () => ({
            terminated: true,
            hardKillUsed: false,
            survivingPids: [],
            errors: [],
        })));

        await child.waitForSpawn();
        const stdout = Buffer.from('Проверка СКД', 'utf8');
        const stderr = Buffer.from('Ошибка PowerShell', 'utf8');
        child.stdout.write(stdout.subarray(0, 1));
        child.stdout.write(stdout.subarray(1, 4));
        child.stdout.write(stdout.subarray(4));
        child.stderr.write(stderr.subarray(0, 2));
        child.stderr.write(stderr.subarray(2, 7));
        child.stderr.write(stderr.subarray(7));
        child.completeExit(0, null);

        const result = await run;
        assert.strictEqual(result.stdout, 'Проверка СКД');
        assert.strictEqual(result.stderr, 'Ошибка PowerShell');
        assert.strictEqual(outputChunks.join(''), 'Проверка СКДОшибка PowerShell');
    });

    test('decodes CP866 розница when stdout and stderr split after the first lead byte', async () => {
        const child = new InjectedPowerShellChild();
        const run = runPowerShellScript({ scriptPath: 'injected.ps1', args: [] },
            makePowerShellDependencies(child, async () => ({
                terminated: true,
                hardKillUsed: false,
                survivingPids: [],
                errors: [],
            })));

        await child.waitForSpawn();
        const encoded = iconv.encode('розница', 'cp866');
        assert.strictEqual(encoded.toString('hex'), 'e0aea7ada8e6a0');
        child.stdout.write(encoded.subarray(0, 1));
        child.stderr.write(encoded.subarray(0, 1));
        for (let index = 1; index < encoded.length; index++) {
            child.stdout.write(encoded.subarray(index, index + 1));
            child.stderr.write(encoded.subarray(index, index + 1));
        }
        child.completeExit(0, null);

        const result = await run;
        assert.strictEqual(result.stdout, 'розница');
        assert.strictEqual(result.stderr, 'розница');
    });

    test('bounds retained stdout and stderr payloads and reports overflow', async () => {
        const child = new InjectedPowerShellChild();
        const oversized = Buffer.alloc(1024 * 1024 + 37, 0x61);
        const run = runPowerShellScript({ scriptPath: 'injected.ps1', args: [] },
            makePowerShellDependencies(child, async () => ({
                terminated: true,
                hardKillUsed: false,
                survivingPids: [],
                errors: [],
            })));

        await child.waitForSpawn();
        child.stdout.write(oversized);
        child.stderr.write(oversized);
        child.completeExit(0, null);

        const result = await run;
        const bounded = result as PowerShellRunResult & {
            stdoutTruncated?: boolean;
            stderrTruncated?: boolean;
        };
        assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
        assert.ok(Buffer.byteLength(result.stderr) <= 1024 * 1024);
        assert.strictEqual(bounded.stdoutTruncated, true);
        assert.strictEqual(bounded.stderrTruncated, true);
    });

    test('pre-cancel avoids resolving and spawning a PowerShell child', async () => {
        const source = new vscode.CancellationTokenSource();
        source.cancel();
        let resolveCalls = 0;
        let spawnCalls = 0;

        try {
            const result = await runPowerShellScript({
                scriptPath: 'injected.ps1',
                args: [],
                token: source.token,
            }, {
                resolveExecutable: async () => {
                    resolveCalls += 1;
                    return 'injected-powershell';
                },
                spawnImpl: (() => {
                    spawnCalls += 1;
                    return new InjectedPowerShellChild() as unknown as ChildProcess;
                }) as NonNullable<PowerShellRunnerDependencies['spawnImpl']>,
            });

            assert.strictEqual(resolveCalls, 0);
            assert.strictEqual(spawnCalls, 0);
            assert.strictEqual(result.started, false);
            assert.strictEqual(result.effectPossible, false);
            assert.strictEqual(result.cancelled, true);
        } finally {
            source.dispose();
        }
    });

    test('cancellation after handle creation but before spawn preserves shared lifecycle outcome', async () => {
        const child = new InjectedPowerShellChild(false);
        const source = new vscode.CancellationTokenSource();
        let terminationCalls = 0;
        const dependencies = makePowerShellDependencies(child, async () => {
            terminationCalls += 1;
            return {
                terminated: false,
                hardKillUsed: true,
                survivingPids: [34567],
                errors: ['injected survivor before spawn'],
            };
        });

        try {
            const run = runPowerShellScript({
                scriptPath: 'injected.ps1',
                args: [],
                token: source.token,
            }, dependencies);
            await new Promise<void>((resolve) => setImmediate(resolve));
            source.cancel();

            const result = await run;
            assert.strictEqual(terminationCalls, 1);
            assert.strictEqual(result.started, false);
            assert.strictEqual(result.effectPossible, true);
            assert.strictEqual(result.cancellationRequested, true);
            assert.strictEqual(result.cancelled, false);
            assert.strictEqual(result.termination?.terminated, false);
            assert.deepStrictEqual(result.termination?.survivingPids, [34567]);
        } finally {
            child.completeExit(null, 'SIGTERM');
            source.dispose();
        }
    });

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
            child.completeExit(0, null);
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
            assert.strictEqual(runnerResult?.exitCode, -1, 'timeout preserves the PowerShell domain result');
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

    test('skdCompile parses compilation statistics and output path', async () => {
        const operations = new SkdOperations({
            extensionPath: FAKE_EXTENSION_PATH,
            runPowerShellScript: async () => ({
                stdout: 'OK  /workspace/out.xml\n    DataSets: 3  Fields: 10  Calculated: 2  Totals: 4  Params: 5  Variants: 1\n    Size: 2048 bytes\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await operations.skdCompile({ outputPath: '/workspace/out.xml', value: '<Schema/>' });
        assert.strictEqual(result.success, true);
        assert.ok(result.data && 'stats' in result.data, 'successful compilation must return parsed data and statistics');
        if (!result.data || !('stats' in result.data)) {
            assert.fail('successful compilation must return parsed data and statistics');
        }
        assert.strictEqual(result.data.output, '/workspace/out.xml');
        assert.deepStrictEqual(result.data.stats, {
            dataSets: 3,
            fields: 10,
            calculated: 2,
            totals: 4,
            parameters: 5,
            variants: 1,
            sizeBytes: 2048,
        });
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

    constructor(autoSpawn = true) {
        super();
        if (autoSpawn) {
            setImmediate(() => this.emitSpawn());
        }
    }

    private emitSpawn(): void {
        if (this.spawned) { return; }
        this.spawned = true;
        this.emit('spawn');
        for (const resolve of this.spawnWaiters.splice(0)) { resolve(); }
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
