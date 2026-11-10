import type { CompareTreeNode } from '../compareTreeTypes';
import type { ExtensionTransferRow } from './extensionTransfer';

/** Adds display-only identity hints while preserving the canonical row ID and merge guard. */
export function extensionSemanticRowNode(
  row: ExtensionTransferRow,
  children: readonly CompareTreeNode[]
): CompareTreeNode {
  const identities = [
    row.target ? { side: 'left' as const, object: row.target } : undefined,
    row.incoming ? { side: 'right' as const, object: row.incoming } : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return {
    id: row.id,
    label: row.qualifiedName,
    kind: 'extensionMetadataObject',
    status: row.status,
    leftValue: row.target?.descriptorRelativePath,
    rightValue: row.incoming?.descriptorRelativePath,
    mergeable: row.mergeable,
    ...(row.reason ? { conflict: { kind: 'unsupported' as const, message: row.reason, blocking: true } } : {}),
    mergeState: row.mergeable
      ? { state: 'ready', targetFilePath: row.target?.descriptorRelativePath ?? row.incoming?.descriptorRelativePath }
      : { state: 'blocked', reason: row.reason ?? 'Объект не отличается или перенос не предусмотрен.' },
    presentation: {
      // CFE rows are distinct transfer identities; never coalesce by a base anchor.
      ownerKey: `extension-row:${row.id}`,
      ownerAliases: [`extension-row:${row.id}`],
      metadataType: identities[0]?.object.metadataType ?? row.qualifiedName.split('.')[0],
      qualifiedName: row.qualifiedName,
      identities: identities.map(({ side, object }) => ({
        side,
        qualifiedName: object.qualifiedName,
        uuid: object.identity?.uuid,
        filePath: object.identity?.path ?? object.descriptorRelativePath,
        ownership: object.identity?.ownership,
        sourceUuid: object.identity?.sourceUuid,
      })),
    },
    children: [...children],
  };
}
