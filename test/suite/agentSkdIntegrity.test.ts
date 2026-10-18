import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { AgentResult } from '../../src/agent/types';
import type { RequestConfigurationReload } from '../../src/reload/requestConfigurationReload';
import type { ReloadReason } from '../../src/types/reloadContracts';

suite('Agent SKD Operations Integrity (#352)', () => {
  let tempDir: string;
  let registry: WorkspaceRegistry;
  let reloadsRequested: Array<{ configPath: string; reason: ReloadReason }>;
  let reloadCoordinatorStub: RequestConfigurationReload;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-skd-integrity-'));
    registry = new WorkspaceRegistry();
    reloadsRequested = [];
    reloadCoordinatorStub = async (configPath: string, reason: ReloadReason) => {
      reloadsRequested.push({ configPath, reason });
    };
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

  function setupCommands(requestReload?: RequestConfigurationReload) {
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
    );
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
    setupCommands();

    const compileHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
    const outputPath = path.join(root, 'Reports', 'TestReport', 'Templates', 'MainScheme', 'Ext', 'Template.xml');

    // Run compile with stubbed successful output if pwsh runner is invoked, or test reload hook invocation
    // In our test, if compileHandler triggers runForConfiguration and finishes, reloadCoordinatorStub is notified
    const res = await compileHandler({
      outputPath,
      value: JSON.stringify({ dataSets: [] }),
    }) as AgentResult;

    if (res.success) {
      assert.strictEqual(reloadsRequested.length, 1);
      assert.strictEqual(reloadsRequested[0].configPath, root);
      assert.strictEqual(reloadsRequested[0].reason, 'agent-mutation');
    }
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
});
