import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStorage, hashContent } from './atomicFileStorage';
import { assertPathWithinRoot, PathBoundaryError } from './pathBoundary';
import {
  runConfigurationMutation,
  runConfigurationPlan,
  runExclusiveConfigurationOperation,
  type MutationRunner,
  type PlanRunner,
} from './configurationMutationGateway';
import { MutationPlan, MutationPlanError } from './mutationPlan';
import type { ConfigurationCapabilities, ConfigurationContext, ConfigurationId } from './types';
import {
  ConfigurationContextResolver,
  type ResourceLike,
} from './ConfigurationContextResolver';

export type MutationOutcomeStatus =
  | 'committed'
  | 'conflict'
  | 'rolledBack'
  | 'recoveryRequired'
  | 'inDoubt';

export interface MutationReceipt<T = unknown> {
  readonly status: MutationOutcomeStatus;
  readonly kind: string;
  readonly resourcePath: string;
  readonly configurationId?: ConfigurationId;
  readonly oldRevision?: string;
  readonly newRevision?: string;
  readonly result?: T;
  readonly code?: string;
  readonly message?: string;
  readonly session?: { readonly id: string; readonly generation: number };
}

export interface SingleFileMutationState {
  readonly exists: boolean;
  readonly content: string;
  readonly revision?: string;
}

export interface SingleFileMutationChange<T> {
  readonly content: string;
  readonly result: T;
}

export type SingleFileTransform<T> = (
  state: SingleFileMutationState,
) => Promise<SingleFileMutationChange<T>> | SingleFileMutationChange<T>;

export interface MutationSessionInfo {
  readonly id: string;
  readonly generation: number;
}

export interface MutationIntent {
  readonly kind: string;
  readonly resourcePath?: string;
  readonly expectedConfigurationId?: ConfigurationId;
  readonly expectedRevision?: string;
  readonly session?: MutationSessionInfo;
}

export interface SingleFileMutationIntent extends MutationIntent {
  readonly resourcePath: string;
}

export interface ExternalProcessContext {
  readonly rootPath: string;
  readonly configurationId?: ConfigurationId;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ConfigurationMutationEngineDeps {
  readonly contextResolver?: ConfigurationContextResolver;
  readonly runMutation?: MutationRunner;
  readonly runPlan?: PlanRunner;
}

const fileMutationTails = new Map<string, Promise<void>>();

function getFileMutationKey(filePath: string): string {
  const canonical = path.resolve(filePath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function acquireFileLock(canonicalPath: string): Promise<() => void> {
  const lockKey = getFileMutationKey(canonicalPath);
  const previous = fileMutationTails.get(lockKey) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  fileMutationTails.set(lockKey, tail);

  await previous.catch(() => undefined);
  return () => {
    releaseGate();
    if (fileMutationTails.get(lockKey) === tail) {
      fileMutationTails.delete(lockKey);
    }
  };
}

function isConfigurationContext(target: unknown): target is ConfigurationContext {
  return (
    typeof target === 'object' &&
    target !== null &&
    'configurationId' in target &&
    'rootPath' in target &&
    'capabilities' in target &&
    'session' in target
  );
}

async function findRootPathForFile(filePath: string): Promise<string> {
  let cursor = path.resolve(filePath);
  try {
    const stat = await fs.promises.stat(cursor);
    if (!stat.isDirectory()) {
      cursor = path.dirname(cursor);
    }
  } catch {
    cursor = path.dirname(cursor);
  }
  let depth = 0;
  let firstExistingDir: string | undefined;
  while (depth < 16) {
    let exists = false;
    try {
      const stat = await fs.promises.stat(cursor);
      exists = stat.isDirectory();
      if (exists && !firstExistingDir) {
        firstExistingDir = cursor;
      }
    } catch {
      // Directory does not exist yet
    }

    if (exists) {
      try {
        if (
          (await fs.promises.access(path.join(cursor, 'Configuration.xml')).then(
            () => true,
            () => false,
          )) ||
          (await fs.promises.access(path.join(cursor, 'src', 'Configuration', 'Configuration.mdo')).then(
            () => true,
            () => false,
          ))
        ) {
          return cursor;
        }
      } catch {
        // Continue upwards
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
    depth++;
  }
  return firstExistingDir || path.dirname(path.resolve(filePath));
}

interface ResolvedTargetContext {
  readonly rootPath: string;
  readonly configurationId?: ConfigurationId;
  readonly capabilities?: ConfigurationCapabilities;
}

/**
 * Unified mutation facade for configuration modifications (#242).
 *
 * Coordinates:
 * 1. Target resolution to configuration root & ConfigurationId.
 * 2. Configuration-level mutual exclusion via configurationMutationGateway.
 * 3. File-level mutual exclusion via sequencing queues.
 * 4. Optimistic concurrency control (CAS) via content hash verification.
 * 5. Atomic file replacement with fsync & temp file quarantine.
 * 6. Safe atomic create-if-absent with parallel creation collision recovery.
 * 7. Path containment and boundary assertions.
 * 8. Unified outcome taxonomy (committed, conflict, rolledBack, recoveryRequired, inDoubt).
 */
export class ConfigurationMutationEngine {
  constructor(private readonly deps: ConfigurationMutationEngineDeps = {}) {}

  /**
   * Resolves target into configuration identity and capabilities.
   */
  private async resolveTarget(
    target: ResourceLike | ConfigurationContext,
    fallbackResourcePath?: string,
  ): Promise<ResolvedTargetContext> {
    if (isConfigurationContext(target)) {
      return {
        rootPath: target.rootPath,
        configurationId: target.configurationId,
        capabilities: target.capabilities,
      };
    }

    const candidate = fallbackResourcePath || (typeof target === 'string' ? target : undefined);

    if (this.deps.contextResolver && candidate) {
      try {
        const resolved = await this.deps.contextResolver.resolveFromResource(candidate);
        return {
          rootPath: resolved.rootPath,
          configurationId: resolved.configurationId,
          capabilities: resolved.capabilities,
        };
      } catch {
        // Fall back to filesystem walk if not in registry
      }
    }

    const rootPath = candidate ? await findRootPathForFile(candidate) : process.cwd();
    return { rootPath };
  }

  /**
   * Transforms a single file atomically with compare-and-swap guarantees.
   */
  async transformFile<T>(
    target: ResourceLike | ConfigurationContext,
    intent: SingleFileMutationIntent,
    transform: SingleFileTransform<T>,
  ): Promise<MutationReceipt<T>> {
    const rawPath = intent.resourcePath || (typeof target === 'string' ? target : undefined);
    if (!rawPath) {
      return {
        status: 'conflict',
        code: 'INVALID_RESOURCE_PATH',
        message: 'Resource path is required for single-file transform.',
        kind: intent.kind,
        resourcePath: '',
        session: intent.session,
      };
    }

    const canonicalTarget = path.resolve(rawPath);
    const resolved = await this.resolveTarget(target, canonicalTarget);

    if (resolved.capabilities && !resolved.capabilities.write) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        message: 'Конфигурация открыта только для чтения.',
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    if (
      intent.expectedConfigurationId &&
      resolved.configurationId &&
      intent.expectedConfigurationId !== resolved.configurationId
    ) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_ID_MISMATCH',
        message: 'Идентификатор конфигурации не совпадает с ожидаемым.',
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    try {
      await assertPathWithinRoot(resolved.rootPath, canonicalTarget);
    } catch (err) {
      if (err instanceof PathBoundaryError) {
        return {
          status: 'conflict',
          code: 'TARGET_OUTSIDE_ROOT',
          message: err.message,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId: resolved.configurationId,
          session: intent.session,
        };
      }
      throw err;
    }

    const runMut = this.deps.runMutation ?? runConfigurationMutation;
    return await runMut(canonicalTarget, intent.kind, async () => {
      const releaseLock = await acquireFileLock(canonicalTarget);
      try {
        return await this.executeFileTransform(
          resolved.rootPath,
          canonicalTarget,
          intent,
          transform,
          resolved.configurationId,
        );
      } finally {
        releaseLock();
      }
    });
  }

  private async executeFileTransform<T>(
    rootPath: string,
    canonicalTarget: string,
    intent: SingleFileMutationIntent,
    transform: SingleFileTransform<T>,
    configurationId?: ConfigurationId,
  ): Promise<MutationReceipt<T>> {
    let exists = true;
    let rawContent = '';
    try {
      rawContent = await fs.promises.readFile(canonicalTarget, 'utf-8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }

    const currentHash = exists ? hashContent(rawContent) : undefined;

    if (intent.expectedRevision !== undefined && currentHash !== intent.expectedRevision) {
      return {
        status: 'conflict',
        code: 'STALE_TARGET_REVISION',
        message: 'Файл изменился после чтения; запись отменена.',
        oldRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    let change: SingleFileMutationChange<T>;
    try {
      change = await transform({ exists, content: rawContent, revision: currentHash });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'rolledBack',
        code: 'TRANSFORM_FAILED',
        message,
        oldRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    if (exists && change.content === rawContent) {
      return {
        status: 'committed',
        result: change.result,
        oldRevision: currentHash,
        newRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    const storage = new AtomicFileStorage(rootPath);

    if (exists) {
      const outcome = await storage.replace(canonicalTarget, change.content, currentHash!);
      if (outcome.status === 'committed') {
        return {
          status: 'committed',
          result: change.result,
          oldRevision: currentHash,
          newRevision: outcome.newHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      if (outcome.status === 'conflict') {
        return {
          status: 'conflict',
          code: outcome.code,
          message: outcome.message,
          oldRevision: currentHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      if (outcome.status === 'recoveryRequired') {
        return {
          status: 'recoveryRequired',
          code: outcome.code,
          message: outcome.message,
          oldRevision: currentHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      return {
        status: 'rolledBack',
        code: outcome.code,
        message: outcome.message,
        oldRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    // Missing file creation
    await fs.promises.mkdir(path.dirname(canonicalTarget), { recursive: true });
    try {
      await fs.promises.writeFile(canonicalTarget, change.content, { encoding: 'utf-8', flag: 'wx' });
      return {
        status: 'committed',
        result: change.result,
        oldRevision: undefined,
        newRevision: hashContent(change.content),
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
        // Parallel creator race: re-read freshly created file and retry transform once
        const freshContent = await fs.promises.readFile(canonicalTarget, 'utf-8');
        const freshHash = hashContent(freshContent);
        let retryChange: SingleFileMutationChange<T>;
        try {
          retryChange = await transform({ exists: true, content: freshContent, revision: freshHash });
        } catch (err2: unknown) {
          const msg = err2 instanceof Error ? err2.message : String(err2);
          return {
            status: 'rolledBack',
            code: 'TRANSFORM_FAILED',
            message: msg,
            oldRevision: freshHash,
            kind: intent.kind,
            resourcePath: canonicalTarget,
            configurationId,
            session: intent.session,
          };
        }

        const retryOutcome = await storage.replace(canonicalTarget, retryChange.content, freshHash);
        if (retryOutcome.status === 'committed') {
          return {
            status: 'committed',
            result: retryChange.result,
            oldRevision: freshHash,
            newRevision: retryOutcome.newHash,
            kind: intent.kind,
            resourcePath: canonicalTarget,
            configurationId,
            session: intent.session,
          };
        }
        return {
          status: 'conflict',
          code: 'CONCURRENT_CREATE_COLLISION',
          message: `Конфликт создания файла с параллельным процессом: ${canonicalTarget}. ${retryOutcome.message}`,
          oldRevision: freshHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'rolledBack',
        code: 'WRITE_FAILED',
        message: msg,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }
  }

  /**
   * Executes a multi-file mutation plan atomically.
   */
  async executePlan<T>(
    target: ResourceLike | ConfigurationContext,
    intent: MutationIntent,
    builder: (snapshot: { rootPath: string; configurationId?: ConfigurationId }) => Promise<MutationPlan<T>> | MutationPlan<T>,
  ): Promise<MutationReceipt<T>> {
    const resolved = await this.resolveTarget(target);

    if (resolved.capabilities && !resolved.capabilities.write) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        message: 'Конфигурация открыта только для чтения.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    if (
      intent.expectedConfigurationId &&
      resolved.configurationId &&
      intent.expectedConfigurationId !== resolved.configurationId
    ) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_ID_MISMATCH',
        message: 'Идентификатор конфигурации не совпадает с ожидаемым.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    try {
      const plan = await builder({ rootPath: resolved.rootPath, configurationId: resolved.configurationId });
      const runPl = this.deps.runPlan ?? runConfigurationPlan;
      const result = await runPl(resolved.rootPath, plan);
      return {
        status: 'committed',
        result,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    } catch (err: unknown) {
      if (err instanceof MutationPlanError) {
        if (err.code === 'PLAN_CONFLICT') {
          return {
            status: 'conflict',
            code: 'PLAN_CONFLICT',
            message: err.message,
            kind: intent.kind,
            resourcePath: resolved.rootPath,
            configurationId: resolved.configurationId,
            session: intent.session,
          };
        }
        if (err.code === 'RECOVERY_REQUIRED') {
          return {
            status: 'recoveryRequired',
            code: 'RECOVERY_REQUIRED',
            message: err.message,
            kind: intent.kind,
            resourcePath: resolved.rootPath,
            configurationId: resolved.configurationId,
            session: intent.session,
          };
        }
        return {
          status: 'rolledBack',
          code: 'PLAN_FAILED',
          message: err.message,
          kind: intent.kind,
          resourcePath: resolved.rootPath,
          configurationId: resolved.configurationId,
          session: intent.session,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'rolledBack',
        code: 'PLAN_FAILED',
        message: msg,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }
  }

  /**
   * Executes an external subprocess operation under configuration lease.
   */
  async executeExternal<T>(
    target: ResourceLike | ConfigurationContext,
    intent: MutationIntent,
    runner: (context: ExternalProcessContext) => Promise<T>,
  ): Promise<MutationReceipt<T>> {
    const resolved = await this.resolveTarget(target);

    if (resolved.capabilities && !resolved.capabilities.process) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        message: 'Выполнение процессов не поддерживается для данной конфигурации.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    try {
      const result = await runExclusiveConfigurationOperation(
        resolved.rootPath,
        intent.kind,
        async () => {
          return await runner({
            rootPath: resolved.rootPath,
            configurationId: resolved.configurationId,
            cwd: resolved.rootPath,
          });
        },
      );

      return {
        status: 'committed',
        result,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled =
        (err instanceof Error && err.name === 'AbortError') ||
        msg.toLowerCase().includes('cancel');

      return {
        status: 'rolledBack',
        code: isCancelled ? 'CANCELLED' : 'PROCESS_FAILED',
        message: msg,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }
  }
}

let defaultMutationEngine: ConfigurationMutationEngine | undefined;

export function getConfigurationMutationEngine(): ConfigurationMutationEngine {
  if (!defaultMutationEngine) {
    defaultMutationEngine = new ConfigurationMutationEngine();
  }
  return defaultMutationEngine;
}

export function setConfigurationMutationEngine(engine: ConfigurationMutationEngine | undefined): void {
  defaultMutationEngine = engine;
}
