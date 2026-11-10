import type { CompareMessage } from './domain/compareContracts';

const LEFT_SOURCE_ID = 'left-source';

export function configurationCompareWorkspaceDiagnostic(
  code: string,
  suggestedAction: string,
  nodeId?: string
): CompareMessage {
  return {
    severity: 'error',
    code,
    phase: 'preview',
    sourceId: LEFT_SOURCE_ID,
    nodeId,
    blocking: true,
    suggestedAction,
  };
}

export function cancelledRefreshDiagnostic(): CompareMessage {
  return {
    severity: 'warning',
    code: 'CONFIGURATION_COMPARE_CANCELLED',
    phase: 'compare',
    sourceId: LEFT_SOURCE_ID,
    blocking: true,
    suggestedAction: 'Сравнение конфигурации отменено.',
  };
}
