import * as vscode from 'vscode';
import { InfobaseTreeDataProvider, type InfobaseTreeNode } from '../infobases/infobaseTreeProvider';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { PropertiesProvider } from '../providers/propertiesProvider';
import { TypeEditorProvider } from '../providers/typeEditorProvider';
import { RolesRightsEditorProvider } from '../rolesEditor/rolesRightsEditorProvider';
import { FormEditorProvider } from '../formEditor/formEditorProvider';
import { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import { MetadataWatcherService } from '../services/metadataWatcherService';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import { TreeNode } from '../models/treeNode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseManager } from '../infobases/infobaseManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';

/**
 * Holds extension-wide mutable references (providers, tree view, reload coordinator).
 * Replaces module-level `let` globals in extension.ts (refactor step 5.3.1).
 */
export class ExtensionState {
  treeDataProvider: MetadataTreeDataProvider | null = null;
  treeView: vscode.TreeView<TreeNode> | null = null;
  propertiesProvider: PropertiesProvider | null = null;
  typeEditorProvider: TypeEditorProvider | null = null;
  rolesRightsEditorProvider: RolesRightsEditorProvider | null = null;
  formEditorProvider: FormEditorProvider | null = null;
  mxlPreviewProvider: MxlPreviewProvider | null = null;
  extensionContext: vscode.ExtensionContext | undefined;
  metadataWatchers: MetadataWatcherService[] = [];
  reloadCoordinator: ReloadCoordinatorService | null = null;
  infobaseStorage: InfobaseStorageService | null = null;
  bindingManager: BindingManager | null = null;
  infobaseManager: InfobaseManager | null = null;
  infobaseTreeProvider: InfobaseTreeDataProvider | null = null;
  infobaseTreeView: vscode.TreeView<InfobaseTreeNode> | null = null;
  /** Обновление бейджей/tooltip привязок на узле Configuration (§2C); выставляется в extensionWorkspaceSetup. */
  refreshBindingTreeDecorations: (() => Promise<void>) | null = null;

  init(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
    this.infobaseStorage = new InfobaseStorageService(context.globalState, context.secrets);
    this.bindingManager = new BindingManager();
    this.infobaseManager = new InfobaseManager(this.infobaseStorage, this.bindingManager);
  }

  dispose(): void {
    for (const w of this.metadataWatchers) {
      w.dispose();
    }
    this.metadataWatchers = [];
    this.reloadCoordinator?.dispose();
    this.reloadCoordinator = null;
    this.infobaseTreeProvider = null;
    this.infobaseTreeView = null;
    this.refreshBindingTreeDecorations = null;
    this.infobaseStorage?.dispose();
    this.infobaseStorage = null;
    this.bindingManager = null;
    this.infobaseManager = null;
  }
}
