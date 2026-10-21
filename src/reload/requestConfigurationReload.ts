import type { RequestReloadContext } from '../extension/extensionFeatureContexts';
import type { ReloadReason } from '../types/reloadContracts';

export type RequestConfigurationReload = (configPath: string, reason: ReloadReason) => Promise<void>;

/** Creates the single application entrypoint for targeted configuration reload requests. */
export function createRequestConfigurationReload(
  state: RequestReloadContext,
): RequestConfigurationReload {
  return async (configPath, reason) => {
    const coordinator = state.reloadCoordinator;
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
