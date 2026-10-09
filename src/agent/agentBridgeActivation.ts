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
export async function activateAgentBridge(
  context: vscode.ExtensionContext,
  workspaceFolder?: string | readonly string[],
): Promise<AgentBridge | undefined> {
  const folders = typeof workspaceFolder === 'string'
    ? (workspaceFolder.trim() ? [workspaceFolder] : [])
    : (workspaceFolder ? [...workspaceFolder].filter((f) => f && f.trim()) : []);

  Logger.info('AgentBridge activation invoked', { workspaceFolders: folders });
  if (folders.length === 0) {
    Logger.warn('AgentBridge: workspaceFolder absent — bridge will NOT start');
    return undefined;
  }

  const version = context.extension?.packageJSON?.version as string | undefined ?? 'unknown';

  const bridge = new AgentBridge({
    commandPattern: /^1c-metadata-tree\.agent(?:(?:\.debug|\.forms|\.skd|\.xdto)?\.[a-zA-Z]+|\.roles\.setRights)$/,
    workspaceFolder: folders[0],
    workspaceFolders: folders,
    extensionVersion: version,
    extensionPath: context.extensionPath,
  });

  try {
    const { port } = await bridge.start();
    Logger.info('AgentBridge started', { port, workspaceFolders: folders });
  } catch (err: unknown) {

    const msg = err instanceof Error ? err.message : String(err);
    Logger.error('AgentBridge failed to start', { error: msg });
    void vscode.window.showWarningMessage(`CDT Agent Bridge не запустился: ${msg}`);
    await bridge.stop();
    return undefined;
  }

  context.subscriptions.push({
    dispose: () => { void bridge.stop(); },
  });

  return bridge;
}
