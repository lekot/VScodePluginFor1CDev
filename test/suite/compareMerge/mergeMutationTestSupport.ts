import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { ConfigurationMutationEngine } from '../../../src/services/configurationSession/ConfigurationMutationEngine';
import { ConfigurationContextResolver } from '../../../src/services/configurationSession/ConfigurationContextResolver';
import { WorkspaceRegistry } from '../../../src/services/configurationSession/WorkspaceRegistry';
import { WorkspaceRegistryCoordinator } from '../../../src/services/configurationSession/WorkspaceRegistryCoordinator';
import { isPathInside } from '../../../src/services/configurationSession/pathBoundary';
import { ConfigFormat } from '../../../src/parsers/formatDetector';
import type { ConfigurationId } from '../../../src/services/configurationSession/types';
import type { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { PreflightResult } from '../../../src/compareMerge/merge/mergePlanner';
import {
  executeBslMergePreview,
  type MergeExecutorInput,
} from '../../../src/compareMerge/merge/mergeExecutor';

export interface MergeMutationTestRuntime {
  readonly engine: ConfigurationMutationEngine;
  readonly configurationId: ConfigurationId;
  readonly coordinator: WorkspaceRegistryCoordinator;
  readonly planRunnerCalls: () => number;
}

export async function createMergeMutationTestRuntime(
  rootPath: string,
): Promise<MergeMutationTestRuntime> {
  const canonicalRoot = await fs.realpath(rootPath);
  await ensureWritableConfigurationDescriptor(canonicalRoot);
  const workspaceRoot = path.dirname(canonicalRoot);
  const registry = new WorkspaceRegistry();
  const coordinator = new WorkspaceRegistryCoordinator(registry, {
    getWorkspaceFolders: () => [workspaceRoot],
    findAllConfigurationRoots: async () => [],
    findConfigurationRoot: async (candidatePath) =>
      isPathInside(canonicalRoot, candidatePath) ? canonicalRoot : null,
  });
  await coordinator.ensureInitialized();
  const configurationSession = await coordinator.registerTargetedRoot({
    configPath: canonicalRoot,
    workspaceFolderPath: workspaceRoot,
    format: ConfigFormat.Designer,
  });
  let planRunnerCallCount = 0;
  const engine = new ConfigurationMutationEngine({
    contextResolver: new ConfigurationContextResolver(coordinator),
    runMutation: async (resourcePath, kind, operation) => {
      const session = await coordinator.resolveResource(resourcePath);
      const outcome = await session.runExclusive({ kind, execute: operation });
      if (outcome.status === 'committed') {
        return outcome.value;
      }
      throw ('error' in outcome && outcome.error)
        ? outcome.error
        : new Error(`Configuration mutation ${kind} did not commit (${outcome.status}).`);
    },
    runPlan: async (resourcePath, plan) => {
      planRunnerCallCount += 1;
      const session = await coordinator.resolveResource(resourcePath);
      const outcome = await session.enqueuePlan(plan);
      if (outcome.status === 'committed') {
        return outcome.value;
      }
      throw ('error' in outcome && outcome.error)
        ? outcome.error
        : new Error(`Configuration plan ${plan.kind} did not commit (${outcome.status}).`);
    },
  });

  return {
    engine,
    configurationId: configurationSession.identity.configurationId,
    coordinator,
    planRunnerCalls: () => planRunnerCallCount,
  };
}

export async function executeMergeWithRuntime(
  session: CompareSession,
  preflight: PreflightResult,
): Promise<Awaited<ReturnType<typeof executeBslMergePreview>>> {
  return executeMergeInputWithRuntime({ session, preflight });
}

export async function executeMergeInputWithRuntime(
  input: MergeExecutorInput,
): Promise<Awaited<ReturnType<typeof executeBslMergePreview>>> {
  const { session } = input;
  const leftRootUri = session.state.sources.find((source) => source.side === 'left')?.rootUri;
  if (!leftRootUri) {
    throw new Error('Test compare session has no left root.');
  }
  const rootPath = leftRootUri.startsWith('file:') ? fileURLToPath(leftRootUri) : leftRootUri;
  const runtime = await createMergeMutationTestRuntime(rootPath);
  try {
    return await executeBslMergePreview({
      ...input,
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
    });
  } finally {
    await runtime.coordinator.dispose();
  }
}

async function ensureWritableConfigurationDescriptor(rootPath: string): Promise<void> {
  const descriptorPath = path.join(rootPath, 'Configuration.xml');
  try {
    await fs.access(descriptorPath);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await fs.writeFile(
      descriptorPath,
      '<MetaDataObject><Configuration uuid="00000000-0000-0000-0000-000000000001"/></MetaDataObject>',
      'utf8',
    );
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}
