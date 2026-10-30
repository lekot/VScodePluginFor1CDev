import { applyXmlPatchBatch, hashXmlText } from '../xml/xmlPatch';
import {
  validateSemanticXmlMerge,
  type SemanticXmlKind,
  type SemanticXmlValidationContext,
} from '../adapters/semanticXml/semanticXmlValidator';
import type { XmlPatchPayload } from './mergePreview';

export type SemanticXmlMergeResult =
  | { ok: true; source: string }
  | { ok: false; code: string; message: string };

/** Applies a selected XML patch batch and validates the resulting document once. */
export function applySelectedXmlPatches(
  source: string,
  patches: readonly XmlPatchPayload[],
): SemanticXmlMergeResult {
  if (patches.length === 0) {
    return { ok: true, source };
  }

  if (patches.some((patch) => patch.semanticKind !== undefined && !isSemanticXmlKind(patch.semanticKind))) {
    return {
      ok: false,
      code: 'MERGE_XML_SEMANTIC_KIND_UNSUPPORTED',
      message: 'Для этого вида XML нет семантического валидатора.',
    };
  }

  const semanticKinds = new Set(patches.map((patch) => patch.semanticKind).filter(isSemanticXmlKind));
  if (semanticKinds.size > 1 || (semanticKinds.size === 1 && patches.some((patch) => !patch.semanticKind))) {
    return {
      ok: false,
      code: 'MERGE_XML_SEMANTIC_KIND_MISMATCH',
      message: 'Выбранные XML-операции относятся к разным видам документов.',
    };
  }

  const conflict = findXmlPatchConflict(patches);
  if (conflict) {
    return conflict;
  }

  const sourceHash = hashXmlText(source);
  if (patches.some((patch) => patch.expectedOldHash !== sourceHash)) {
    return {
      ok: false,
      code: 'MERGE_STALE_TARGET_HASH',
      message: 'Целевой XML-файл изменился после сравнения. Обновите сравнение перед построением preview.',
    };
  }

  let nextSource: string;
  try {
    nextSource = applyXmlPatchBatch(source, orderXmlPatches(patches));
  } catch (error) {
    return {
      ok: false,
      code: 'MERGE_XML_PATCH_FAILED',
      message: `Не удалось применить выбранное изменение XML: ${errorMessage(error)}`,
    };
  }

  const semanticKind = [...semanticKinds][0];
  if (!semanticKind) {
    return { ok: true, source: nextSource };
  }

  const validationContext = patches.find((patch) => patch.semanticContext)?.semanticContext;
  let validation: ReturnType<typeof validateSemanticXmlMerge>;
  try {
    validation = validateSemanticXmlMerge(nextSource, semanticKind, {
      ...validationContext,
      baselineSource: source,
    } satisfies SemanticXmlValidationContext);
  } catch (error) {
    return {
      ok: false,
      code: 'MERGE_XML_SEMANTIC_VALIDATION_FAILED',
      message: `Не удалось проверить результат XML: ${errorMessage(error)}`,
    };
  }
  if (!validation.valid) {
    const diagnostic = validation.diagnostics.find((item) => item.blocking) ?? validation.diagnostics[0];
    return {
      ok: false,
      code: diagnostic?.code ?? 'MERGE_XML_SEMANTIC_VALIDATION_FAILED',
      message: diagnostic
        ? `${diagnostic.message}${diagnostic.pointer ? ` (${diagnostic.pointer})` : ''}`
        : 'Итоговый XML не прошёл семантическую проверку.',
    };
  }

  return { ok: true, source: nextSource };
}

export function findXmlPatchConflict(
  patches: readonly XmlPatchPayload[],
): { ok: false; code: string; message: string } | undefined {
  for (let index = 0; index < patches.length; index += 1) {
    const current = patches[index]!;
    for (let otherIndex = index + 1; otherIndex < patches.length; otherIndex += 1) {
      const other = patches[otherIndex]!;
      if (current.target.filePath !== other.target.filePath) {
        continue;
      }
      if (current.target.pointer === other.target.pointer) {
        return {
          ok: false,
          code: 'MERGE_XML_DUPLICATE_PATCH_TARGET',
          message: 'Для одного XML-узла выбрано несколько изменений. Оставьте одно действие для этого узла.',
        };
      }
      if (isXmlPointerAncestor(current.target.pointer, other.target.pointer) ||
          isXmlPointerAncestor(other.target.pointer, current.target.pointer)) {
        if (isMoveWithDescendantScalarEdit(current, other) || isMoveWithDescendantScalarEdit(other, current)) {
          continue;
        }
        return {
          ok: false,
          code: 'MERGE_XML_OVERLAPPING_PATCH_TARGETS',
          message: 'Выбраны одновременно родительский XML-узел и вложенное изменение. Выберите только одно из них.',
        };
      }
    }
  }

  return undefined;
}

function isMoveWithDescendantScalarEdit(
  move: XmlPatchPayload,
  descendant: XmlPatchPayload,
): boolean {
  return move.kind === 'moveNode' && descendant.kind === 'replaceNode' &&
    isXmlPointerAncestor(move.target.pointer, descendant.target.pointer);
}

function orderXmlPatches(patches: readonly XmlPatchPayload[]): XmlPatchPayload[] {
  const ordered = [...patches];
  const deleteGroups = new Map<string, number[]>();
  patches.forEach((patch, index) => {
    const address = ordinalDeleteAddress(patch);
    if (!address) {
      return;
    }
    const key = JSON.stringify([address.filePath, address.parentPointer, address.localName]);
    deleteGroups.set(key, [...(deleteGroups.get(key) ?? []), index]);
  });

  for (const indexes of deleteGroups.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const descending = indexes
      .map((index) => patches[index]!)
      .sort((left, right) => ordinalDeleteAddress(right)!.ordinal - ordinalDeleteAddress(left)!.ordinal);
    indexes.forEach((index, position) => {
      ordered[index] = descending[position]!;
    });
  }

  const insertGroups = new Map<string, number[]>();
  patches.forEach((patch, index) => {
    const key = orderedInsertGroupKey(patch);
    if (!key) {
      return;
    }
    insertGroups.set(key, [...(insertGroups.get(key) ?? []), index]);
  });
  for (const indexes of insertGroups.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const sourceOrder = indexes
      .map((index) => patches[index]!)
      .sort((left, right) => left.insertOrder! - right.insertOrder!);
    indexes.forEach((index, position) => {
      ordered[index] = sourceOrder[position]!;
    });
  }
  return ordered;
}

function orderedInsertGroupKey(patch: XmlPatchPayload): string | undefined {
  if (patch.kind !== 'insertNode' || !Number.isFinite(patch.insertOrder)) {
    return undefined;
  }
  if (patch.insertBefore) {
    return JSON.stringify([patch.target.filePath, 'before', patch.insertBefore.pointer]);
  }
  if (patch.insertPosition === 'append') {
    const parentPointer = patch.target.pointer.slice(0, patch.target.pointer.lastIndexOf('/'));
    return JSON.stringify([patch.target.filePath, 'append', parentPointer]);
  }
  return undefined;
}

function ordinalDeleteAddress(
  patch: XmlPatchPayload,
): { filePath: string; parentPointer: string; localName: string; ordinal: number } | undefined {
  if (patch.kind !== 'deleteNode') {
    return undefined;
  }
  const segments = patch.target.pointer.split('/').filter(Boolean);
  const last = segments.pop();
  const match = last ? /^(.+)\[(\d+)\]$/.exec(last) : undefined;
  if (!last || !match) {
    return undefined;
  }
  return {
    filePath: patch.target.filePath,
    parentPointer: `/${segments.join('/')}`,
    localName: match[1]!,
    ordinal: Number(match[2]),
  };
}

function isXmlPointerAncestor(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function isSemanticXmlKind(value: string | undefined): value is SemanticXmlKind {
  return value === 'metadataXml' || value === 'formXml' || value === 'predefinedXml' ||
    value === 'roleRightsXml' || value === 'dcsXml';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
