// src/agent/agentBridgeActivation.ts
// Helper для активации AgentBridge — вынесен для тестируемости (P7b-4).

import * as vscode from 'vscode';
import { AgentBridge } from './agentBridge';
import { Logger } from '../utils/logger';

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
  Logger.info('AgentBridge activation invoked', { workspaceFolder: workspaceFolder ?? '<undefined>' });
  if (!workspaceFolder) {
    Logger.warn('AgentBridge: workspaceFolder absent — bridge will NOT start');
    return undefined;
  }

  const version = context.extension?.packageJSON?.version as string | undefined ?? 'unknown';

  const bridge = new AgentBridge({
    commandPattern: /^1c-metadata-tree\.agent(\.debug|\.forms|\.skd|\.xdto)?\.[a-zA-Z]+$/,
    workspaceFolder,
    extensionVersion: version,
    extensionPath: context.extensionPath,
  });

  bridge.start().then(({ port }) => {
    Logger.info('AgentBridge started', { port, workspaceFolder });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    Logger.error('AgentBridge failed to start', { error: msg });
    void vscode.window.showWarningMessage(`CDT Agent Bridge не запустился: ${msg}`);
  });

  context.subscriptions.push({
    dispose: () => { void bridge.stop(); },
  });

  return bridge;
}
