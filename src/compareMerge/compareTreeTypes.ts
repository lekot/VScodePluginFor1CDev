export type CompareTreeStatus = 'equal' | 'changed' | 'leftOnly' | 'rightOnly';

export type CompareTreeMergeStateKind = 'ready' | 'blocked' | 'identityConflict' | 'readOnly';

export interface CompareTreeMergeState {
  state: CompareTreeMergeStateKind;
  reason?: string;
  targetFilePath?: string;
}

export interface CompareTreeConflict {
  kind: string;
  blocking: boolean;
  message: string;
}

export interface CompareTreeNode {
  id: string;
  label: string;
  kind: string;
  status: CompareTreeStatus;
  leftValue?: string;
  rightValue?: string;
  mergeable?: boolean;
  payloadRef?: string;
  conflict?: CompareTreeConflict;
  mergeState?: CompareTreeMergeState;
  children: CompareTreeNode[];
}

export interface CompareTreeStats {
  total: number;
  different: number;
  mergeable: number;
}
