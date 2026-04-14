import type { CompositionStrategy, ContentReadResult, ContentUpdateDiff } from '../compositionContracts';
import type { TreeNode } from '../../models/treeNode';
import { SUBSYSTEM_ELIGIBLE_TYPES } from '../compositionObjectCollector';
import {
  readFunctionalOptionContent,
  applyFunctionalOptionContentUpdate,
} from '../../services/functionalOptionContentFileUpdater';

// FunctionalOption can include almost anything — use the same set as subsystems
export const FunctionalOptionStrategy: CompositionStrategy = {
  panelTypeId: '1c-functional-option-content',
  titlePrefix: 'Состав функциональной опции',
  eligibleTypes: SUBSYSTEM_ELIGIBLE_TYPES,
  itemSettingsSchema: [],
  showNestedSubsystems: true, // FunctionalOption can include Subsystems

  getContentFilePath(node: TreeNode): string {
    return node.filePath!;
  },

  async readContent(filePath: string): Promise<ContentReadResult> {
    return readFunctionalOptionContent(filePath);
  },

  async applyUpdate(filePath: string, diff: ContentUpdateDiff) {
    return applyFunctionalOptionContentUpdate(filePath, diff);
  },
};
