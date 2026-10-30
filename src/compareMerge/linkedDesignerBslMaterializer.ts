import * as path from 'path';
import { fileURLToPath } from 'url';

import { parseBslRoutines } from '../bsl/routineRangeProvider';
import type { BslTextRange } from '../bsl/bslRoutineTypes';
import { captureMergePath } from './merge/mergeSnapshot';
import type { CompareMessage } from './domain/compareContracts';
import { MISSING_TARGET_HASH, type MergeCandidate } from './merge/mergePreview';
import { createCapturedOutputCandidate } from './linkedDesignerPackageWrites';
import { blocked, normalizeAbsolutePath } from './linkedDesignerUtils';
import type { LinkedDesignerMaterializerContext } from './linkedDesignerTypes';

export async function composeBslCandidates(
  input: LinkedDesignerMaterializerContext,
  candidates: readonly MergeCandidate[],
): Promise<{ candidates: MergeCandidate[]; outputs: ReadonlyMap<string, string> } | { diagnostics: CompareMessage[] }> {
  const bslCandidates = candidates.filter((candidate) => candidate.bslRoutine || candidate.logicalRoutine);
  const groups = new Map<string, MergeCandidate[]>();
  for (const candidate of bslCandidates) {
    const targetUri = candidate.bslRoutine?.targetPath ?? candidate.targetUri;
    if (!targetUri) {return { diagnostics: [blocked('BSL-кандидат не содержит целевой путь.', input.targetSourceId, candidate.nodeId)] };}
    let filePath: string;
    try {filePath = fileURLToPath(targetUri);} catch {filePath = targetUri;}
    const key = normalizeAbsolutePath(filePath);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const outputs = new Map<string, string>();
  const writes: MergeCandidate[] = [];
  const passthrough: MergeCandidate[] = [];
  for (const [targetPath, group] of groups) {
    const module = input.modulesByTargetPath?.get(targetPath) ?? input.formModules?.find((item) => normalizeAbsolutePath(path.join(input.targetRootPath, item.targetRelativePath)) === targetPath);
    if (!module || !module.sourceRelativePath || !module.sourceHash) {
      return { diagnostics: [blocked('Compare snapshot не сохранил BSL module context для выбранного изменения.', input.targetSourceId, group[0]!.nodeId)] };
    }
    if (group.some((candidate) => candidate.logicalRoutine)) {
      if (group.length !== 1 || group[0]!.bslRoutine) {
        return { diagnostics: [blocked('Несколько структурных BSL-изменений одного модуля нельзя безопасно совместить с logical routine merge.', input.sourceId, group[0]!.nodeId)] };
      }
      // Logical routine factories validate their own routine anchors and intentionally permit
      // rebasing over unrelated target text. Do not impose the structural whole-file hash here.
      passthrough.push(group[0]!);
      continue;
    }
    if (!module.targetHash || (module.targetContent === undefined && !module.targetMissing)) {
      return { diagnostics: [blocked('Compare snapshot не сохранил BSL module context для выбранного изменения.', input.targetSourceId, group[0]!.nodeId)] };
    }
    const current = await captureMergePath(path.join(input.targetRootPath, module.targetRelativePath), { retainContent: true }).catch(() => ({ state: 'missing' as const }));
    const missingTarget = module.targetMissing === true || module.targetHash === MISSING_TARGET_HASH;
    if (missingTarget) {
      if (current.state !== 'missing') {
        return { diagnostics: [blocked(`BSL module изменился после compare: ${module.targetRelativePath}`, input.targetSourceId, group[0]!.nodeId)] };
      }
    } else if (current.state !== 'file' || current.hash !== module.targetHash || current.contentBase64 === undefined) {
      return { diagnostics: [blocked(`BSL module изменился после compare: ${module.targetRelativePath}`, input.targetSourceId, group[0]!.nodeId)] };
    }
    const captured = missingTarget ? Buffer.alloc(0) : Buffer.from(current.state === 'file' ? current.contentBase64! : '', 'base64');
    let content = captured.toString('utf8');
    const payloads = group.map((candidate) => candidate.bslRoutine).filter((payload): payload is NonNullable<MergeCandidate['bslRoutine']> => Boolean(payload));
    if (missingTarget && payloads.some((payload) => payload.kind !== 'insertRoutine')) {
      return { diagnostics: [blocked('В отсутствующий BSL module можно добавить только явно выбранные процедуры.', input.targetSourceId, group[0]!.nodeId)] };
    }
    const parse = parseBslRoutines(content);
    if (parse.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return { diagnostics: [blocked('Целевой BSL module не прошёл разбор перед сборкой linked writes.', input.targetSourceId, group[0]!.nodeId)] };
    }
    const removals = payloads.filter((payload) => payload.kind === 'deleteRoutine')
      .map((payload) => {
        const routine = parse.routines.find((item) => sameRoutineIdentity(item, payload.routine));
        if (!routine) {return undefined;}
        const envelope = payload.targetTextRange ?? routine.range;
        const offsets = offsetRangeFor(content, envelope);
        const exactEnvelope = offsets ? content.slice(offsets.start, offsets.end) : undefined;
        return { payload, routine, offsets, exactEnvelope };
      });
    if (removals.some((item) => !item || !item.offsets || !item.payload.targetRange
      || !sameRoutineRange(item.routine.range, item.payload.targetRange)
      || (item.payload.targetTextRange !== undefined && item.exactEnvelope !== item.payload.sourceText))) {
      return { diagnostics: [blocked('Выбранную удаляемую BSL-процедуру нельзя однозначно сопоставить с compare snapshot.', input.targetSourceId, group[0]!.nodeId)] };
    }
    for (const removal of [...removals].sort((a, b) => b!.offsets!.start - a!.offsets!.start)) {
      const item = removal!;
      const start = item.offsets!.end === content.length ? removePrecedingLineBreak(content, item.offsets!.start) : item.offsets!.start;
      content = content.slice(0, start) + content.slice(item.offsets!.end);
    }
    for (const payload of payloads.filter((item) => item.kind === 'insertRoutine')) {
      const incoming = parseBslRoutines(payload.sourceText);
      if (incoming.diagnostics.some((diagnostic) => diagnostic.severity === 'error') || incoming.routines.length !== 1 || !sameRoutineIdentity(incoming.routines[0]!, payload.routine)) {
        return { diagnostics: [blocked('Входящая BSL-процедура не соответствует сохранённому routine candidate.', input.sourceId, group.find((candidate) => candidate.bslRoutine === payload)?.nodeId)] };
      }
      const sourceRange = payload.sourceRange;
      if (payload.sourceTextRange) {
        if (!sourceRange || !sameRoutineRange(incoming.routines[0]!.range, shiftRangeToEnvelope(payload.sourceTextRange, sourceRange))) {
          return { diagnostics: [blocked('Входящая BSL-процедура имеет повреждённый envelope capture.', input.sourceId, group.find((candidate) => candidate.bslRoutine === payload)?.nodeId)] };
        }
      }
      const afterDelete = parseBslRoutines(content);
      if (afterDelete.diagnostics.some((diagnostic) => diagnostic.severity === 'error') || afterDelete.routines.some((routine) => sameRoutineIdentity(routine, payload.routine))) {
        return { diagnostics: [blocked('В целевом BSL module уже есть выбранный обработчик или процедура.', input.targetSourceId, group.find((candidate) => candidate.bslRoutine === payload)?.nodeId)] };
      }
      const eol = detectLineEnding(content) ?? detectLineEnding(payload.sourceText) ?? '\n';
      const body = trimTrailingLineBreaks(payload.sourceText).replace(/\r\n|\r|\n/gu, eol);
      content = trimTrailingLineBreaks(content);
      content = content.length === 0 ? body : `${content}${eol}${body}`;
    }
    const finalParse = parseBslRoutines(content);
    if (finalParse.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return { diagnostics: [blocked('Собранный BSL module не прошёл проверку структуры процедур.', input.targetSourceId, group[0]!.nodeId)] };
    }
    const targetRelativePath = module.targetRelativePath;
    const candidate = await createCapturedOutputCandidate(input, {
      nodeId: group[0]!.nodeId,
      targetRelativePath,
      expectedTargetHash: missingTarget ? MISSING_TARGET_HASH : module.targetHash,
      content: Buffer.from(content, 'utf8'),
      witnesses: [
        { sourceId: input.sourceId, relativePath: module.sourceRelativePath, expectedHash: module.sourceHash, kind: 'file' },
        ...group.flatMap((candidate) => candidate.sourceWitnesses ?? []),
      ],
    });
    if (group.length === 1 && group[0]!.bslRoutine && !missingTarget) {
      writes.push(group[0]!);
    } else {
      writes.push(candidate);
    }
    outputs.set(targetPath, content);
  }
  return { candidates: [...writes, ...passthrough], outputs };
}

function shiftRangeToEnvelope(
  envelope: BslTextRange,
  routine: BslTextRange,
): BslTextRange {
  return {
    startLine: routine.startLine - envelope.startLine + 1,
    startColumn: routine.startLine === envelope.startLine ? routine.startColumn - envelope.startColumn + 1 : routine.startColumn,
    endLine: routine.endLine - envelope.startLine + 1,
    endColumn: routine.endColumn,
  };
}

function sameRoutineIdentity(
  routine: { readonly normalizedName: string; readonly kind: string; readonly exported: boolean },
  expected: NonNullable<MergeCandidate['bslRoutine']>['routine'],
): boolean {
  return routine.normalizedName === expected.normalizedName && routine.kind === expected.kind && routine.exported === expected.exported;
}

function sameRoutineRange(
  left: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number },
  right: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number },
): boolean {
  return left.startLine === right.startLine && left.startColumn === right.startColumn && left.endLine === right.endLine && left.endColumn === right.endColumn;
}

function offsetRangeFor(source: string, range: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number }): { start: number; end: number } | undefined {
  const lines = source.split(/\r\n|\r|\n/u);
  const lineStart = (lineNo: number): number | undefined => {
    if (lineNo < 1 || lineNo > lines.length) {return undefined;}
    let offset = 0;
    for (let index = 0; index < lineNo - 1; index += 1) {
      const line = lines[index]!;
      offset += line.length;
      const terminator = source.slice(offset, offset + 2) === '\r\n' ? 2 : source[offset] === '\n' || source[offset] === '\r' ? 1 : 0;
      offset += terminator;
    }
    return offset;
  };
  const startLine = lineStart(range.startLine);
  const endLine = lineStart(range.endLine);
  if (startLine === undefined || endLine === undefined || range.startColumn < 1 || range.endColumn < 1) {return undefined;}
  const start = startLine + range.startColumn - 1;
  const end = endLine + range.endColumn - 1;
  return end >= start && end <= source.length ? { start, end } : undefined;
}

function removePrecedingLineBreak(source: string, start: number): number {
  if (source.slice(start - 2, start) === '\r\n') {return start - 2;}
  if (source[start - 1] === '\n' || source[start - 1] === '\r') {return start - 1;}
  return start;
}

function detectLineEnding(source: string): string | undefined {
  const match = /\r\n|\r|\n/u.exec(source);
  return match?.[0];
}

function trimTrailingLineBreaks(source: string): string {
  return source.replace(/[\r\n]+$/u, '');
}
