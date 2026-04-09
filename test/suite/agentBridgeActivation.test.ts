// test/suite/agentBridgeActivation.test.ts
// Unit-тесты для activateAgentBridge (P7b-4).

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
  installVscodeModuleStubForCoreTests,
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';

installVscodeModuleStubForCoreTests();

// Import after stub is installed so the module uses the mocked vscode.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { activateAgentBridge } = require('../../src/agent/agentBridgeActivation') as typeof import('../../src/agent/agentBridgeActivation');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentBridgeModule = require('../../src/agent/agentBridge') as typeof import('../../src/agent/agentBridge');
const { AgentBridge } = agentBridgeModule;

/** Minimal ExtensionContext mock. */
function makeContext(): { subscriptions: Array<{ dispose: () => void }> } {
  return { subscriptions: [] };
}

suite('activateAgentBridge', () => {
  let tmpDir: string;

  suiteSetup(() => {
    tmpDir = path.join(os.tmpdir(), `p7b4-test-${Date.now()}`);
  });

  teardown(() => {
    resetVscodeTestState();
  });

  // ─── Case 1: С workspaceFolder ──────────────────────────────────────────────
  test('возвращает AgentBridge и добавляет dispose в subscriptions когда workspaceFolder задан', async () => {
    const ctx = makeContext();

    const bridge = activateAgentBridge(ctx as unknown as import('vscode').ExtensionContext, tmpDir);

    assert.ok(bridge !== undefined, 'должен вернуть инстанс AgentBridge');
    assert.strictEqual(ctx.subscriptions.length, 1, 'должен добавить один dispose в subscriptions');

    // Дождёмся start() — bridge асинхронный, даём время
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Останавливаем чтобы не оставлять открытые порты
    await bridge.stop();
  });

  // ─── Case 2: Без workspaceFolder ────────────────────────────────────────────
  test('возвращает undefined и не трогает subscriptions если workspaceFolder отсутствует', () => {
    const ctx = makeContext();

    const result = activateAgentBridge(ctx as unknown as import('vscode').ExtensionContext, undefined);

    assert.strictEqual(result, undefined, 'должен вернуть undefined');
    assert.strictEqual(ctx.subscriptions.length, 0, 'subscriptions должны остаться пустыми');
  });

  // ─── Case 3: start() reject → showWarningMessage ────────────────────────────
  test('при ошибке start() показывает showWarningMessage и не пробрасывает ошибку', async () => {
    const ctx = makeContext();

    // Передаём невалидный путь чтобы вызвать ошибку при записи bridge file.
    // Используем null byte в пути — это гарантированно вызывает ENOENT/EINVAL на всех ОС.
    // Но нам нужна ошибка от AgentBridge.start(). Проще подменить прототип временно.
    const originalStart = AgentBridge.prototype.start;
    AgentBridge.prototype.start = async function () {
      throw new Error('test-start-failure');
    };

    let bridge: import('../../src/agent/agentBridge').AgentBridge | undefined;
    try {
      bridge = activateAgentBridge(ctx as unknown as import('vscode').ExtensionContext, tmpDir);
      assert.ok(bridge !== undefined, 'должен вернуть инстанс даже при будущем reject');
      assert.strictEqual(ctx.subscriptions.length, 1, 'dispose должен быть зарегистрирован');

      // Дождёмся отклонённого промиса
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      assert.ok(
        vscodeTestState.warningLog.some((m) => m.includes('test-start-failure')),
        `showWarningMessage должен содержать сообщение об ошибке. warningLog: ${JSON.stringify(vscodeTestState.warningLog)}`,
      );
    } finally {
      AgentBridge.prototype.start = originalStart;
      // bridge уже не стартовал, stop безопасен
      if (bridge) {
        await bridge.stop().catch(() => undefined);
      }
    }
  });

  // ─── Case 4: dispose вызывает bridge.stop() ──────────────────────────────────
  test('dispose из subscriptions вызывает bridge.stop()', async () => {
    const ctx = makeContext();

    const bridge = activateAgentBridge(ctx as unknown as import('vscode').ExtensionContext, tmpDir);
    assert.ok(bridge, 'bridge должен быть создан');

    // Дождёмся старта
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Подменяем stop чтобы проверить вызов
    let stopCalled = false;
    const originalStop = bridge.stop.bind(bridge);
    bridge.stop = async () => {
      stopCalled = true;
      return originalStop();
    };

    // Вызываем dispose
    assert.strictEqual(ctx.subscriptions.length, 1);
    ctx.subscriptions[0].dispose();

    // Даём void promise разрешиться
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.ok(stopCalled, 'bridge.stop() должен быть вызван при dispose');
  });
});
