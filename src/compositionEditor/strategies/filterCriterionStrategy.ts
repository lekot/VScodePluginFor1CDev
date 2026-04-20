import type { CompositionStrategy, ContentReadResult, ContentUpdateDiff } from '../compositionContracts';
import type { TreeNode } from '../../models/treeNode';
import { SUBSYSTEM_ELIGIBLE_TYPES } from '../compositionObjectCollector';
import {
  readFilterCriterionContent,
  applyFilterCriterionContentUpdate,
} from '../../services/filterCriterionContentFileUpdater';

export const FilterCriterionStrategy: CompositionStrategy = {
  panelTypeId: '1c-filter-criterion-content',
  titlePrefix: 'Состав критерия отбора',
  eligibleTypes: SUBSYSTEM_ELIGIBLE_TYPES,
  itemSettingsSchema: [],
  showNestedSubsystems: false,

  getContentFilePath(node: TreeNode): string {
    return node.filePath!;
  },

  async readContent(filePath: string): Promise<ContentReadResult> {
    return readFilterCriterionContent(filePath);
  },

  async applyUpdate(filePath: string, diff: ContentUpdateDiff) {
    return applyFilterCriterionContentUpdate(filePath, diff);
  },
};
