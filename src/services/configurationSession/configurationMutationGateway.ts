import type { MutationPlan } from './mutationPlan';
import * as fs from 'fs';
import * as path from 'path';
import { MutationPlanExecutor } from './mutationPlan';
import { assertPathWithinRoot, isSamePath, PathBoundaryError } from './pathBoundary';
import type { MutationExecutionOptions, MutationOutcome } from './ConfigurationSession';

export type MutationRunner = <T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
  options?: MutationExecutionOptions<T>,
) => Promise<T>;
export type PlanRunner = <T>(
  resourcePath: string,
  plan: MutationPlan<T>,
  options?: MutationExecutionOptions<T>,
) => Promise<T>;
export type MutationOutcomeRunner = <T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
  options?: MutationExecutionOptions<T>,
) => Promise<MutationOutcome<T>>;
export type PlanOutcomeRunner = <T>(
  resourcePath: string,
  plan: MutationPlan<T>,
  options?: MutationExecutionOptions<T>,
) => Promise<MutationOutcome<T>>;
export type ExclusiveConfigurationCallback<T> = () => Promise<T>;

let mutationRunner: MutationRunner | undefined;
let planRunner: PlanRunner | undefined;
let mutationOutcomeRunner: MutationOutcomeRunner | undefined;
let planOutcomeRunner: PlanOutcomeRunner | undefined;

/** Installs the extension-scoped adapter while keeping unit-test consumers independent of VS Code. */
export function configureConfigurationMutationGateway(
  runMutation: MutationRunner,
  runPlan?: PlanRunner,
  runMutationOutcome?: MutationOutcomeRunner,
  runPlanOutcome?: PlanOutcomeRunner,
): { dispose(): void } {
  const previousMutation = mutationRunner;
  const previousPlan = planRunner;
  const previousMutationOutcome = mutationOutcomeRunner;
  const previousPlanOutcome = planOutcomeRunner;
  mutationRunner = runMutation;
  planRunner = runPlan;
  mutationOutcomeRunner = runMutationOutcome;
  planOutcomeRunner = runPlanOutcome;
  return {
    dispose: () => {
      mutationRunner = previousMutation;
      planRunner = previousPlan;
      mutationOutcomeRunner = previousMutationOutcome;
      planOutcomeRunner = previousPlanOutcome;
    },
  };
}

export function resetConfigurationMutationGateway(): void {
  mutationRunner = undefined;
  planRunner = undefined;
  mutationOutcomeRunner = undefined;
  planOutcomeRunner = undefined;
}

export function isConfigurationMutationGatewayConfigured(): boolean {
  return mutationRunner !== undefined;
}

export class ConfigurationMutationGatewayError extends Error {
  constructor(readonly code: 'RUNNER_NOT_CONFIGURED' | 'CONFIGURATION_ROOT_NOT_FOUND', message: string) {
    super(message);
    this.name = 'ConfigurationMutationGatewayError';
  }
}

export async function runConfigurationMutation<T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
  options?: MutationExecutionOptions<T>,
): Promise<T> {
  if (!mutationRunner) {
    throw new ConfigurationMutationGatewayError(
      'RUNNER_NOT_CONFIGURED',
      `Cannot run mutation '${kind}' on ${resourcePath}: Configuration mutation runner is not configured.`,
    );
  }
  return mutationRunner(resourcePath, kind, operation, options);
}

/** Runs a mutation through the configured session and returns its typed outcome envelope. */
export async function runConfigurationMutationOutcome<T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
  options?: MutationExecutionOptions<T>,
): Promise<MutationOutcome<T>> {
  if (!mutationOutcomeRunner) {
    throw new ConfigurationMutationGatewayError(
      'RUNNER_NOT_CONFIGURED',
      `Cannot run mutation '${kind}' on ${resourcePath}: Configuration mutation outcome runner is not configured.`,
    );
  }
  return mutationOutcomeRunner(resourcePath, kind, operation, options);
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
  return runConfigurationMutation(resourcePath, kind, operation, { reconcile: false });
}

export function runConfigurationPlan<T>(
  resourcePath: string,
  plan: MutationPlan<T>,
  options?: MutationExecutionOptions<T>,
): Promise<T> {
  return planRunner ? planRunner(resourcePath, plan, options) : executeStandalone(resourcePath, plan);
}

/** Runs a plan through the configured session and returns its typed outcome envelope. */
export async function runConfigurationPlanOutcome<T>(
  resourcePath: string,
  plan: MutationPlan<T>,
  options?: MutationExecutionOptions<T>,
): Promise<MutationOutcome<T>> {
  if (!planOutcomeRunner) {
    throw new ConfigurationMutationGatewayError(
      'RUNNER_NOT_CONFIGURED',
      `Cannot run mutation plan on ${resourcePath}: Configuration plan outcome runner is not configured.`,
    );
  }
  return planOutcomeRunner(resourcePath, plan, options);
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
    const hasDesignerMarker = await isRegularFile(path.join(cursor, 'Configuration.xml'));
    const hasEdtMarker = await isRegularFile(path.join(cursor, 'src', 'Configuration', 'Configuration.mdo'));
    if (hasDesignerMarker || hasEdtMarker) {
      const markerRoot = cursor;
      const canonicalRoot = await fs.promises.realpath(cursor);
      const canonicalPlan = await canonicalizeStandalonePlan(markerRoot, canonicalRoot, plan);
      return new MutationPlanExecutor(canonicalRoot).execute(canonicalPlan);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      searching = false;
    } else {
      cursor = parent;
    }
  }

  throw new ConfigurationMutationGatewayError(
    'CONFIGURATION_ROOT_NOT_FOUND',
    `Configuration root not found for mutation plan: ${resourcePath}`,
  );
}

async function canonicalizeStandalonePlan<T>(
  markerRoot: string,
  canonicalRoot: string,
  plan: MutationPlan<T>,
): Promise<MutationPlan<T>> {
  const canonicalizePath = async (originalPath: string): Promise<string> => {
    const resolved = await assertPathWithinRoot(markerRoot, originalPath);
    if (!isSamePath(resolved.canonicalRoot, canonicalRoot)) {
      throw new PathBoundaryError(
        'PATH_OUTSIDE_ROOT',
        `Configuration root changed while resolving mutation path: ${originalPath}`,
        originalPath,
      );
    }
    return resolved.canonicalTarget;
  };

  const steps = await Promise.all(plan.steps.map(async (step) => {
    if (step.type === 'movePath') {
      const [sourcePath, targetPath] = await Promise.all([
        canonicalizePath(step.sourcePath),
        canonicalizePath(step.targetPath),
      ]);
      return { ...step, sourcePath, targetPath };
    }
    return { ...step, targetPath: await canonicalizePath(step.targetPath) };
  }));

  return { ...plan, steps };
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(filePath)).isFile();
  } catch {
    return false;
  }
}
