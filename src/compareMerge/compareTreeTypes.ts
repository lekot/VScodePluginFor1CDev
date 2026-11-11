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

export interface CompareTreeIdentityPresentation {
  side: 'left' | 'right';
  qualifiedName: string;
  uuid?: string;
  filePath?: string;
  ownership?: 'own' | 'adopted';
  sourceUuid?: string;
}

/** Optional display hints. They never participate in candidate IDs or merge validation. */
export interface CompareTreeNodePresentation {
  ownerKey?: string;
  ownerAliases?: string[];
  metadataType?: string;
  moduleKind?: string;
  qualifiedName?: string;
  identityConflict?: boolean;
  ambiguousIdentitySet?: boolean;
  identities?: CompareTreeIdentityPresentation[];
}

export interface CompareTreeNode {
  id: string;
  label: string;
  kind: string;
  status: CompareTreeStatus;
  leftValue?: string;
  rightValue?: string;
  mergeable?: boolean;
  destructive?: boolean;
  payloadRef?: string;
  conflict?: CompareTreeConflict;
  mergeState?: CompareTreeMergeState;
  presentation?: CompareTreeNodePresentation;
  children: CompareTreeNode[];
}

export interface CompareTreeStats {
  total: number;
  different: number;
  mergeable: number;
}
