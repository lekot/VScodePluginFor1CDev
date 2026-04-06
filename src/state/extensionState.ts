import * as vscode from 'vscode';
import { InfobaseTreeDataProvider, type InfobaseTreeNode } from '../infobases/infobaseTreeProvider';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { PropertiesProvider } from '../providers/propertiesProvider';
import { TypeEditorProvider } from '../providers/typeEditorProvider';
import { RolesRightsEditorProvider } from '../rolesEditor/rolesRightsEditorProvider';
import type { SubsystemCompositionEditorProvider } from '../subsystemCompositionEditor/subsystemCompositionEditorProvider';
import { FormEditorProvider } from '../formEditor/formEditorProvider';
import { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import { MetadataWatcherService } from '../services/metadataWatcherService';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import { TreeNode } from '../models/treeNode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseManager } from '../infobases/infobaseManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { resetIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';

/**
 * Holds extension-wide mutable references (providers, tree view, reload coordinator).
 * Replaces module-level `let` globals in extension.ts (refactor step 5.3.1).
 */
export class ExtensionState {
  private _treeDataProvider: MetadataTreeDataProvider | null = null;
  private _treeView: vscode.TreeView<TreeNode> | null = null;
  private _propertiesProvider: PropertiesProvider | null = null;
  private _typeEditorProvider: TypeEditorProvider | null = null;
  private _rolesRightsEditorProvider: RolesRightsEditorProvider | null = null;
  private _subsystemCompositionEditorProvider: SubsystemCompositionEditorProvider | null = null;
  private _formEditorProvider: FormEditorProvider | null = null;
  private _mxlPreviewProvider: MxlPreviewProvider | null = null;
  private _extensionContext: vscode.ExtensionContext | undefined;
  private _metadataWatchers: MetadataWatcherService[] = [];
  private _reloadCoordinator: ReloadCoordinatorService | null = null;
  private _infobaseStorage: InfobaseStorageService | null = null;
  private _bindingManager: BindingManager | null = null;
  private _infobaseManager: InfobaseManager | null = null;
  private _infobaseTreeProvider: InfobaseTreeDataProvider | null = null;
  private _infobaseTreeView: vscode.TreeView<InfobaseTreeNode> | null = null;
  private _refreshBindingTreeDecorations: (() => Promise<void>) | null = null;

  // ── Getters ───────────────────────────────────────────────────────────────

  get treeDataProvider(): MetadataTreeDataProvider | null { return this._treeDataProvider; }
  get treeView(): vscode.TreeView<TreeNode> | null { return this._treeView; }
  get propertiesProvider(): PropertiesProvider | null { return this._propertiesProvider; }
  get typeEditorProvider(): TypeEditorProvider | null { return this._typeEditorProvider; }
  get rolesRightsEditorProvider(): RolesRightsEditorProvider | null { return this._rolesRightsEditorProvider; }
  get subsystemCompositionEditorProvider(): SubsystemCompositionEditorProvider | null { return this._subsystemCompositionEditorProvider; }
  get formEditorProvider(): FormEditorProvider | null { return this._formEditorProvider; }
  get mxlPreviewProvider(): MxlPreviewProvider | null { return this._mxlPreviewProvider; }
  get extensionContext(): vscode.ExtensionContext | undefined { return this._extensionContext; }
  get metadataWatchers(): MetadataWatcherService[] { return this._metadataWatchers; }
  get reloadCoordinator(): ReloadCoordinatorService | null { return this._reloadCoordinator; }
  get infobaseStorage(): InfobaseStorageService | null { return this._infobaseStorage; }
  get bindingManager(): BindingManager | null { return this._bindingManager; }
  get infobaseManager(): InfobaseManager | null { return this._infobaseManager; }
  get infobaseTreeProvider(): InfobaseTreeDataProvider | null { return this._infobaseTreeProvider; }
  get infobaseTreeView(): vscode.TreeView<InfobaseTreeNode> | null { return this._infobaseTreeView; }
  /** Обновление бейджей/tooltip привязок на узле Configuration (§2C); выставляется в extensionWorkspaceSetup. */
  get refreshBindingTreeDecorations(): (() => Promise<void>) | null { return this._refreshBindingTreeDecorations; }

  // ── Setters ───────────────────────────────────────────────────────────────

  set treeDataProvider(v: MetadataTreeDataProvider | null) { this._treeDataProvider = v; }
  set treeView(v: vscode.TreeView<TreeNode> | null) { this._treeView = v; }
  set propertiesProvider(v: PropertiesProvider | null) { this._propertiesProvider = v; }
  set typeEditorProvider(v: TypeEditorProvider | null) { this._typeEditorProvider = v; }
  set rolesRightsEditorProvider(v: RolesRightsEditorProvider | null) { this._rolesRightsEditorProvider = v; }
  set subsystemCompositionEditorProvider(v: SubsystemCompositionEditorProvider | null) { this._subsystemCompositionEditorProvider = v; }
  set formEditorProvider(v: FormEditorProvider | null) { this._formEditorProvider = v; }
  set mxlPreviewProvider(v: MxlPreviewProvider | null) { this._mxlPreviewProvider = v; }
  set metadataWatchers(v: MetadataWatcherService[]) { this._metadataWatchers = v; }
  set reloadCoordinator(v: ReloadCoordinatorService | null) { this._reloadCoordinator = v; }
  set infobaseTreeProvider(v: InfobaseTreeDataProvider | null) { this._infobaseTreeProvider = v; }
  set infobaseTreeView(v: vscode.TreeView<InfobaseTreeNode> | null) { this._infobaseTreeView = v; }
  set refreshBindingTreeDecorations(v: (() => Promise<void>) | null) { this._refreshBindingTreeDecorations = v; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(context: vscode.ExtensionContext): void {
    this._extensionContext = context;
    this._infobaseStorage = new InfobaseStorageService(context.globalState, context.secrets);
    this._bindingManager = new BindingManager();
    this._infobaseManager = new InfobaseManager(this._infobaseStorage, this._bindingManager);
  }

  dispose(): void {
    for (const w of this._metadataWatchers) {
      w.dispose();
    }
    this._metadataWatchers = [];
    this._reloadCoordinator?.dispose();
    this._reloadCoordinator = null;
    this._subsystemCompositionEditorProvider?.dispose();
    this._subsystemCompositionEditorProvider = null;
    this._infobaseTreeProvider = null;
    this._infobaseTreeView = null;
    this._refreshBindingTreeDecorations = null;
    this._infobaseStorage?.dispose();
    this._infobaseStorage = null;
    this._bindingManager = null;
    this._infobaseManager = null;
    resetIbcmdService();
  }
}
