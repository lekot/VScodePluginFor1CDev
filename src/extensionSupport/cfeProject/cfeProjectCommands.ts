import * as vscode from 'vscode';
import { getSelectedNode } from '../../helpers/commandHelpers';
import { MetadataType, type TreeNode } from '../../models/treeNode';
import type { ExtensionState } from '../../state/extensionState';
import type { WorkspaceRegistry } from '../../services/configurationSession/WorkspaceRegistry';
import { CfeProjectServiceFactory } from '.';

export interface RegisterCfeProjectCommandsOptions {
  readonly context: vscode.ExtensionContext;
  readonly state: ExtensionState;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry>;
  readonly refreshTree: () => Promise<void>;
}

/** VS Code adapter for creating a CFE from the selected base Configuration root. */
export function registerCfeProjectCommands(options: RegisterCfeProjectCommandsOptions): void {
  const command = vscode.commands.registerCommand(
    '1c-metadata-tree.cfe.createProject',
    async (node?: TreeNode) => {
      const selected = getSelectedNode(options.state, node);
      if (!isBaseConfigurationRoot(selected)) {
        void vscode.window.showWarningMessage('Выберите корневой узел основной конфигурации.');
        return;
      }
      try {
        const request = await promptCreateProject();
        if (!request) { return; }
        const root = options.state.treeDataProvider?.getConfigPathForNode(selected);
        if (!root) {
          throw new Error('Не удалось определить каталог выбранной конфигурации.');
        }
        const registry = await options.getConfigurationRegistry();
        const session = await registry.resolveResource(root);
        const service = new CfeProjectServiceFactory(registry, {
          refreshWorkspace: async () => { await options.getConfigurationRegistry(); },
        }).forConfiguration(session.identity.configurationId);
        const outcome = await service.createProject({ ...request, baseConfigurationId: session.identity.configurationId });
        await options.refreshTree();
        if (outcome.status === 'outcome-unknown') {
          void vscode.window.showWarningMessage('CFE-проект создан, но итог операции требует проверки восстановления.');
          return;
        }
        void vscode.window.showInformationMessage(`Создан CFE-проект «${request.extensionName}».`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Не удалось создать CFE-проект: ${message}`);
      }
    },
  );
  options.context.subscriptions.push(command);
}

function isBaseConfigurationRoot(node: TreeNode | undefined): node is TreeNode {
  return Boolean(node && node.type === MetadataType.Configuration && !node.parent && !node.properties.extensionPurpose);
}

async function promptCreateProject(): Promise<Omit<import('./types').CfeCreateProjectRequest, 'baseConfigurationId'> | undefined> {
  const extensionName = await vscode.window.showInputBox({
    prompt: 'Имя расширения конфигурации',
    placeHolder: 'МоёРасширение',
    ignoreFocusOut: true,
  });
  if (extensionName === undefined) { return undefined; }
  const purpose = await vscode.window.showQuickPick([
    { label: 'Доработка', value: 'Customization' as const },
    { label: 'Исправление', value: 'Patch' as const },
    { label: 'Дополнение', value: 'AddOn' as const },
  ], { placeHolder: 'Назначение расширения', ignoreFocusOut: true });
  if (!purpose) { return undefined; }
  const namePrefix = await vscode.window.showInputBox({
    prompt: 'Префикс имён объектов расширения',
    value: `${extensionName.trim()}_`,
    ignoreFocusOut: true,
  });
  if (namePrefix === undefined) { return undefined; }
  const compatibilityMode = await vscode.window.showQuickPick([
    { label: 'Не использовать режим совместимости', value: 'DontUse' },
    { label: 'Версия 8.3.24', value: 'Version8_3_24' },
    { label: 'Версия 8.3.27', value: 'Version8_3_27' },
  ], { placeHolder: 'Режим совместимости расширения', ignoreFocusOut: true });
  if (!compatibilityMode) { return undefined; }
  return { extensionName, purpose: purpose.value, namePrefix, compatibilityMode: compatibilityMode.value };
}
