import type { CompositionStrategy, ContentReadResult, ContentUpdateDiff } from '../compositionContracts';
import type { TreeNode } from '../../models/treeNode';
import { SUBSYSTEM_ELIGIBLE_TYPES, buildAncestorIds } from '../compositionObjectCollector';
import {
  readSubsystemCompositionRefsFromFile,
  applySubsystemCompositionFileUpdate,
} from '../../services/subsystemCompositionFileUpdater';

export const SubsystemStrategy: CompositionStrategy = {
  panelTypeId: '1c-subsystem-composition',
  titlePrefix: 'Состав подсистемы',
  eligibleTypes: SUBSYSTEM_ELIGIBLE_TYPES,
  itemSettingsSchema: [],
  showNestedSubsystems: true,

  getContentFilePath(node: TreeNode): string {
    return node.filePath!;
  },

  async readContent(filePath: string): Promise<ContentReadResult> {
    const refs = await readSubsystemCompositionRefsFromFile(filePath);
    return { refs, itemSettings: new Map() };
  },

  async applyUpdate(
    filePath: string,
    diff: ContentUpdateDiff,
  ): Promise<{ rejected: Array<{ ref: string; reason: string }> }> {
    const result = await applySubsystemCompositionFileUpdate(filePath, {
      add: diff.add,
      remove: diff.remove,
    });
    return { rejected: result.rejected };
  },

  getExcludedNodeIds(node: TreeNode, _rootNodes: readonly TreeNode[]): Set<string> {
    // Exclude ancestor subsystems from the tree (the subsystem itself is NOT excluded —
    // in 1C a subsystem can include itself in its own composition)
    return buildAncestorIds(node);
  },
};
