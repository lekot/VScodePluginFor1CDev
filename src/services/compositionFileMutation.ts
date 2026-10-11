import {
  getConfigurationMutationEngine,
  type SingleFileMutationChange,
} from './configurationSession/ConfigurationMutationEngine';

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

/**
 * Common mutation boundary for composition XML writers.
 * Delegates to ConfigurationMutationEngine (#242).
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
  const engine = getConfigurationMutationEngine();
  const receipt = await engine.transformFile<T>(
    filePath,
    { kind, resourcePath: filePath },
    async (state): Promise<SingleFileMutationChange<T>> => {
      const { nextXml, result } = await transform({
        exists: state.exists,
        rawContent: state.content,
      });
      return { content: nextXml, result };
    },
  );

  if (receipt.status === 'conflict') {
    if (receipt.code === 'CONCURRENT_CREATE_COLLISION') {
      throw new Error(
        `Конфликт создания файла состава с параллельным процессом: ${filePath}. ${receipt.message}`
      );
    }
    throw new Error(`Конфликт обновления файла состава: ${filePath}. ${receipt.message}`);
  }
  if (receipt.status !== 'committed') {
    throw new Error(`Ошибка атомарной записи файла состава: ${filePath}. ${receipt.message}`);
  }
  return receipt.result!;
}
