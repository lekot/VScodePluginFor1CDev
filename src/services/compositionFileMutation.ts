import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStorage, hashContent } from './configurationSession/atomicFileStorage';
import { runConfigurationMutation } from './configurationSession/configurationMutationGateway';

const fileMutationTails = new Map<string, Promise<void>>();

export interface CompositionFileState {
  readonly exists: boolean;
  readonly rawContent: string;
}

export interface CompositionMutationTransformResult<T> {
  readonly nextXml: string;
  readonly result: T;
}

export type CompositionMutationTransform<T> = (
  state: CompositionFileState
) => Promise<CompositionMutationTransformResult<T>>;

async function findRootPathForFile(filePath: string): Promise<string> {
  let cursor = path.dirname(path.resolve(filePath));
  let depth = 0;
  while (depth < 16) {
    try {
      if (
        (await fs.promises.access(path.join(cursor, 'Configuration.xml')).then(() => true, () => false)) ||
        (await fs.promises.access(path.join(cursor, 'src', 'Configuration', 'Configuration.mdo')).then(() => true, () => false))
      ) {
        return cursor;
      }
    } catch {
      // Ignore errors and continue upwards
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
    depth++;
  }
  return path.dirname(path.resolve(filePath));
}

function getFileMutationKey(filePath: string): string {
  const canonical = path.resolve(filePath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Common mutation boundary for composition XML writers.
 *
 * Guarantees:
 * 1. Mutual exclusion per target file to sequence internal concurrent operations against latest state.
 * 2. Atomic Compare-and-Swap persistence via AtomicFileStorage to prevent stale snapshot overwrites.
 * 3. Safe creation of missing files (e.g. ExchangePlan Content.xml) without overwriting concurrent creators.
 * 4. Integration with configuration mutation gateway avoiding nested FIFO deadlocks.
 */
export async function mutateCompositionFile<T>(
  filePath: string,
  kind: string,
  transform: CompositionMutationTransform<T>
): Promise<T> {
  return runConfigurationMutation(filePath, kind, async () => {
    const canonicalPath = path.resolve(filePath);
    const lockKey = getFileMutationKey(canonicalPath);

    const previous = fileMutationTails.get(lockKey) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    fileMutationTails.set(lockKey, tail);

    await previous.catch(() => undefined);
    try {
      return await executeMutationWithRetry(canonicalPath, transform);
    } finally {
      releaseGate();
      if (fileMutationTails.get(lockKey) === tail) {
        fileMutationTails.delete(lockKey);
      }
    }
  });
}

async function executeMutationWithRetry<T>(
  canonicalPath: string,
  transform: CompositionMutationTransform<T>
): Promise<T> {
  const rootPath = await findRootPathForFile(canonicalPath);
  const storage = new AtomicFileStorage(rootPath);

  // Read current state once
  let exists = true;
  let rawContent = '';
  try {
    rawContent = await fs.promises.readFile(canonicalPath, 'utf-8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      exists = false;
    } else {
      throw err;
    }
  }

  const { nextXml, result } = await transform({ exists, rawContent });

  if (exists) {
    const originalHash = hashContent(rawContent);
    const outcome = await storage.replace(canonicalPath, nextXml, originalHash);
    if (outcome.status === 'conflict') {
      throw new Error(`Конфликт обновления файла состава: ${canonicalPath}. ${outcome.message}`);
    }
    if (outcome.status !== 'committed') {
      throw new Error(`Ошибка атомарной записи файла состава: ${canonicalPath}. ${outcome.message}`);
    }
    return result;
  }

  // File does not exist yet (missing file creation, e.g. ExchangePlan Ext/Content.xml)
  await fs.promises.mkdir(path.dirname(canonicalPath), { recursive: true });
  try {
    await fs.promises.writeFile(canonicalPath, nextXml, { encoding: 'utf-8', flag: 'wx' });
    return result;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
      // A concurrent creator won the race and created the file.
      // Re-read newly created file and retry transform once to merge against its state.
      const freshContent = await fs.promises.readFile(canonicalPath, 'utf-8');
      const freshHash = hashContent(freshContent);
      const retryResult = await transform({ exists: true, rawContent: freshContent });
      const retryOutcome = await storage.replace(canonicalPath, retryResult.nextXml, freshHash);
      if (retryOutcome.status !== 'committed') {
        throw new Error(
          `Конфликт создания файла состава с параллельным процессом: ${canonicalPath}. ${retryOutcome.message}`
        );
      }
      return retryResult.result;
    }
    throw err;
  }
}
