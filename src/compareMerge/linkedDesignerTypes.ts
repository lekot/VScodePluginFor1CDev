import type { MergeCandidate, MergeFileWitness } from './merge/mergePreview';
import type { CompareMessage, MetadataIdentity } from './domain/compareContracts';
import type { CompareSession } from './domain/compareSession';
import type { ConfigurationInventory } from './inventory/configurationInventory';
import type { ExecutableCandidateFactory } from './adapters/mergeAdapter';

export type LinkedDesignerKind = 'Form' | 'Template' | 'Command';

export interface LinkedDesignerPackageMember {
  readonly targetRelativePath: string;
  readonly sourceRelativePath?: string;
  readonly expectedTargetHash: string;
  readonly sourceHash?: string;
  readonly content?: Buffer;
  readonly required: boolean;
}

export interface LinkedDesignerPackageRecipe {
  readonly packageId: string;
  readonly action: 'copy' | 'delete';
  readonly kind: LinkedDesignerKind;
  readonly qualifiedName: string;
  readonly ownerQualifiedName?: string;
  readonly ownerTargetRelativePath?: string;
  readonly rootRegistration?: { readonly rootTag: string; readonly objectName: string };
  registrationNodeId?: string;
  readonly targetDirectoryWitness?: MergeFileWitness;
  readonly ownerDescriptorSnapshot?: LinkedOwnerDescriptorSnapshot;
  readonly members: readonly LinkedDesignerPackageMember[];
}

/** Compare-time capture for an explicitly selected matched TemplateType/body transition. */
export interface LinkedTemplateTypeTransition {
  readonly transitionId: string;
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly qualifiedName: string;
  readonly uuid: string;
  readonly targetSourceId: string;
  readonly sourceId: string;
  readonly targetDescriptorRelativePath: string;
  readonly targetDescriptorHash: string;
  readonly sourceDescriptorRelativePath: string;
  readonly sourceDescriptorHash: string;
  readonly targetTemplateType: string;
  readonly incomingTemplateType: string;
  readonly oldTargetBodyRelativePath: string;
  readonly oldTargetBodyHash: string;
  readonly incomingSourceBodyRelativePath: string;
  readonly incomingSourceBodyHash: string;
  readonly incomingSourceBodyContent: Buffer;
  readonly incomingTargetBodyRelativePath: string;
  readonly incomingTargetBodyExpectedHash: string;
}

/** A visible bundle node, or a scoped read-only blocker when required captures are unavailable. */
export interface LinkedTemplateTypeTransitionCandidate {
  readonly transitionId: string;
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly qualifiedName: string;
  readonly targetDescriptorRelativePath: string;
  readonly sourceDescriptorRelativePath?: string;
  readonly targetTemplateType?: string;
  readonly incomingTemplateType?: string;
  readonly targetBodyRelativePaths: readonly string[];
  readonly transition?: LinkedTemplateTypeTransition;
  readonly reason?: string;
}

export interface LinkedTemplateTypeTransitionBinding {
  readonly nodeId: string;
  readonly templateTypeNodeId: string;
  readonly transition: LinkedTemplateTypeTransition;
}

export interface LinkedOwnerDescriptorSnapshot {
  readonly targetRelativePath: string;
  readonly targetHash: string;
  readonly targetContent: string;
}

export interface LinkedDesignerFileWriteMember {
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
  readonly expectedTargetHash: string;
  readonly sourceHash: string;
  readonly content: Buffer;
}

export interface LinkedFormModuleSnapshot {
  readonly moduleId: string;
  readonly targetRelativePath: string;
  readonly sourceRelativePath?: string;
  readonly targetHash?: string;
  readonly sourceHash?: string;
  readonly targetContent?: string;
  readonly sourceContent?: string;
  readonly targetMissing?: true;
  readonly routineCandidateIds: ReadonlyMap<string, string>;
}

export interface LinkedFormXmlSnapshot {
  readonly targetRelativePath: string;
  readonly targetHash: string;
  readonly targetContent: string;
  readonly moduleId: string;
  readonly qualifiedName: string;
}

export interface LinkedFormReferenceOwnerSnapshot {
  readonly metadataType: string;
  readonly qualifiedName: string;
  readonly targetRelativePath: string;
  readonly targetHash: string;
  readonly targetContent: string;
}

export interface LinkedDefaultFormDependency {
  readonly targetFormComplete: boolean;
  readonly packageId?: string;
  readonly targetWitnesses?: readonly MergeFileWitness[];
}

export interface LinkedDesignerRootConfigurationSnapshot {
  readonly targetHash: string;
  readonly targetContent: Buffer;
  readonly sourceHash?: string;
  readonly sourceContent?: Buffer;
  readonly sourceHasRegistrations: ReadonlySet<string>;
  readonly targetHasRegistrations: ReadonlySet<string>;
}

export interface LinkedDesignerCompareIndex {
  readonly packages: readonly LinkedDesignerPackageRecipe[];
  readonly diagnostics: readonly CompareMessage[];
  /** Legacy whole-object candidates disabled because their linked package could not be proven. */
  readonly blockedPresenceNodeIds?: ReadonlyMap<string, string>;
  readonly rootConfiguration?: LinkedDesignerRootConfigurationSnapshot;
  readonly templateTypeTransitions?: readonly LinkedTemplateTypeTransitionCandidate[];
}

export interface LinkedDesignerMaterializerContext {
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly targetSourceId: string;
  readonly sourceId: string;
  readonly rightSnapshotId: string;
  readonly session: CompareSession;
  readonly candidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
  readonly packagesByNodeId: ReadonlyMap<string, LinkedDesignerPackageRecipe>;
  readonly fileWritesByNodeId?: ReadonlyMap<string, LinkedDesignerFileWriteMember>;
  readonly rootConfiguration?: LinkedDesignerRootConfigurationSnapshot;
  readonly formModules?: readonly LinkedFormModuleSnapshot[];
  readonly modulesByTargetPath?: ReadonlyMap<string, LinkedFormModuleSnapshot>;
  readonly formXmlSnapshots?: readonly LinkedFormXmlSnapshot[];
  readonly formXmlSnapshotIssues?: readonly string[];
  readonly formReferenceOwnerSnapshots?: readonly LinkedFormReferenceOwnerSnapshot[];
  readonly formReferenceOwnerSnapshotIssues?: readonly string[];
  readonly formXmlModuleByTargetPath?: ReadonlyMap<string, string>;
  readonly eventRoutineDependencies?: ReadonlyMap<string, LinkedEventDependency>;
  readonly defaultFormDependencies?: ReadonlyMap<string, LinkedDefaultFormDependency>;
  readonly expectedFormModuleHashes?: ReadonlyMap<string, string>;
  readonly templateTypeTransitionsByNodeId?: ReadonlyMap<string, LinkedTemplateTypeTransitionBinding>;
}

export type LinkedDesignerMaterializationResult =
  | { readonly ok: true; readonly candidates: readonly MergeCandidate[] }
  | { readonly ok: false; readonly diagnostics: CompareMessage[] };

export interface LinkedDesignerMaterializationContext {
  readonly sourceId: string;
  readonly targetSourceId: string;
  readonly targetRootPath: string;
  readonly rightSnapshotId: string;
  readonly rootConfiguration?: LinkedDesignerRootConfigurationSnapshot;
}

export interface CapturedSourceMember {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
  readonly sourceHash: string;
  readonly expectedTargetHash: string;
  readonly content: Buffer;
  readonly required: boolean;
}

export interface IndexedPackageObject {
  readonly identity: MetadataIdentity;
  readonly object: import('./inventory/configurationInventory').MetadataObjectUnit;
  readonly inventory: ConfigurationInventory;
}

export type LinkedWriteResult = { readonly candidates: MergeCandidate[] } | { readonly diagnostic: CompareMessage };

export type LinkedWriteCandidateInput = {
  readonly nodeId: string;
  readonly targetRelativePath: string;
  readonly expectedTargetHash: string;
  readonly sourceRelativePath: string;
  readonly sourceHash: string;
  readonly content: Buffer;
};

export type LinkedOutputCandidateInput = {
  readonly nodeId: string;
  readonly targetRelativePath: string;
  readonly expectedTargetHash: string;
  readonly content: Buffer;
  readonly witnesses: readonly MergeFileWitness[];
};

export type LinkedXmlCompositionResult =
  | { readonly candidates: MergeCandidate[]; readonly outputs: ReadonlyMap<string, string> }
  | { readonly diagnostics: CompareMessage[] };

export type LinkedBslCompositionResult =
  | { readonly candidates: MergeCandidate[]; readonly outputs: ReadonlyMap<string, string> }
  | { readonly diagnostics: CompareMessage[] };

export interface LinkedDesignerBindingInput {
  readonly results: readonly import('./adapters/mergeAdapter').AdapterCompareResult[];
  readonly packages: readonly LinkedDesignerPackageRecipe[];
}

export interface LinkedDesignerBindingResult {
  readonly packagesByNodeId: ReadonlyMap<string, LinkedDesignerPackageRecipe>;
  readonly results: readonly import('./adapters/mergeAdapter').AdapterCompareResult[];
}

export interface LinkedEventDependency {
  readonly moduleId: string;
  readonly handlerName: string;
  readonly targetHasHandler: boolean;
  readonly incomingRoutineNodeId?: string;
  readonly targetWitnesses?: readonly MergeFileWitness[];
}

export interface LinkedDefaultFormValidationInput {
  readonly packages: ReadonlyMap<string, LinkedDesignerPackageRecipe>;
  readonly selectedCandidates: readonly MergeCandidate[];
}

export interface LinkedEventValidationInput {
  readonly nodeIds: readonly string[];
  readonly finalBslOutputs: ReadonlyMap<string, string>;
}
