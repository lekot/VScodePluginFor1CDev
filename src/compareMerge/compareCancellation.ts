export interface CompareCancellationToken {
  readonly isCancellationRequested: boolean;
}

export class ConfigurationCompareCancelledError extends Error {
  readonly code = 'CONFIGURATION_COMPARE_CANCELLED';

  constructor() {
    super('Configuration comparison cancelled');
    this.name = 'ConfigurationCompareCancelledError';
  }
}

export function throwIfCompareCancelled(token: CompareCancellationToken | undefined): void {
  if (token?.isCancellationRequested) {
    throw new ConfigurationCompareCancelledError();
  }
}

export function isConfigurationCompareCancelled(error: unknown): boolean {
  return error instanceof ConfigurationCompareCancelledError
    || (error as { code?: unknown } | undefined)?.code === 'CONFIGURATION_COMPARE_CANCELLED';
}
