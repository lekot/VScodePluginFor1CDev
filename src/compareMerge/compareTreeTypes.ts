export type CompareTreeStatus = 'equal' | 'changed' | 'leftOnly' | 'rightOnly';

export interface CompareTreeNode {
  id: string;
  label: string;
  kind: string;
  status: CompareTreeStatus;
  leftValue?: string;
  rightValue?: string;
  mergeable?: boolean;
  children: CompareTreeNode[];
}

export interface CompareTreeStats {
  total: number;
  different: number;
  mergeable: number;
}
