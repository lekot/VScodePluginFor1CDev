import * as path from 'path';

import type { CompareTreeNode } from './compareTreeTypes';

export interface ConfigCompareSelectionMetadata {
  deletionNodeIds: string[];
  replacementNodeIds: string[];
  unresolvedConflictCount: number;
}

export function summarizeCanonicalSelection(
  root: CompareTreeNode,
  executableNodeIds: readonly string[]
): ConfigCompareSelectionMetadata {
  const executableIds = new Set(executableNodeIds);
  const deletionNodeIds: string[] = [];
  const deletionIds = new Set<string>();
  const replacementNodeIds: string[] = [];
  const replacementIds = new Set<string>();
  const blockingConflictIds = new Set<string>();
  const stack = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.conflict?.blocking) {
      blockingConflictIds.add(node.id);
    }
    if (
      executableIds.has(node.id) &&
      node.status === 'leftOnly' &&
      (node.destructive === true || node.kind === 'bslRoutine') &&
      !deletionIds.has(node.id)
    ) {
      deletionIds.add(node.id);
      deletionNodeIds.push(node.id);
    }
    if (executableIds.has(node.id) && node.replacement === true && !replacementIds.has(node.id)) {
      replacementIds.add(node.id);
      replacementNodeIds.push(node.id);
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }

  return { deletionNodeIds, replacementNodeIds, unresolvedConflictCount: blockingConflictIds.size };
}

export function redactTreeNode(node: CompareTreeNode): CompareTreeNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    status: node.status,
    leftValue: redactTreeValue(node.leftValue),
    rightValue: redactTreeValue(node.rightValue),
    mergeable: node.mergeable,
    destructive: node.destructive,
    replacement: node.replacement,
    conflict: node.conflict
      ? { ...node.conflict, message: redactSafeText(node.conflict.message) ?? node.conflict.message }
      : undefined,
    mergeState: node.mergeState
      ? {
          state: node.mergeState.state,
          reason: redactSafeText(node.mergeState.reason),
        }
      : undefined,
    presentation: node.presentation
      ? {
          ownerKey: node.presentation.ownerKey,
          ownerAliases: node.presentation.ownerAliases ? [...node.presentation.ownerAliases] : undefined,
          metadataType: node.presentation.metadataType,
          moduleKind: node.presentation.moduleKind,
          bslRoutineAnalysis: node.presentation.bslRoutineAnalysis,
          qualifiedName: node.presentation.qualifiedName,
          identityConflict: node.presentation.identityConflict,
          ambiguousIdentitySet: node.presentation.ambiguousIdentitySet,
          identities: node.presentation.identities?.map((identity) => ({
            side: identity.side,
            qualifiedName: identity.qualifiedName,
            uuid: identity.uuid,
            filePath: redactIdentityPath(identity.filePath),
            ownership: identity.ownership,
            sourceUuid: identity.sourceUuid,
          })),
        }
      : undefined,
    children: node.children.map(redactTreeNode),
  };
}

export function safeRootLabel(value: string | undefined): string {
  if (!value) {
    return 'Конфигурация';
  }
  const basename = path.win32.basename(value.replace(/\//g, '\\')) || path.posix.basename(value);
  return basename && basename !== '.' && basename !== '\\' ? basename : 'Конфигурация';
}

export function redactSafeText(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return value.replace(/(?:[A-Za-z]:[\\/]|(?<![\w:])\/)[^\s"'<>]*/g, (match) => {
    const basename = safeRootLabel(match);
    return basename === 'Конфигурация' ? '[путь]' : `…/${basename}`;
  });
}

export function redactCompareDisplayLabel(value: string): string {
  return value &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !path.posix.isAbsolute(value)
    ? value
    : 'Конфигурация';
}

function redactTreeValue(value: string | undefined): string | undefined {
  if (
    !value ||
    /^sha256[:\w-]*/i.test(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\/(?!\/)[^\s]*/.test(value)
  ) {
    return undefined;
  }

  return value;
}

function redactIdentityPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    const normalized = value.replace(/\\/g, '/');
    if (!normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
      return normalized;
    }
  }
  return safeRootLabel(value);
}
