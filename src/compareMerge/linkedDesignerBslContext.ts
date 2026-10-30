import type { BslModuleIndexEntry } from './bsl/bslModuleIndexer';
import type { ExecutableCandidateFactory } from './adapters/mergeAdapter';
import type { MatchResult } from './domain/compareContracts';
import type { ConfigurationInventory } from './inventory/configurationInventory';
import type { BslRoutineDiffProjectionInput } from './projection/compareTreeProjection';
import {
  attachFormHandlerReferenceWitnesses,
  buildLinkedModuleSnapshots,
} from './linkedDesignerContext';
import { projectMissingTargetFormModules } from './linkedDesignerMissingFormModule';
import type { LinkedDefaultFormDependency, LinkedDesignerRootConfigurationSnapshot, LinkedEventDependency, LinkedFormModuleSnapshot, LinkedFormXmlSnapshot } from './linkedDesignerTypes';

export interface LinkedDesignerBslContext {
  readonly modules: readonly LinkedFormModuleSnapshot[];
  readonly eventRoutineDependencies: Map<string, LinkedEventDependency>;
  readonly defaultFormDependencies: Map<string, LinkedDefaultFormDependency>;
}

/** Adds explicitly proven missing Form modules and pins BSL routines to their Form.xml snapshots. */
export async function prepareLinkedDesignerBslContext(input: {
  readonly metadata: MatchResult;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftModules: readonly BslModuleIndexEntry[];
  readonly rightModules: readonly BslModuleIndexEntry[];
  readonly leftSources: ReadonlyMap<string, string>;
  readonly rightSources: ReadonlyMap<string, string>;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly rightSnapshotId: string;
  readonly targetSourceId: string;
  readonly rootConfiguration?: LinkedDesignerRootConfigurationSnapshot;
  readonly formXmlSnapshots: readonly LinkedFormXmlSnapshot[];
  readonly bslItems: BslRoutineDiffProjectionInput[];
  readonly candidateFactories: Map<string, ExecutableCandidateFactory>;
}): Promise<LinkedDesignerBslContext> {
  const missingModules = await projectMissingTargetFormModules({
    metadata: input.metadata,
    leftInventory: input.leftInventory,
    rightInventory: input.rightInventory,
    leftModules: input.leftModules,
    rightModules: input.rightModules,
    leftRootPath: input.leftRootPath,
    rightRootPath: input.rightRootPath,
    rightSources: input.rightSources,
    rightSnapshotId: input.rightSnapshotId,
    rootConfiguration: input.rootConfiguration,
  });
  input.bslItems.push(...missingModules.items);
  missingModules.candidateFactories.forEach((factory, nodeId) => input.candidateFactories.set(nodeId, factory));

  const modules = [
    ...buildLinkedModuleSnapshots({
      leftModules: input.leftModules,
      rightModules: input.rightModules,
      leftSources: input.leftSources,
      rightSources: input.rightSources,
      leftRootPath: input.leftRootPath,
      rightRootPath: input.rightRootPath,
      leftInventory: input.leftInventory,
      rightInventory: input.rightInventory,
      routineCandidateFactories: input.candidateFactories,
    }),
    ...missingModules.modules,
  ];
  attachFormHandlerReferenceWitnesses({
    candidateFactories: input.candidateFactories,
    formXmlSnapshots: input.formXmlSnapshots,
    modules,
    targetSourceId: input.targetSourceId,
    targetRootPath: input.leftRootPath,
  });

  return {
    modules,
    eventRoutineDependencies: new Map(),
    defaultFormDependencies: new Map(),
  };
}
