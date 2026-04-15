import type { TreeNode } from '../models/treeNode';

// ── Strategy-specific types ──────────────────────────────────────────────────

/** Describes one per-item setting column rendered in the composition editor table. */
export interface ItemSettingSchema {
  key: string;
  label: string;
  options: readonly string[];
  defaultValue: string;
}

/** ref → { settingKey → value } */
export type ItemSettingsMap = Map<string, Record<string, string>>;

export interface ContentReadResult {
  refs: string[];
  itemSettings: ItemSettingsMap;
}

export interface ContentUpdateDiff {
  add: string[];
  remove: string[];
  settingsChanged: Map<string, Record<string, string>>;
}

/**
 * Pluggable strategy that drives the generic CompositionEditor for a specific
 * entity type (subsystem, role package, etc.).  One strategy instance is created
 * per panel and is injected into the provider/webview infrastructure.
 */
export interface CompositionStrategy {
  panelTypeId: string;
  titlePrefix: string;
  eligibleTypes: ReadonlySet<string>;
  /** Column definitions for per-item settings; empty array = no extra columns. */
  itemSettingsSchema: readonly ItemSettingSchema[];

  getContentFilePath(node: TreeNode): string;
  readContent(filePath: string): Promise<ContentReadResult>;
  applyUpdate(
    filePath: string,
    diff: ContentUpdateDiff
  ): Promise<{ rejected: Array<{ ref: string; reason: string }> }>;

  /** Return node IDs that must be excluded from the object picker tree. */
  getExcludedNodeIds?(node: TreeNode, rootNodes: readonly TreeNode[]): Set<string>;
  /** When true the tree shows nested subsystems instead of collapsing them. Default false. */
  showNestedSubsystems?: boolean;
}

// ── Re-exported shared types (new code imports from here) ────────────────────

export interface CompositionTypeContainer {
  typeFolderId: string;
  metadataType: string;
  displayName: string;
  objectCount: number | null;
  checkedCount: number;
}

export interface CompositionObjectEntry {
  ref: string;
  displayName: string;
  type: string;
  orphan?: boolean;
}

export interface CompositionInitPayload {
  /** Display title prefix, e.g. "Состав подсистемы" */
  titlePrefix: string;
  /** Display name of the entity being edited (subsystem, exchange plan, etc.). */
  entityName: string;
  containers: CompositionTypeContainer[];
  checkedRefs: string[];
  itemSettingsSchema: readonly ItemSettingSchema[];
  itemSettings: Record<string, Record<string, string>>;
}

// ── Webview → Extension ──────────────────────────────────────────────────────

export type CompositionWebviewMessage =
  | { command: 'toggle'; data: { ref: string; checked: boolean } }
  | { command: 'save' }
  | { command: 'cancel' }
  | { command: 'selectAll'; data: { refs: string[] } }
  | { command: 'deselectAll'; data: { refs: string[] } }
  | { command: 'expand'; data: { typeFolderId: string } }
  | { command: 'expandAll' }
  | { command: 'settingChange'; data: { ref: string; key: string; value: string } };

// ── Extension → Webview ──────────────────────────────────────────────────────

export type CompositionHostMessage =
  | { command: 'init'; data: CompositionInitPayload }
  | { command: 'saveSuccess' }
  | { command: 'saveError'; data: { message: string } }
  | { command: 'error'; data: { message: string } }
  | { command: 'objectsLoaded'; data: ObjectsLoadedPayload }
  | { command: 'allObjectsLoaded'; data: AllObjectsLoadedPayload };

export interface ObjectsLoadedPayload {
  typeFolderId: string;
  objects: CompositionObjectEntry[];
}

export interface AllObjectsLoadedPayload {
  containers: Record<string, CompositionObjectEntry[]>;
}
