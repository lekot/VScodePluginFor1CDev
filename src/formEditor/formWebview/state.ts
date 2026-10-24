import type { FormBrowserState } from './contracts';

export function createFormBrowserState(): FormBrowserState {
  return {
    formModel: null,
    selectedIds: [],
    anchorId: null,
    clipboardBuffer: null,
    selectedAttributeId: null,
    selectedCommandId: null,
    formXmlPath: '',
    modulePath: '',
    expandedIds: new Set<string>(),
    activePageIdByPagesKey: Object.create(null) as Record<string, string>,
    requisiteExpandedPaths: new Set<string>(),
    selectedRequisiteFullPath: null,
    addElementWizardConfig: { options: [] },
  };
}
