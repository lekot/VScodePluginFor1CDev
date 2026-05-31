import type { CompareTreeNode } from '../compareTreeTypes';
import type {
  CompareMessage,
  MetadataIdentity,
  MetadataIdentityMatch,
} from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { MergeCandidate } from '../merge/mergePreview';

export type CompareJoinStrategy = 'left' | 'right' | 'full';

export type ArtifactKind =
  | 'metadataXml'
  | 'formXml'
  | 'predefinedXml'
  | 'bslModule'
  | 'objectFolder'
  | 'binaryOrOpaqueFile';

export interface ConfigurationInventory {
  rootPath: string;
  objects: MetadataObjectUnit[];
  artifactsByObjectId: ReadonlyMap<string, ArtifactUnit[]>;
}

export interface MetadataObjectUnit {
  objectId: string;
  qualifiedName: string;
  metadataType: string;
  uuid?: string;
  descriptorPath: string;
  containerPath: string;
}

export interface ArtifactUnit {
  artifactId: string;
  ownerObjectId?: string;
  kind: ArtifactKind;
  relativePath: string;
  filePath: string;
  contentHash: string;
  mergeMode: 'xmlPatch' | 'bslRoutine' | 'fileOperation';
}

export interface MetadataObjectMatch {
  left?: MetadataObjectUnit;
  right?: MetadataObjectUnit;
  identity?: MetadataIdentityMatch;
  leftIdentity?: MetadataIdentity;
  rightIdentity?: MetadataIdentity;
}

export interface XmlAddress {
  filePath: string;
  pointer: string;
  displayPath: string;
  identityKey?: string;
}

export interface XmlPatchPayload {
  kind: 'replaceNode' | 'insertNode' | 'deleteNode';
  target: XmlAddress;
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
}

export interface FileOperationPayload {
  kind: 'fileCopy' | 'fileDelete' | 'folderCopy' | 'folderDelete';
  sourcePath?: string;
  targetPath: string;
  expectedOldHash?: string;
  sourceHash?: string;
  destructive: boolean;
}

export interface MergeAdapter {
  kind: string;
  compare(input: AdapterCompareInput): Promise<AdapterCompareResult>;
}

export type ExecutableCandidateFactoryResult =
  | {
      ok: true;
      candidate: MergeCandidate;
    }
  | {
      ok: false;
      diagnostics: CompareMessage[];
    };

export type ExecutableCandidateFactory = () => Promise<ExecutableCandidateFactoryResult>;

export interface AdapterCompareInput {
  strategy: CompareJoinStrategy;
  leftInventory: ConfigurationInventory;
  rightInventory: ConfigurationInventory;
  match: MetadataObjectMatch;
  session: CompareSession;
  snapshots: { left: string; right: string };
}

export interface AdapterCompareResult {
  nodes: CompareTreeNode[];
  candidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
  diagnostics: CompareMessage[];
}
