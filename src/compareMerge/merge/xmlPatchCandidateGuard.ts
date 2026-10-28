import type { CompareSession } from '../domain/compareSession';
import type { CompareMessage } from '../domain/compareContracts';
import { validateMergeFileWitnesses } from './capturedFileWrite';
import {
  compareMessage,
  MISSING_TARGET_HASH,
  type MergeCandidate,
  type XmlPatchPayload,
} from './mergePreview';

export function validateXmlPatchCandidate(
  candidate: MergeCandidate,
  diagnostics: CompareMessage[],
  session?: CompareSession,
): void {
  const patch = candidate.xmlPatch;
  if (!patch) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_PATCH_MISSING', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'XML merge operation is missing patch payload.',
    }));
    return;
  }

  if (xmlKindForOperation(candidate.kind) !== patch.kind) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_PATCH_KIND_MISMATCH', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'XML merge operation kind must match patch payload kind.',
    }));
  }
  if (candidate.targetUri && patch.target.filePath && patch.target.filePath !== candidate.targetUri) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_PATCH_TARGET_MISMATCH', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'XML patch target must match operation target uri.',
    }));
  }
  if (candidate.expectedOldHash && patch.expectedOldHash !== candidate.expectedOldHash) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_PATCH_GUARD_MISMATCH', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'XML patch hash guard must match operation hash guard.',
    }));
  }
  if (candidate.newHash && patch.newHash !== candidate.newHash) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_PATCH_NEW_HASH_MISMATCH', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'XML patch new hash must match operation new hash.',
    }));
  }
  if (patch.kind !== 'deleteNode' && !patch.replacementXml) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_PATCH_REPLACEMENT_MISSING', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'XML insert/replace operation must include replacement XML.',
    }));
  }

  if ((patch.insertBefore && patch.insertPosition)
      || (patch.insertBefore && patch.kind !== 'insertNode')
      || (patch.insertPosition && patch.kind !== 'insertNode')) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_INSERT_POSITION_INVALID', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'Позиция вставки XML задана некорректно. Обновите сравнение.',
    }));
  }
  if (patch.insertOrder !== undefined &&
      (!Number.isSafeInteger(patch.insertOrder) || patch.insertOrder < 0 || patch.kind !== 'insertNode')) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_INSERT_ORDER_INVALID', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'Порядок вставки XML задан некорректно. Обновите сравнение.',
    }));
  }

  if (patch.semanticKind === undefined) {return;}
  if (!isSemanticXmlKind(patch.semanticKind)) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_SEMANTIC_KIND_UNSUPPORTED', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri,
      suggestedAction: 'Для этого вида XML нет семантического валидатора; обновите сравнение и повторите выбор.',
    }));
    return;
  }
  const sourceWitnesses = patch.sourceWitnesses;
  if (!sourceWitnesses?.length) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_SOURCE_WITNESS_MISSING', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'Для XML-изменения не сохранена проверка версии исходного файла. Обновите сравнение.',
    }));
    return;
  }
  if (sourceWitnesses.some((witness) => witness.kind === 'directory' || witness.expectedHash === MISSING_TARGET_HASH)) {
    diagnostics.push(compareMessage({
      severity: 'error', code: 'MERGE_XML_SOURCE_WITNESS_INVALID', sourceId: candidate.sourceId,
      nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: 'Проверка исходного XML должна ссылаться на существующий файл.',
    }));
  }
  diagnostics.push(...validateMergeFileWitnesses(
    sourceWitnesses,
    session ? new Set(session.state.sources.map((source) => source.sourceId)) : new Set([candidate.sourceId]),
  ).map((message) => compareMessage({
    severity: 'error', code: 'MERGE_XML_SOURCE_WITNESS_INVALID', sourceId: candidate.sourceId,
    nodeId: candidate.nodeId, path: candidate.targetUri, suggestedAction: message,
  })));
}

function xmlKindForOperation(kind: MergeCandidate['kind']): XmlPatchPayload['kind'] | undefined {
  if (kind === 'xmlNodeReplace') {return 'replaceNode';}
  if (kind === 'xmlNodeInsert') {return 'insertNode';}
  if (kind === 'xmlNodeDelete') {return 'deleteNode';}
  return undefined;
}

function isSemanticXmlKind(value: unknown): value is NonNullable<XmlPatchPayload['semanticKind']> {
  return value === 'metadataXml' || value === 'formXml' || value === 'predefinedXml';
}
