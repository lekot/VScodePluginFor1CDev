import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

import type { CompareMessage } from '../domain/compareContracts';
import type { MergeCandidate } from './mergePreview';
import { applySelectedXmlPatches } from './semanticXmlMerge';
import { hashXmlText } from '../xml/xmlPatch';
import { assertNoSymlinkSegments, assertPathWithinRoot } from '../../services/configurationSession/pathBoundary';

/** Validates every XML patch for a file when any selected patch uses semantic validation. */
export async function validateSemanticXmlCandidates(
  candidates: readonly MergeCandidate[],
  leftRootPath: string,
): Promise<CompareMessage[]> {
  const groups = new Map<string, { targetUri: string; targetPath: string; candidates: MergeCandidate[] }>();
  for (const candidate of candidates) {
    if (!candidate.xmlPatch) {
      continue;
    }
    const targetUri = candidate.targetUri;
    const targetPath = targetUri ? localTargetPath(targetUri) : undefined;
    if (!targetUri || !targetPath) {
      if (candidate.xmlPatch.semanticKind) {
        return [diagnostic('MERGE_XML_TARGET_GUARD_MISSING', 'Семантическая XML-операция не содержит локальный путь целевого файла.', candidate)];
      }
      continue;
    }
    const resolvedPath = path.resolve(targetPath);
    const key = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    const group = groups.get(key) ?? { targetUri, targetPath, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (!group.candidates.some((candidate) => candidate.xmlPatch?.semanticKind)) {
      continue;
    }

    let source: string;
    try {
      const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(leftRootPath, group.targetPath);
      await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
      source = await fs.readFile(canonicalTarget, 'utf8');
    } catch {
      return [diagnostic(
        'MERGE_XML_PREVIEW_READ_FAILED',
        'Не удалось безопасно прочитать целевой XML-файл для проверки выбранных изменений.',
        group.candidates[0]!,
      )];
    }

    const sourceHash = hashXmlText(source);
    if (group.candidates.some((candidate) => candidate.xmlPatch?.expectedOldHash !== sourceHash)) {
      return [diagnostic(
        'MERGE_STALE_TARGET_HASH',
        'Целевой XML-файл изменился после сравнения. Обновите сравнение перед построением preview.',
        group.candidates[0]!,
      )];
    }

    const applied = applySelectedXmlPatches(
      source,
      group.candidates.flatMap((candidate) => candidate.xmlPatch ? [candidate.xmlPatch] : []),
    );
    if (!applied.ok) {
      return [diagnostic(applied.code, applied.message, group.candidates[0]!)];
    }
  }
  return [];
}

function localTargetPath(targetUri: string): string | undefined {
  try {
    if (targetUri.startsWith('file:')) {
      return fileURLToPath(targetUri);
    }
    return path.isAbsolute(targetUri) ? targetUri : undefined;
  } catch {
    return undefined;
  }
}

function diagnostic(code: string, suggestedAction: string, candidate: MergeCandidate): CompareMessage {
  return {
    severity: 'error',
    code,
    phase: 'preview',
    sourceId: candidate.sourceId,
    nodeId: candidate.nodeId,
    path: candidate.targetUri,
    blocking: true,
    suggestedAction,
  };
}
