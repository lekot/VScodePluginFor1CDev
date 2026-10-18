import type { MutationPlan } from './mutationPlan';
import * as fs from 'fs';
import * as path from 'path';
import { MutationPlanExecutor } from './mutationPlan';
import { isPathInside, isSamePath } from './pathBoundary';

export type MutationRunner = <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
export type PlanRunner = <T>(resourcePath: string, plan: MutationPlan<T>) => Promise<T>;
export type ExclusiveConfigurationCallback<T> = () => Promise<T>;

let mutationRunner: MutationRunner | undefined;
let planRunner: PlanRunner | undefined;

/** Installs the extension-scoped adapter while keeping unit-test consumers independent of VS Code. */
export function configureConfigurationMutationGateway(
  runMutation: MutationRunner,
  runPlan?: PlanRunner,
): { dispose(): void } {
  const previousMutation = mutationRunner;
  const previousPlan = planRunner;
  mutationRunner = runMutation;
  planRunner = runPlan;
  return {
    dispose: () => {
      mutationRunner = previousMutation;
      planRunner = previousPlan;
    },
  };
}

export function resetConfigurationMutationGateway(): void {
  mutationRunner = undefined;
  planRunner = undefined;
}

export class ConfigurationMutationGatewayError extends Error {
  constructor(readonly code: 'RUNNER_NOT_CONFIGURED', message: string) {
    super(message);
    this.name = 'ConfigurationMutationGatewayError';
  }
}

export async function runConfigurationMutation<T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!mutationRunner) {
    throw new ConfigurationMutationGatewayError(
      'RUNNER_NOT_CONFIGURED',
      `Cannot run mutation '${kind}' on ${resourcePath}: Configuration mutation runner is not configured.`,
    );
  }
  return mutationRunner(resourcePath, kind, operation);
}

/**
 * Runs a short configuration-wide critical section on the same FIFO lease as metadata mutations.
 * External process fan-out must start only after this promise settles.
 */
export function runExclusiveConfigurationOperation<T>(
  resourcePath: string,
  kind: string,
  operation: ExclusiveConfigurationCallback<T>,
): Promise<T> {
  return runConfigurationMutation(resourcePath, kind, operation);
}

export function runConfigurationPlan<T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> {
  return planRunner ? planRunner(resourcePath, plan) : executeStandalone(resourcePath, plan);
}

async function executeStandalone<T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> {
  let cursor = path.resolve(resourcePath);
  try {
    if (!(await fs.promises.stat(cursor)).isDirectory()) { cursor = path.dirname(cursor); }
  } catch {
    cursor = path.dirname(cursor);
  }
  let searching = true;
  while (searching) {
    let isConfigurationRoot = false;
    try {
      await fs.promises.access(path.join(cursor, 'Configuration.xml'));
      isConfigurationRoot = true;
    } catch {
      try {
        await fs.promises.access(path.join(cursor, 'src', 'Configuration', 'Configuration.mdo'));
        isConfigurationRoot = true;
      } catch {
        // Continue with the parent directory.
      }
    }
    if (isConfigurationRoot) {
      return new MutationPlanExecutor(cursor).execute(plan);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      searching = false;
    } else {
      cursor = parent;
    }
  }

  const allPaths: string[] = [resourcePath];
  for (const step of plan.steps) {
    allPaths.push(step.targetPath);
    if (step.type === 'movePath') {
      allPaths.push(step.sourcePath);
    }
  }
  const fallbackRoot = findCommonDirectory(allPaths);
  return new MutationPlanExecutor(fallbackRoot).execute(plan);
}

function findCommonDirectory(paths: string[]): string {
  if (paths.length === 0) {
    return process.cwd();
  }
  const resolved = paths.map((p) => path.resolve(p));
  let common = resolved[0];
  while (!fs.existsSync(common) || !fs.statSync(common).isDirectory()) {
    const parent = path.dirname(common);
    if (parent === common) {
      break;
    }
    common = parent;
  }
  for (const p of resolved) {
    while (!isPathInside(common, p) && !isSamePath(common, p)) {
      const parent = path.dirname(common);
      if (parent === common) {
        break;
      }
      common = parent;
    }
  }
  return common;
}
