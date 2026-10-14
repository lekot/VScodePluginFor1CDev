import type { ExtensionState } from '../state/extensionState';
import type { ReloadReason } from '../types/reloadContracts';

export type RequestConfigurationReload = (configPath: string, reason: ReloadReason) => Promise<void>;

/** Creates the single application entrypoint for targeted configuration reload requests. */
export function createRequestConfigurationReload(
  state: Pick<ExtensionState, 'reloadCoordinator'>,
): RequestConfigurationReload {
  return async (configPath, reason) => {
    const coordinator = state.reloadCoordinator;
    if (!coordinator) {
      throw Object.assign(new Error('Координатор перезагрузки конфигурации недоступен.'), {
        code: 'RELOAD_COORDINATOR_UNAVAILABLE',
      });
    }

    const result = await coordinator.requestReload(configPath, reason).completed;
    if (!result.succeeded) {
      const failure = result.failure ?? {
        code: 'UNKNOWN_RELOAD_FAILURE',
        message: result.error ?? 'Перезагрузка конфигурации завершилась ошибкой.',
      };
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
  };
}
