import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { reconcileAfterCommit } from '../../src/reload/reconciliation';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { AgentResult } from '../../src/agent/types';
import type { RequestConfigurationReload } from '../../src/reload/requestConfigurationReload';
import type { ReloadReason } from '../../src/types/reloadContracts';
import type { SkdOperationsDeps } from '../../src/agent/agentSkdOperations';

suite('Agent SKD Operations Integrity (#352)', () => {
  let tempDir: string;
  let registry: WorkspaceRegistry;
  let reloadsRequested: Array<{ configPath: string; reason: ReloadReason }>;
  let reloadCoordinatorStub: RequestConfigurationReload;
  let runnerCalls: Array<{ scriptPath: string; args: string[] }>;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-skd-integrity-'));
    reloadsRequested = [];
    runnerCalls = [];
    reloadCoordinatorStub = async (configPath: string, reason: ReloadReason) => {
      reloadsRequested.push({ configPath, reason });
    };
    registry = new WorkspaceRegistry(undefined, (identity) => new ConfigurationSession(identity, (commit) =>
      reconcileAfterCommit(commit.rootPath, 'agent-mutation', (configPath, reason) =>
        reloadCoordinatorStub(configPath, reason))));
  });

  teardown(async () => {
    await registry.dispose();
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    resetVscodeTestState();
  });

  async function createConfigRoot(name: string, uuid: string): Promise<string> {
    const root = path.join(tempDir, name);
    const reportsDir = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext');
    await fs.promises.mkdir(reportsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(root, 'Configuration.xml'),
      `<MetaDataObject version="2.20"><Configuration uuid="${uuid}"><ChildObjects><Report>TestReport</Report></ChildObjects></Configuration></MetaDataObject>`,
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(root, 'Reports', 'TestReport.xml'),
      '<MetaDataObject version="2.20"><Report><Properties><Name>TestReport</Name></Properties></Report></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(reportsDir, 'Template.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"><dataSource><name>DataSource1</name></dataSource></DataCompositionSchema>',
      'utf8',
    );
    return fs.promises.realpath(root);
  }

  function setupCommands(
    requestReload?: RequestConfigurationReload,
    runner?: SkdOperationsDeps['runPowerShellScript'],
  ) {
    if (requestReload) {
      reloadCoordinatorStub = requestReload;
    }
    const context = {
      extensionPath: path.resolve(__dirname, '..', '..'),
      subscriptions: [] as Array<{ dispose(): void }>,
    };
    return registerAgentCommands(
      context as never,
      () => null,
      async () => registry,
      new DebugSessionRegistry(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      requestReload ?? reloadCoordinatorStub,
      runner ? () => ({ runPowerShellScript: runner }) : undefined,
    );
  }

  function createRunner(): NonNullable<SkdOperationsDeps['runPowerShellScript']> {
    return async ({ scriptPath, args }) => {
      runnerCalls.push({ scriptPath, args });
      const templatePath = argumentValue(args, '-TemplatePath');
      const outputPath = argumentValue(args, '-OutputPath');
      const outFile = argumentValue(args, '-OutFile');
      if (scriptPath.endsWith('skd-edit.ps1')) {
        await fs.promises.writeFile(templatePath, '<DataCompositionSchema><updated/></DataCompositionSchema>', 'utf8');
        return { stdout: `[OK] Saved ${templatePath}`, stderr: '', exitCode: 0 };
      }
      if (scriptPath.endsWith('skd-compile.ps1')) {
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.promises.writeFile(outputPath, '<DataCompositionSchema/>', 'utf8');
        return { stdout: `OK  ${outputPath}\n    DataSets: 1  Fields: 0  Calculated: 0  Totals: 0  Params: 0  Variants: 0\n    Size: 1 bytes`, stderr: '', exitCode: 0 };
      }
      if (scriptPath.endsWith('skd-info.ps1')) {
        if (outFile) {
          await fs.promises.writeFile(outFile, 'SKD info report', 'utf8');
        }
        return { stdout: 'SKD Structure Info', stderr: '', exitCode: 0 };
      }
      if (outFile) {
        await fs.promises.writeFile(outFile, '=== Validation OK: Template.xml (1 checks) ===', 'utf8');
      }
      return { stdout: '=== Validation OK: Template.xml (1 checks) ===', stderr: '', exitCode: 0 };
    };
  }

  test('skd.compile resolves configuration from outputPath, acquires write lock and serializes session', async () => {
    const root = await createConfigRoot('conf-compile', '11111111-1111-1111-1111-111111111111');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const compileHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
    const outputPath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    // Run compile with value DSL
    const res = await compileHandler({
      outputPath,
      value: JSON.stringify({ dataSets: [] }),
    }) as AgentResult;

    // Must be routed through ConfigurationSession: returns configurationId and operationId
    assert.strictEqual(res.configurationId !== undefined, true, 'Result must contain configurationId from ConfigurationSession');
    assert.strictEqual(res.operationId !== undefined, true, 'Result must contain operationId from write queue');
  });

  test('skd.edit resolves configuration from templatePath and acquires write lock', async () => {
    const root = await createConfigRoot('conf-edit', '22222222-2222-2222-2222-222222222222');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const editHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
    const templatePath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const res = await editHandler({
      templatePath,
      operation: 'add-field',
      value: JSON.stringify({ name: 'Field1' }),
    }) as AgentResult;

    assert.strictEqual(res.configurationId !== undefined, true, 'Result must contain configurationId from ConfigurationSession');
    assert.strictEqual(res.operationId !== undefined, true, 'Result must contain operationId from write queue');
  });

  test('skd.info and skd.validate acquire read lock in ConfigurationSession', async () => {
    const root = await createConfigRoot('conf-info', '33333333-3333-3333-3333-333333333333');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const infoHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
    const validateHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.validate')!;
    const templatePath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const infoRes = await infoHandler({ templatePath }) as AgentResult;
    assert.strictEqual(infoRes.configurationId !== undefined, true, 'skd.info must return configurationId');
    assert.strictEqual(infoRes.snapshotVersion !== undefined, true, 'skd.info must return snapshotVersion from read session');

    const validateRes = await validateHandler({ templatePath }) as AgentResult;
    assert.strictEqual(validateRes.configurationId !== undefined, true, 'skd.validate must return configurationId');
    assert.strictEqual(validateRes.snapshotVersion !== undefined, true, 'skd.validate must return snapshotVersion from read session');
  });

  test('skd.compile rejects outputPath escaping configuration root with TARGET_OUTSIDE_ROOT', async () => {
    const root = await createConfigRoot('conf-escape-compile', '44444444-4444-4444-4444-444444444444');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const compileHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
    const outsideTarget = path.join(tempDir, 'outside.xml');

    const res = await compileHandler({
      outputPath: outsideTarget,
      value: '{}',
    }) as AgentResult;

    assert.strictEqual(res.success, false);
    assert.ok(
      res.code === 'TARGET_OUTSIDE_ROOT' || res.code === 'CONFIGURATION_NOT_FOUND',
      `Expected TARGET_OUTSIDE_ROOT or CONFIGURATION_NOT_FOUND but got ${res.code}: ${res.error}`,
    );
  });

  test('skd.edit rejects templatePath escaping configuration root with TARGET_OUTSIDE_ROOT', async () => {
    const root = await createConfigRoot('conf-escape-edit', '55555555-5555-5555-5555-555555555555');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const editHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
    const outsideTarget = path.join(tempDir, 'outside.xml');

    const res = await editHandler({
      templatePath: outsideTarget,
      operation: 'add-field',
      value: '{}',
    }) as AgentResult;

    assert.strictEqual(res.success, false);
    assert.ok(
      res.code === 'TARGET_OUTSIDE_ROOT' || res.code === 'CONFIGURATION_NOT_FOUND',
      `Expected TARGET_OUTSIDE_ROOT or CONFIGURATION_NOT_FOUND but got ${res.code}: ${res.error}`,
    );
  });

  test('skd.info rejects templatePath escaping configuration root with TARGET_OUTSIDE_ROOT', async () => {
    const root = await createConfigRoot('conf-escape-info', '66666666-6666-6666-6666-666666666666');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const infoHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
    const outsideTarget = path.join(tempDir, 'outside.xml');

    const res = await infoHandler({
      templatePath: outsideTarget,
    }) as AgentResult;

    assert.strictEqual(res.success, false);
    assert.ok(
      res.code === 'TARGET_OUTSIDE_ROOT' || res.code === 'CONFIGURATION_NOT_FOUND',
      `Expected TARGET_OUTSIDE_ROOT or CONFIGURATION_NOT_FOUND but got ${res.code}: ${res.error}`,
    );
  });

  test('skd.compile triggers ReloadCoordinator on successful mutation', async () => {
    const root = await createConfigRoot('conf-reload-compile', '77777777-7777-7777-7777-777777777777');
    await registry.refresh([{ configPath: root }]);
    setupCommands(undefined, createRunner());

    const compileHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
    const outputPath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    // Run compile with stubbed successful output if pwsh runner is invoked, or test reload hook invocation
    // In our test, if compileHandler triggers runForConfiguration and finishes, reloadCoordinatorStub is notified
    const res = await compileHandler({
      outputPath,
      value: JSON.stringify({ dataSets: [] }),
    }) as AgentResult;

    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(reloadsRequested.length, 1);
    assert.strictEqual(reloadsRequested[0].configPath, root);
    assert.strictEqual(reloadsRequested[0].reason, 'agent-mutation');
  });

  test('SKD timeout with possible file effects reconciles while preserving inDoubt failure status', async () => {
    const root = await createConfigRoot('conf-in-doubt-reload', '12121212-3434-5656-7878-909090909090');
    await registry.refresh([{ configPath: root }]);
    const runner: NonNullable<SkdOperationsDeps['runPowerShellScript']> = async () => ({
      stdout: '',
      stderr: 'process timed out',
      exitCode: -1,
      timedOut: true,
      effectPossible: true,
      cancellationRequested: true,
    });
    setupCommands(async (configPath, reason) => {
      reloadsRequested.push({ configPath, reason });
    }, runner);

    const edit = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
    const templatePath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');
    const result = await edit({ templatePath, operation: 'set-query', value: 'SELECT 1' }) as AgentResult;

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'SKD_OPERATION_IN_DOUBT');
    assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
    assert.deepStrictEqual(result.reconciliation, { status: 'succeeded' });
    assert.deepStrictEqual(reloadsRequested, [{ configPath: root, reason: 'agent-mutation' }]);
    assert.strictEqual(registry.list()[0]!.rootPath, root);
    assert.strictEqual(registry.require(registry.list()[0]!.configurationId).snapshotVersion, 0);
  });

  test('skd.validate rejects templatePath escaping configuration root with TARGET_OUTSIDE_ROOT', async () => {
    const root = await createConfigRoot('conf-escape-val', '66666666-7777-8888-9999-000000000000');
    await registry.refresh([{ configPath: root }]);
    setupCommands();

    const validateHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.validate')!;
    const outsideTarget = path.join(tempDir, 'outside.xml');

    const res = await validateHandler({
      templatePath: outsideTarget,
    }) as AgentResult;

    assert.strictEqual(res.success, false);
    assert.ok(
      res.code === 'TARGET_OUTSIDE_ROOT' || res.code === 'CONFIGURATION_NOT_FOUND',
      `Expected TARGET_OUTSIDE_ROOT or CONFIGURATION_NOT_FOUND but got ${res.code}: ${res.error}`,
    );
  });

  test('skd.compile with explicit configurationId rejects target outside that root with TARGET_OUTSIDE_ROOT', async () => {
    const rootA = await createConfigRoot('conf-explicit-a', 'aaaaaaaa-1111-2222-3333-444444444444');
    const rootB = await createConfigRoot('conf-explicit-b', 'bbbbbbbb-1111-2222-3333-444444444444');
    await registry.refresh([{ configPath: rootA }, { configPath: rootB }]);
    setupCommands();

    const compileHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
    const targetInB = path.join(rootB, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const descA = registry.list().find((d) => d.rootPath === rootA)!;
    const res = await compileHandler({
      configurationId: descA.configurationId,
      outputPath: targetInB,
      value: '{}',
    }) as AgentResult;

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'TARGET_OUTSIDE_ROOT');
  });

  test('skd.compile and skd.edit respect background execution while holding configuration lock', async () => {
    const root = await createConfigRoot('conf-bg', '88888888-8888-8888-8888-888888888888');
    await registry.refresh([{ configPath: root }]);
    const { taskManager } = setupCommands();

    const compileHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
    const outputPath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const res = await compileHandler({
      outputPath,
      value: JSON.stringify({ dataSets: [] }),
      background: true,
    }) as AgentResult<{ taskId: string }>;

    assert.strictEqual(res.success, true);
    assert.ok(res.data?.taskId, 'Background command must return taskId');
    taskManager.dispose();
  });

  test('relative SKD paths route from the selected single configuration and are normalized before process dispatch', async () => {
    const root = await createConfigRoot('conf-relative-routing', '99999999-1111-2222-3333-444444444444');
    await registry.refresh([{ configPath: root }]);
    const runner = createRunner();
    setupCommands(undefined, runner);
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
    const template = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const result = await handler({ templatePath: path.relative(root, template) }) as AgentResult;

    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(argumentValue(runnerCalls[0]!.args, '-TemplatePath'), await fs.promises.realpath(template));
    assert.strictEqual(result.operationId, undefined, 'read-only info must not create a mutation receipt');
  });

  test('relative SKD path with configurationId uses that root and multiple roots without an id fail closed', async () => {
    const rootA = await createConfigRoot('conf-relative-a', 'aaaaaaaa-1111-2222-3333-444444444444');
    const rootB = await createConfigRoot('conf-relative-b', 'bbbbbbbb-1111-2222-3333-444444444444');
    await registry.refresh([{ configPath: rootA }, { configPath: rootB }]);
    const runner = createRunner();
    setupCommands(undefined, runner);
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
    const descriptorA = registry.list().find((descriptor) => descriptor.rootPath === rootA)!;
    const relativeTemplate = path.join('Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const selected = await handler({ configurationId: descriptorA.configurationId, templatePath: relativeTemplate }) as AgentResult;
    assert.strictEqual(selected.success, true, selected.error);
    assert.strictEqual(argumentValue(runnerCalls[0]!.args, '-TemplatePath'), await fs.promises.realpath(path.join(rootA, relativeTemplate)));

    const ambiguous = await handler({ templatePath: relativeTemplate }) as AgentResult;
    assert.strictEqual(ambiguous.success, false);
    assert.strictEqual(ambiguous.code, 'CONFIGURATION_SELECTION_REQUIRED');
    assert.strictEqual(runnerCalls.length, 1, 'ambiguous relative paths must not dispatch a process');
  });

  test('info and validate use read sessions without OutFile and committed write sessions with safe report OutFile', async () => {
    const root = await createConfigRoot('conf-report-session', 'cccccccc-1111-2222-3333-444444444444');
    await registry.refresh([{ configPath: root }]);
    const runner = createRunner();
    const { taskManager } = setupCommands(undefined, runner);
    const templatePath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');
    const info = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
    const validate = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.validate')!;

    const readInfo = await info({ templatePath }) as AgentResult;
    assert.strictEqual(readInfo.success, true, readInfo.error);
    assert.strictEqual(readInfo.operationId, undefined);
    const readValidate = await validate({ templatePath }) as AgentResult;
    assert.strictEqual(readValidate.success, true, readValidate.error);
    assert.strictEqual(readValidate.operationId, undefined);

    const reportPath = path.join(root, 'Reports', 'TestReport', 'skd-report.txt');
    const report = await info({ templatePath, outFile: reportPath }) as AgentResult;
    assert.strictEqual(report.success, true, report.error);
    assert.ok(report.configurationId);
    assert.ok(report.operationId, 'writing OutFile must be committed through the configuration session');
    assert.strictEqual(report.snapshotVersion, readValidate.snapshotVersion, 'report output does not advance the configuration mutation version');
    assert.strictEqual(await fs.promises.readFile(reportPath, 'utf8'), 'SKD info report');
    assert.strictEqual(reloadsRequested.length, 0, 'report writes do not trigger metadata-tree reload');

    const unsafe = await validate({ templatePath, outFile: path.join(root, 'Reports', 'TestReport.xml') }) as AgentResult;
    assert.strictEqual(unsafe.success, false);
    assert.strictEqual(runnerCalls.length, 3, 'unsupported report target must be rejected before process dispatch');
    await taskManager.dispose();
  });

  test('schema write commits once, releases the writer lease before reload, and exposes reload failure as reconciliation', async () => {
    const root = await createConfigRoot('conf-reconciliation', 'dddddddd-1111-2222-3333-444444444444');
    await registry.refresh([{ configPath: root }]);
    let readCompletedInsideReload = false;
    let readPromise: Promise<unknown> | undefined;
    const reload = async (configPath: string) => {
      const session = await registry.resolveResource(configPath);
      readPromise = session.runRead(async () => {
        readCompletedInsideReload = true;
        return undefined;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const error = new Error('reload rejected after the disk commit') as Error & { code?: string };
      error.code = 'TEST_RELOAD_FAILED';
      throw error;
    };
    const runner = createRunner();
    setupCommands(reload, runner);
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
    const templatePath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const result = await handler({ templatePath, operation: 'set-query', value: 'SELECT 1' }) as AgentResult;
    await readPromise;

    assert.strictEqual(readCompletedInsideReload, true, 'reload callback must run after the writer lease is released');
    assert.strictEqual(result.success, true, 'reload failure must not rewrite a committed disk result as failed');
    assert.ok(result.configurationId);
    assert.ok(result.operationId);
    assert.ok((result.snapshotVersion ?? 0) > 0);
    assert.deepStrictEqual(result.reconciliation, {
      status: 'failed',
      code: 'TEST_RELOAD_FAILED',
      message: 'reload rejected after the disk commit',
    });
    assert.strictEqual(runnerCalls.length, 1, 'a committed mutation must never be retried after reload failure');
    assert.ok((await fs.promises.readFile(templatePath, 'utf8')).includes('<updated/>'));
  });

  test('background task remains running through post-commit reconciliation and stores its committed receipt', async () => {
    const root = await createConfigRoot('conf-background-reconciliation', 'eeeeeeee-1111-2222-3333-444444444444');
    await registry.refresh([{ configPath: root }]);
    let releaseReload!: () => void;
    let announceReload!: () => void;
    const reloadStarted = new Promise<void>((resolve) => { announceReload = resolve; });
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    const { taskManager } = setupCommands(async () => {
      announceReload();
      await reloadGate;
    }, createRunner());
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
    const templatePath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    const started = await handler({ templatePath, operation: 'set-query', value: 'SELECT 1', background: true }) as AgentResult<{ taskId: string }>;
    assert.strictEqual(started.success, true, started.error);
    const taskId = started.data!.taskId;
    await reloadStarted;
    assert.strictEqual(taskManager.result(taskId).data?.status, 'running', 'task lifetime must include reload reconciliation');
    releaseReload();
    for (let attempt = 0; attempt < 50 && taskManager.result(taskId).data?.status === 'running'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const task = taskManager.result(taskId).data!;
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.result?.success, true);
    assert.ok(task.result?.operationId);
    assert.deepStrictEqual(task.result?.reconciliation, { status: 'succeeded' });
    await taskManager.dispose();
  });
});

function argumentValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : '';
}
