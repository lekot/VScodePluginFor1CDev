import { fileURLToPath } from 'url';

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

export function redactConfigurationCompareDiagnostic(message: CompareMessage): CompareMessage {
  return {
    severity: message.severity,
    code: message.code,
    phase: message.phase,
    sourceId: message.sourceId,
    nodeId: message.nodeId,
    blocking: message.blocking,
    suggestedAction: redactSuggestedAction(message.suggestedAction, message.path),
  };
}

function redactSuggestedAction(
  suggestedAction: string | undefined,
  sensitivePath: string | undefined
): string | undefined {
  if (!suggestedAction) {
    return undefined;
  }

  if (sensitivePath && containsSensitivePath(suggestedAction, sensitivePath)) {
    return 'Проверьте диагностику сравнения и пересоздайте preview перед повтором.';
  }

  return suggestedAction;
}

function containsSensitivePath(value: string, sensitivePath: string): boolean {
  return sensitivePathVariants(sensitivePath).some((variant) => value.includes(variant));
}

function sensitivePathVariants(sensitivePath: string): string[] {
  const variants = new Set<string>([sensitivePath]);
  variants.add(sensitivePath.replace(/\\/g, '/'));
  variants.add(sensitivePath.replace(/\//g, '\\'));

  try {
    const filePath = fileURLToPath(sensitivePath);
    variants.add(filePath);
    variants.add(filePath.replace(/\\/g, '/'));
    variants.add(filePath.replace(/\//g, '\\'));
  } catch {
    // Non-file paths are already covered by raw slash/backslash variants.
  }

  return [...variants].filter((variant) => variant.length > 0);
}
