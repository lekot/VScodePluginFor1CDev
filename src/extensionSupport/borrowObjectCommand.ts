import * as fs from 'fs';
import * as vscode from 'vscode';
import { getMetadataTypeDescriptorByType } from '../constants/metadataTypeDescriptors';
import type { TreeNode } from '../models/treeNode';
import type { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import type { ExtensionState } from '../state/extensionState';
import { CfeProjectServiceFactory, type CfeProjectContext } from './cfeProject';

export interface BorrowObjectToExtensionOptions {
  readonly state: ExtensionState;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry>;
  readonly refreshTree: () => Promise<void>;
}

interface ExtensionQuickPickItem extends vscode.QuickPickItem {
  readonly context: CfeProjectContext;
}

/**
 * UI adapter for the CFE borrow application operation. It deliberately does
 * not inspect or write XML: the service owns source resolution, canonical
 * shells, CAS and rollback.
 */
export async function borrowObjectToExtension(
  sourceNode: TreeNode,
  options: BorrowObjectToExtensionOptions,
): Promise<void> {
  const provider = options.state.treeDataProvider;
  if (!provider) {
    void vscode.window.showWarningMessage('Дерево метаданных не загружено.');
    return;
  }

  const sourceDotPath = toBorrowSourceDotPath(sourceNode);
  if (!sourceDotPath) {
    void vscode.window.showWarningMessage('Выберите корневой объект метаданных основной конфигурации.');
    return;
  }
  const sourceRoot = provider.getConfigPathForNode(sourceNode);
  if (!sourceRoot) {
    throw new Error('Не удалось определить конфигурацию выбранного объекта.');
  }

  const registry = await options.getConfigurationRegistry();
  const sourceSession = await resolveSourceSession(registry, sourceRoot);
  const service = new CfeProjectServiceFactory(registry, {
    refreshWorkspace: async () => { await options.getConfigurationRegistry(); },
  }).forConfiguration(sourceSession.identity.configurationId);
  const projects = (await service.listProjects()).filter(
    (context) => context.baseSession.identity.configurationId === sourceSession.identity.configurationId,
  );
  if (projects.length === 0) {
    void vscode.window.showWarningMessage('Для выбранной основной конфигурации нет связанного CFE-проекта. Сначала создайте расширение конфигурации.');
    return;
  }

  const picked = await vscode.window.showQuickPick<ExtensionQuickPickItem>(
    projects.map((context) => ({
      label: context.extensionName,
      description: context.purpose,
      detail: context.extensionSession.identity.configurationId,
      context,
    })),
    {
      placeHolder: 'Выберите связанное расширение для заимствования объекта',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) {
    return;
  }

  const outcome = await service.borrowObject({
    extensionConfigurationId: picked.context.extensionSession.identity.configurationId,
    sourceDotPath,
  });
  await options.refreshTree();
  const action = outcome.status === 'already-borrowed' ? 'уже заимствован' : 'заимствован';
  void vscode.window.showInformationMessage(
    `Объект «${outcome.type}.${outcome.name}» ${action} в расширение «${picked.context.extensionName}».`,
  );
}

function toBorrowSourceDotPath(node: TreeNode): string | undefined {
  const descriptor = getMetadataTypeDescriptorByType(node.type);
  return descriptor && node.name ? `${descriptor.designerRootTag}.${node.name}` : undefined;
}

/** Tree nodes can carry a Windows 8.3 path while registry roots are canonical. */
async function resolveSourceSession(registry: WorkspaceRegistry, sourceRoot: string) {
  try {
    return await registry.resolveResource(sourceRoot);
  } catch (originalError) {
    try {
      return await registry.resolveResource(await fs.promises.realpath(sourceRoot));
    } catch {
      throw originalError;
    }
  }
}
