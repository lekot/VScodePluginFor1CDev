import type { CompareMessage } from '../domain/compareContracts';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import type { ExtensionMaterializerInput, ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';

export interface ExtensionLinkedPackageWrite {
  readonly relativePath: string;
  readonly content: Buffer;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}

export function materializeExtensionLinkedDesignerPackages(
  input: ExtensionMaterializerInput,
  row: ExtensionTransferRow,
  selections: readonly ExtensionSemanticSelection[],
  witnesses: readonly MergeFileWitness[],
): { readonly writes: ExtensionLinkedPackageWrite[]; readonly deletePaths: string[] } | { readonly diagnostic: CompareMessage } {
  const ids = [...new Set(selections.map((selection) => selection.linkedPackageId).filter((id): id is string => Boolean(id)))];
  const writes: ExtensionLinkedPackageWrite[] = [];
  const deletePaths: string[] = [];
  for (const packageId of ids) {
    const recipe = input.linkedDesignerPackages?.get(packageId);
    if (!recipe || recipe.rowId !== row.id) {
      return { diagnostic: diagnostic('Связанный Designer-пакет отсутствует в текущем compare snapshot.', row.incoming?.sourceId ?? 'right-source', row.id) };
    }
    for (const member of recipe.members) {
      if (recipe.action === 'delete') {
        if (member.expectedTargetHash === MISSING_TARGET_HASH) {
          return { diagnostic: diagnostic(`Путь удаляемого Designer-пакета отсутствует в compare snapshot: ${member.targetRelativePath}`, row.targetRoot.sourceId, row.id) };
        }
        deletePaths.push(member.targetRelativePath);
        continue;
      }
      if (!member.content || !member.sourceRelativePath || !member.sourceHash) {
        return { diagnostic: diagnostic(`Captured bytes linked Designer package отсутствуют: ${member.sourceRelativePath ?? member.targetRelativePath}`, row.incoming?.sourceId ?? 'right-source', row.id) };
      }
      if (member.expectedTargetHash !== MISSING_TARGET_HASH) {
        return { diagnostic: diagnostic(`Target уже содержит файл нового Designer-пакета: ${member.targetRelativePath}`, row.targetRoot.sourceId, row.id) };
      }
      writes.push({
        relativePath: member.targetRelativePath,
        content: Buffer.from(member.content),
        sourceWitnesses: dedupeWitnesses([
          ...witnesses,
          { sourceId: row.incoming!.sourceId, relativePath: member.sourceRelativePath, expectedHash: member.sourceHash, kind: 'file' },
        ]),
      });
    }
    deletePaths.push(...recipe.incompatibleDeletePaths);
  }
  return { writes, deletePaths };
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {byKey.set(`${witness.sourceId}\0${witness.relativePath}\0${witness.kind ?? 'file'}`, witness);}
  return [...byKey.values()];
}

function diagnostic(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return { severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare', sourceId, nodeId, blocking: true, suggestedAction: message };
}
