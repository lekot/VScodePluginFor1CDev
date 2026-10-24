import type { FormAttribute, FormChildItem, FormCommand, FormModel } from '../formModel';

export interface AddElementWizardOption {
  tag: string;
  defaultName?: string;
  hint?: string;
}

export interface AddElementWizardConfig {
  options: AddElementWizardOption[];
}

export interface FormBrowserState {
  formModel: FormModel | null;
  selectedIds: string[];
  anchorId: string | null;
  clipboardBuffer: FormChildItem | FormChildItem[] | null;
  selectedAttributeId: string | null;
  selectedCommandId: string | null;
  formXmlPath: string;
  modulePath: string;
  expandedIds: Set<string>;
  activePageIdByPagesKey: Record<string, string>;
  requisiteExpandedPaths: Set<string>;
  selectedRequisiteFullPath: string | null;
  addElementWizardConfig: AddElementWizardConfig;
}

export type FormOutboundMessage =
  | { type: 'load' }
  | { type: 'save'; formModel: FormModel | null }
  | { type: 'cancel' }
  | { type: 'selectElement'; elementId?: string; selectedIds: string[]; ctrlKey?: boolean; shiftKey?: boolean }
  | { type: 'dragDrop'; sourceId: string; targetId: string; index: number; source?: 'preview' }
  | { type: 'addElement'; parentId?: string; tag: string; name: string }
  | { type: 'addElementWizard'; parentId?: string; tag: string; name: string }
  | { type: 'addElementFromRequisite'; requisiteName: string; dataPath: string; targetId: string; index: number; source?: 'preview' }
  | { type: 'deleteElement'; elementId?: string; elementIds?: string[] }
  | { type: 'moveElementSibling'; elementId: string; direction: 'up' | 'down' }
  | { type: 'pasteElement'; targetId: string; index: number; clipboard: FormChildItem | FormChildItem[] }
  | { type: 'propertyChange'; elementId?: string; elementIds?: string[]; section?: 'attributes' | 'commands' | 'events'; key?: string; value: unknown }
  | { type: 'addAttribute' }
  | { type: 'deleteAttribute'; attributeId: string; attributeName: string }
  | { type: 'addCommand' }
  | { type: 'deleteCommand'; commandId: string; commandName: string }
  | { type: 'openModule'; procedureName?: string };

export type FormInboundMessage =
  | { type: 'hostColorTheme'; kind: unknown }
  | {
      type: 'formData';
      formModel: unknown;
      formXmlPath?: unknown;
      modulePath?: unknown;
      addElementWizardConfig?: unknown;
      fileMissing?: unknown;
      fileMissingTitle?: unknown;
      fileMissingHint?: unknown;
    }
  | { type: 'error'; message?: unknown }
  | { type: 'saved' }
  | { type: 'procedures'; procedures?: unknown };

export interface FormAttributeView extends FormAttribute {
  usage?: string;
  fromTree?: boolean;
}

export interface FormCommandView extends FormCommand {
  fromTree?: boolean;
}

export interface RequisiteTreeNode {
  pathSegment: string;
  fullPath: string;
  children: RequisiteTreeNode[];
  formElementIds: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
