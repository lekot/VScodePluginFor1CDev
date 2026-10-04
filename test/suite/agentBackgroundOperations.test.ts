import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import type * as vscode from 'vscode';
import { AgentDeployOperations } from '../../src/agent/agentDeployOperations';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

type DeployMethod = 'deploy' | 'deploySelectedObjects' | 'deployChangedFiles' | 'pullSelectedObjects' | 'exportStatus';

suite('Agent background operations', () => {
  test('keeps direct deploy synchronous, exposes a supplied token, and backgrounds all long deploy commands', async () => {
    resetVscodeTestState();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-background-'));
    const configXml = path.join(temp, 'Configuration.xml');
    await fs.writeFile(configXml, '<Configuration uuid="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"/>', 'utf8');
    const registry = new WorkspaceRegistry();
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const originals = new Map<DeployMethod, AgentDeployOperations[DeployMethod]>();
    const received: Array<{ method: DeployMethod; token?: vscode.CancellationToken }> = [];
    const cancellation: vscode.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    try {
      await registry.refresh([{ configPath: temp, format: ConfigFormat.Designer }]);
      const configurationId = registry.list()[0]!.configurationId;
      const methods: readonly DeployMethod[] = [
        'deploy', 'deploySelectedObjects', 'deployChangedFiles', 'pullSelectedObjects', 'exportStatus',
      ];
      for (const method of methods) {
        originals.set(method, AgentDeployOperations.prototype[method]);
        Reflect.set(AgentDeployOperations.prototype, method, async function (_params: unknown, execution: { token?: vscode.CancellationToken }) {
          received.push({ method, token: execution?.token });
          return { success: true, data: { method } };
        });
      }

      registerAgentCommands(
        context as never,
        () => null,
        async () => registry,
        new DebugSessionRegistry(),
        undefined,
        () => ({ bindingManager: {} as never, infobaseStorage: {} as never, getConfigPath: () => null }),
      );

      const deploy = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.deploy')!;
      const synchronous = await deploy({ configurationId }, cancellation) as { success: boolean; data?: { method?: string } };
      assert.strictEqual(synchronous.success, true);
      assert.strictEqual(synchronous.data?.method, 'deploy');
      assert.deepStrictEqual(received[0], { method: 'deploy', token: cancellation });

      const inputs: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['deploy', { configurationId, background: true }],
        ['deploySelectedObjects', { configurationId, files: ['Catalogs/Goods.xml'], background: true }],
        ['deployChangedFiles', { configurationId, background: true }],
        ['pullSelectedObjects', { configurationId, objectIds: ['Catalog.Goods'], background: true }],
        ['exportStatus', { configurationId, background: true }],
      ];
      const receipts: Array<{ status: string; taskId: string }> = [];
      for (const [method, input] of inputs) {
        const commandSuffix = method === 'deploySelectedObjects' ? 'deploySelectedObjects'
          : method === 'deployChangedFiles' ? 'deployChangedFiles'
            : method === 'pullSelectedObjects' ? 'pullSelectedObjects'
              : method === 'exportStatus' ? 'exportStatus' : 'deploy';
        const handler = vscodeTestState.registeredCommandHandlers.get(`1c-metadata-tree.agent.${commandSuffix}`)!;
        const result = await handler(input) as { success: boolean; data?: { status: string; taskId: string } };
        assert.strictEqual(result.success, true, method);
        receipts.push(result.data!);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const statusHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.task.status')!;
      for (const receipt of receipts) {
        assert.strictEqual(receipt.status, 'working');
        const status = await statusHandler({ taskId: receipt.taskId }) as { success: boolean; data?: { status: string } };
        assert.strictEqual(status.success, true);
        assert.strictEqual(status.data?.status, 'completed');
      }
      for (const method of methods) {
        assert.ok(received.some((call) => call.method === method && call.token), `${method} receives task token`);
      }
    } finally {
      for (const [method, original] of originals) {
        Reflect.set(AgentDeployOperations.prototype, method, original);
      }
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
      await registry.dispose();
      await fs.rm(temp, { recursive: true, force: true });
      resetVscodeTestState();
    }
  });
});
