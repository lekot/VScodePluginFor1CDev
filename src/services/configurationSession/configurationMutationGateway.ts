import type { MutationPlan } from './mutationPlan';
import * as fs from 'fs';
import * as path from 'path';
import { MutationPlanExecutor } from './mutationPlan';

export type MutationRunner = <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
export type PlanRunner = <T>(resourcePath: string, plan: MutationPlan<T>) => Promise<T>;
export type ExclusiveConfigurationCallback<T> = () => Promise<T>;

let mutationRunner: MutationRunner | undefined;
let planRunner: PlanRunner | undefined;

/** Installs the extension-scoped adapter while keeping unit-test consumers independent of VS Code. */
export function configureConfigurationMutationGateway(
  runMutation: MutationRunner,
  runPlan: PlanRunner,
): { dispose(): void } {
  mutationRunner = runMutation;
  planRunner = runPlan;
  return {
    dispose: () => {
      if (mutationRunner === runMutation) { mutationRunner = undefined; }
      if (planRunner === runPlan) { planRunner = undefined; }
    },
  };
}

export function runConfigurationMutation<T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
): Promise<T> {
  return mutationRunner ? mutationRunner(resourcePath, kind, operation) : operation();
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
      // Continue with the parent directory.
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
  throw new Error(`Configuration root not found for mutation plan: ${resourcePath}`);
}
