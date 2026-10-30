import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { applySelectedXmlPatches } from './merge/semanticXmlMerge';
import type { CompareMessage } from './domain/compareContracts';
import type { MergeCandidate } from './merge/mergePreview';
import { createCapturedOutputCandidate } from './linkedDesignerPackageWrites';
import { blocked, canonicalRelativePath, hashBuffer, normalizeAbsolutePath } from './linkedDesignerUtils';
import type { LinkedDesignerMaterializerContext } from './linkedDesignerTypes';

export async function composeXmlCandidates(
  input: LinkedDesignerMaterializerContext,
  candidates: readonly MergeCandidate[],
  additionalWitnessesByTargetPath: ReadonlyMap<string, readonly import('./merge/mergePreview').MergeFileWitness[]> = new Map(),
): Promise<{ candidates: MergeCandidate[]; outputs: ReadonlyMap<string, string> } | { diagnostics: CompareMessage[] }> {
  const groups = new Map<string, MergeCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.xmlPatch) {continue;}
    let filePath: string;
    try {filePath = fileURLToPath(candidate.xmlPatch.target.filePath);}
    catch {filePath = candidate.xmlPatch.target.filePath;}
    groups.set(normalizeAbsolutePath(filePath), [...(groups.get(normalizeAbsolutePath(filePath)) ?? []), candidate]);
  }
  const outputs = new Map<string, string>();
  const writes: MergeCandidate[] = [];
  for (const [normalizedPath, group] of groups) {
    const filePath = path.resolve(fileURLToPath(group[0]!.xmlPatch!.target.filePath));
    const targetRelativePath = canonicalRelativePath(input.targetRootPath, filePath);
    if (!targetRelativePath) {
      return { diagnostics: [blocked('XML-кандидат указывает вне целевого корня.', input.targetSourceId, group[0]!.nodeId)] };
    }
    const source = await fs.readFile(filePath).catch(() => undefined);
    if (!source) {
      return { diagnostics: [blocked(`Целевой XML-файл отсутствует: ${targetRelativePath}`, input.targetSourceId, group[0]!.nodeId)] };
    }
    const sourceText = source.toString('utf8');
    const patches = group.map((candidate) => candidate.xmlPatch!).filter(Boolean);
    const merged = applySelectedXmlPatches(sourceText, patches);
    if (!merged.ok) {
      return { diagnostics: [blocked(merged.message, input.targetSourceId, group[0]!.nodeId)] };
    }
    const content = Buffer.from(merged.source, 'utf8');
    const witnesses = [
      ...patches.flatMap((patch) => patch.sourceWitnesses ?? []),
      ...group.flatMap((candidate) => candidate.sourceWitnesses ?? []),
      ...[...(additionalWitnessesByTargetPath.entries())]
        .filter(([relativePath]) => normalizeRelativePath(relativePath) === normalizeRelativePath(targetRelativePath))
        .flatMap(([, items]) => [...items]),
    ];
    const firstWitness = witnesses[0];
    if (!firstWitness) {
      return { diagnostics: [blocked('XML patch не содержит source witness для captured write.', input.sourceId, group[0]!.nodeId)] };
    }
    const candidate = await createCapturedOutputCandidate(input, {
      nodeId: group[0]!.nodeId,
      targetRelativePath,
      expectedTargetHash: hashBuffer(source),
      content,
      witnesses,
    });
    writes.push(candidate);
    outputs.set(normalizedPath, merged.source);
  }
  return { candidates: writes, outputs };
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
