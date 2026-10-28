import * as path from 'path';

import { throwIfCompareCancelled } from '../compareCancellation';
import type { CompareMessage } from '../domain/compareContracts';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { ExtensionCapturedFile, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionMaterializerInput, ExtensionTransferRow } from './extensionTransfer';

export async function hydrateSelectedObjectSidecars(
  incomingRoot: ExtensionMetadataIndex,
  row: ExtensionTransferRow,
  cancellation: ExtensionMaterializerInput['cancellation'],
): Promise<ExtensionTransferRow | { diagnostic: CompareMessage }> {
  const incoming = row.incoming;
  if (!incoming || (row.action !== 'full-copy' && row.action !== 'adopted-cfe-copy') || incoming.sidecarFiles.length === 0) {
    return row;
  }
  const rootPath = incomingRoot.canonicalRootPath ?? incomingRoot.rootPath;
  const sidecarFiles: ExtensionCapturedFile[] = [];
  for (const file of incoming.sidecarFiles) {
    throwIfCompareCancelled(cancellation);
    if (file.content) {
      sidecarFiles.push(file);
      continue;
    }
    try {
      const snapshot = await captureMergePath(path.join(rootPath, file.relativePath), { retainContent: true });
      if (snapshot.state !== 'file' || snapshot.hash !== file.hash || snapshot.contentBase64 === undefined) {
        return { diagnostic: blocked(`Sidecar изменился после сравнения: ${file.relativePath}`, incoming.sourceId, row.id) };
      }
      sidecarFiles.push({ ...file, content: Buffer.from(snapshot.contentBase64, 'base64') });
    } catch (error) {
      return { diagnostic: blocked(`Не удалось захватить sidecar ${file.relativePath}: ${errorMessage(error)}`, incoming.sourceId, row.id) };
    }
  }
  return { ...row, incoming: { ...incoming, sidecarFiles } };
}

export function outputPathCollision(outputs: readonly {
  readonly row: { readonly id: string };
  readonly outputRelativePaths: readonly string[];
}[]): string | undefined {
  const owners = new Map<string, { rowId: string; path: string }>();
  const allPaths = outputs.flatMap((output) => output.outputRelativePaths);
  for (const output of outputs) {
    for (const relativePath of output.outputRelativePaths) {
      const key = path.normalize(relativePath).replace(/\\/g, '/').toLowerCase();
      const existing = owners.get(key);
      if (existing && existing.rowId !== output.row.id) {
        return `Выбранные объекты пересекаются по target path: ${existing.path} и ${relativePath}.`;
      }
      owners.set(key, { rowId: output.row.id, path: relativePath });
    }
  }
  const unique = [...new Set(allPaths.map((item) => path.normalize(item).replace(/\\/g, '/').toLowerCase()))];
  for (let left = 0; left < unique.length; left++) {
    for (let right = left + 1; right < unique.length; right++) {
      const a = unique[left]!;
      const b = unique[right]!;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        return `Выбранные outputs имеют вложенные target paths: ${a} и ${b}.`;
      }
    }
  }
  return undefined;
}

function blocked(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return { severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare', sourceId, nodeId, blocking: true, suggestedAction: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
