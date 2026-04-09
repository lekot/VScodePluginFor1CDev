// src/agent/agentBridgeActivation.ts
// Helper для активации AgentBridge — вынесен для тестируемости (P7b-4).

import * as vscode from 'vscode';
import { AgentBridge } from './agentBridge';

/**
 * Создаёт и стартует AgentBridge если задана папка workspace.
 * Регистрирует dispose в context.subscriptions.
 * Fire-and-forget: не блокирует активацию, ошибки логируются + показываются через showWarningMessage.
 *
 * @returns инстанс AgentBridge (start ещё в процессе) или undefined если workspaceFolder не задан.
 */
export function activateAgentBridge(
  context: vscode.ExtensionContext,
  workspaceFolder?: string,
): AgentBridge | undefined {
  if (!workspaceFolder) {
    return undefined;
  }

  const bridge = new AgentBridge({
    commandPattern: /^1c-metadata-tree\.agent(\.debug)?\.[a-zA-Z]+$/,
    workspaceFolder,
  });

  bridge.start().then(({ port }) => {
    console.log(`[CDT Agent Bridge] listening on 127.0.0.1:${port}`);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[CDT Agent Bridge] failed to start:', msg);
    void vscode.window.showWarningMessage(`CDT Agent Bridge не запустился: ${msg}`);
  });

  context.subscriptions.push({
    dispose: () => { void bridge.stop(); },
  });

  return bridge;
}
