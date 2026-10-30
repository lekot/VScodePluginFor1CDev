import type { CompareTreeNode } from '../compareTreeTypes';
import type {
  CompareMessage,
  MetadataIdentity,
  MetadataIdentityMatch,
} from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { MergeCandidate, MergeFileWitness } from '../merge/mergePreview';
import type { XmlOrderScope } from '../xml/xmlPatchTypes';

export type CompareJoinStrategy = 'left' | 'right' | 'full';

export type ArtifactKind =
  | 'metadataXml'
  | 'formXml'
  | 'predefinedXml'
  | 'roleRightsXml'
  | 'dcsXml'
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
  kind: 'replaceNode' | 'insertNode' | 'deleteNode' | 'moveNode';
  target: XmlAddress;
  destinationParent?: XmlAddress;
  createDestinationChildItems?: true;
  createDestinationChildObjects?: true;
  createDestinationEvents?: true;
  orderScope?: XmlOrderScope;
  insertBefore?: XmlAddress;
  insertPosition?: 'append';
  insertOrder?: number;
  semanticKind?: 'metadataXml' | 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml';
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
  sourceWitnesses?: readonly MergeFileWitness[];
  semanticContext?: {
    availableFormReferences?: {
      attributes?: readonly string[];
      commands?: readonly string[];
      elements?: readonly string[];
    };
    availableMetadataReferences?: readonly string[];
    configurationName?: string;
    ownerDescriptorVersions?: { target: string; incoming: string };
  };
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
  /** Explicit host ownership decisions for raw/projected Designer order profiles. */
  allowMetadataChildOrder?: boolean;
  allowFormSectionOrder?: boolean;
  artifactPaths?: { left: string; right: string };
  /** Captured root-registered metadata references for semantic XML validation. */
  semanticValidationContext?: {
    availableFormReferences?: {
      attributes?: readonly string[];
      commands?: readonly string[];
      elements?: readonly string[];
    };
    availableMetadataReferences?: readonly string[];
    configurationName?: string;
    ownerDescriptorVersions?: { target: string; incoming: string };
  };
  /** Captured descriptor dependencies for metadata references outside the left inventory. */
  semanticMetadataReferenceWitnesses?: readonly {
    qualifiedName: string;
    witness: MergeFileWitness;
  }[];
  /** Captured dependencies for semanticValidationContext, including Configuration.xml. */
  semanticContextWitnesses?: readonly MergeFileWitness[];
  /** Validated package links for Designer form registrations, defaults, and event handlers. */
  linkedDesignerContext?: {
    registrations: readonly {
      kind: 'Form' | 'Template' | 'Command';
      name: string;
      packageId: string;
    }[];
    defaultObjectForms: readonly {
      propertyName: string;
      value: string;
      targetFormComplete: boolean;
      packageId?: string;
      targetWitnesses?: readonly MergeFileWitness[];
    }[];
    formEventHandlers: readonly {
      name: string;
      targetHasHandler: boolean;
      incomingRoutineNodeId?: string;
      targetWitnesses?: readonly MergeFileWitness[];
    }[];
  };
  snapshots: { left: string; right: string };
}

export interface AdapterCompareResult {
  nodes: CompareTreeNode[];
  candidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
  diagnostics: CompareMessage[];
}
