import * as vscode from 'vscode';
import { FormatDetector, ConfigFormat } from '../parsers/formatDetector';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';

/** Resolve node from command argument or current tree selection. */
export function getSelectedNode(state: ExtensionState, node?: TreeNode): TreeNode | undefined {
  if (node) {
    return node;
  }
  return state.treeView?.selection?.[0];
}

export type RequireDesignerFormatOptions = {
  /** Shown when config path cannot be resolved for the node. */
  notLoadedMessage: string;
  /** Shown when configuration is not Designer XML layout. */
  nonDesignerMessage: string;
};

/**
 * Resolves config path for `target`, ensures Designer format; otherwise shows a message and returns null.
 */
export async function requireDesignerFormat(
  state: ExtensionState,
  target: TreeNode,
  options: RequireDesignerFormatOptions
): Promise<{ configPath: string; format: ConfigFormat } | null> {
  const configPath =
    state.treeDataProvider?.getConfigPathForNode(target) ?? state.treeDataProvider?.getConfigPath();
  if (!configPath) {
    void vscode.window.showWarningMessage(options.notLoadedMessage);
    return null;
  }
  const format = await FormatDetector.detect(configPath);
  if (format !== ConfigFormat.Designer) {
    void vscode.window.showInformationMessage(options.nonDesignerMessage);
    return null;
  }
  return { configPath, format };
}
