import { createHash } from 'crypto';

import type { BslRoutineInfo, BslTextRange } from '../../bsl/bslRoutineTypes';
import type {
  BslRoutineLogicalDiagnostic,
  BslRoutineLogicalNode,
  BslRoutineLogicalNodeKind,
  BslRoutineLogicalOutline,
  BslRoutineLogicalScanResult,
  BslRoutineLogicalSection,
} from './bslRoutineMergePlanTypes';

interface ScanInput {
  source: string;
  routine: BslRoutineInfo;
}

interface SourceLine {
  text: string;
  eol: string;
}

interface Frame {
  node: BslRoutineLogicalNode;
  blockKind: 'if' | 'loop' | 'try';
  activeSectionId: string;
}

type Control =
  | { kind: 'start'; nodeKind: 'if' | 'loop' | 'try' }
  | { kind: 'switch'; blockKind: 'if' | 'try'; sectionKind: string }
  | { kind: 'end'; blockKind: 'if' | 'loop' | 'try' }
  | { kind: 'unsupported' };

const ROOT_PATH = 'routine';
const ROOT_SECTION_ID = 'routine/body';

export function scanBslRoutineLogicalOutline(input: ScanInput): BslRoutineLogicalScanResult {
  const sourceLines = splitSourceLines(input.source);
  const eol = detectEol(input.source);
  const outline: BslRoutineLogicalOutline = {
    rootSectionId: ROOT_SECTION_ID,
    routinePath: ROOT_PATH,
    sections: {
      [ROOT_SECTION_ID]: {
        id: ROOT_SECTION_ID,
        parentPath: ROOT_PATH,
        kind: 'body',
        startLine: input.routine.signatureRange.endLine + 1,
        endLine: input.routine.range.endLine - 1,
        nodes: [],
      },
    },
    nodesByPath: {},
  };
  const diagnostics: BslRoutineLogicalDiagnostic[] = [];
  const frames: Frame[] = [];
  let statementStartLine: number | undefined;

  const bodyStartLine = input.routine.signatureRange.endLine + 1;
  const bodyEndLine = input.routine.range.endLine - 1;

  for (let lineNo = bodyStartLine; lineNo <= bodyEndLine; lineNo++) {
    const line = sourceLines[lineNo - 1]?.text ?? '';
    const strippedLine = stripStringsAndComments(line);
    const trimmed = strippedLine.trim();
    const originalTrimmed = line.trim();

    if (originalTrimmed.startsWith('#')) {
      diagnostics.push({
        code: 'preprocessor-directive',
        message: 'Preprocessor directive inside routine body requires manual merge.',
        range: lineRange(line, lineNo),
      });
    }

    const control = detectControl(trimmed);
    if (control.kind !== 'unsupported' && isOneLineBlock(trimmed, control)) {
      diagnostics.push({
        code: 'one-line-block',
        message: 'One-line block syntax requires manual merge.',
        range: lineRange(line, lineNo),
      });
      continue;
    }

    if (control.kind !== 'unsupported' && control.kind !== 'none' && isCompoundControlBoundary(trimmed, control)) {
      diagnostics.push({
        code: 'compound-statement',
        message: 'Compound statement line requires manual merge.',
        range: lineRange(line, lineNo),
      });
    }

    if (control.kind === 'unsupported') {
      diagnostics.push({
        code: 'unsupported-control-flow',
        message: 'Unsupported control flow requires manual merge.',
        range: lineRange(line, lineNo),
      });
    }

    if (control.kind !== 'start' && control.kind !== 'switch' && control.kind !== 'end') {
      if (originalTrimmed.length > 0 && countStatementTerminators(strippedLine) > 1) {
        diagnostics.push({
          code: 'compound-statement',
          message: 'Compound statement line requires manual merge.',
          range: lineRange(line, lineNo),
        });
      }
      if (originalTrimmed.length > 0) {
        statementStartLine ??= lineNo;
      } else {
        flushStatementGroup(outline, sourceLines, activeSection(outline, frames), statementStartLine, lineNo - 1);
        statementStartLine = undefined;
      }
      continue;
    }

    flushStatementGroup(outline, sourceLines, activeSection(outline, frames), statementStartLine, lineNo - 1);
    statementStartLine = undefined;

    if (control.kind === 'start') {
      const section = activeSection(outline, frames);
      const node = appendNode(outline, sourceLines, section, control.nodeKind, lineNo, lineNo);
      const firstSectionKind = control.nodeKind === 'try' ? 'try' : control.nodeKind === 'if' ? 'then' : 'body';
      const firstSection = createSection(outline, node, firstSectionKind, lineNo + 1, bodyEndLine);
      node.sections.push({ id: firstSection.id, kind: firstSection.kind });
      frames.push({
        node,
        blockKind: control.nodeKind,
        activeSectionId: firstSection.id,
      });
      continue;
    }

    const frame = frames[frames.length - 1];
    if (!frame || frame.blockKind !== control.blockKind) {
      diagnostics.push({
        code: 'unmatched-block-end',
        message: 'Block boundary has no matching opener.',
        range: lineRange(line, lineNo),
      });
      continue;
    }

    outline.sections[frame.activeSectionId].endLine = lineNo - 1;

    if (control.kind === 'switch') {
      const section = createSection(outline, frame.node, control.sectionKind, lineNo + 1, bodyEndLine);
      frame.node.sections.push({ id: section.id, kind: section.kind });
      frame.activeSectionId = section.id;
      continue;
    }

    frame.node.range.endLine = lineNo;
    frame.node.range.endColumn = endColumnForLine(sourceLines, lineNo);
    refreshNodeHashes(frame.node, sourceLines);
    frames.pop();
  }

  flushStatementGroup(outline, sourceLines, activeSection(outline, frames), statementStartLine, bodyEndLine);

  for (const frame of frames) {
    diagnostics.push({
      code: 'unclosed-block',
      message: 'Logical block has no matching end keyword.',
      range: frame.node.range,
    });
  }

  return {
    outline,
    diagnostics,
    canAutoMerge: diagnostics.length === 0,
    eol,
  };
}

export function splitSourceLines(source: string): SourceLine[] {
  if (source.length === 0) {
    return [];
  }

  const lines: SourceLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[0] === '') {
      break;
    }
    lines.push({ text: match[1], eol: match[2] });
    if (match[2] === '') {
      break;
    }
  }
  return lines;
}

export function detectEol(source: string): string {
  const match = /\r\n|\n|\r/.exec(source);
  return match?.[0] ?? '\n';
}

export function extractRangeText(source: string, range: BslTextRange): string {
  const lines = splitSourceLines(source);
  const selected = lines.slice(range.startLine - 1, range.endLine);
  return selected
    .map((line, index) => {
      const isLast = index === selected.length - 1;
      return line.text + (isLast ? '' : line.eol);
    })
    .join('');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).digest('hex');
}

export function materialBetweenAnchors(
  source: string,
  routine: BslRoutineInfo,
  startLineInclusive: number,
  endLineInclusive: number
): string {
  if (startLineInclusive > endLineInclusive) {
    return '';
  }
  const safeStart = Math.max(routine.signatureRange.endLine + 1, startLineInclusive);
  const safeEnd = Math.min(routine.range.endLine - 1, endLineInclusive);
  if (safeStart > safeEnd) {
    return '';
  }
  return extractRangeText(source, {
    startLine: safeStart,
    startColumn: 1,
    endLine: safeEnd,
    endColumn: endColumnForLine(splitSourceLines(source), safeEnd),
  });
}

function appendNode(
  outline: BslRoutineLogicalOutline,
  sourceLines: readonly SourceLine[],
  section: BslRoutineLogicalSection,
  kind: BslRoutineLogicalNodeKind,
  startLine: number,
  endLine: number
): BslRoutineLogicalNode {
  const sameKindIndex = section.nodes.filter((node) => node.kind === kind).length;
  const path = `${section.id}/${kind}[${sameKindIndex}]`;
  const node: BslRoutineLogicalNode = {
    kind,
    path,
    parentPath: section.parentPath,
    sectionId: section.id,
    range: {
      startLine,
      startColumn: firstNonWhitespaceColumn(sourceLines[startLine - 1]?.text ?? ''),
      endLine,
      endColumn: endColumnForLine(sourceLines, endLine),
    },
    text: '',
    textHash: '',
    shapeHash: '',
    sections: [],
  };
  refreshNodeHashes(node, sourceLines);
  section.nodes.push(node);
  outline.nodesByPath[path] = node;
  return node;
}

function createSection(
  outline: BslRoutineLogicalOutline,
  node: BslRoutineLogicalNode,
  kind: string,
  startLine: number,
  defaultEndLine: number
): BslRoutineLogicalSection {
  const sameKindCount = node.sections.filter((section) => section.kind === kind).length;
  const id = `${node.path}/${kind}[${sameKindCount}]`;
  const section: BslRoutineLogicalSection = {
    id,
    parentPath: node.path,
    kind,
    startLine,
    endLine: defaultEndLine,
    nodes: [],
  };
  outline.sections[id] = section;
  return section;
}

function activeSection(outline: BslRoutineLogicalOutline, frames: readonly Frame[]): BslRoutineLogicalSection {
  const frame = frames[frames.length - 1];
  return outline.sections[frame?.activeSectionId ?? ROOT_SECTION_ID];
}

function flushStatementGroup(
  outline: BslRoutineLogicalOutline,
  sourceLines: readonly SourceLine[],
  section: BslRoutineLogicalSection,
  startLine: number | undefined,
  endLine: number
): void {
  if (startLine === undefined || startLine > endLine) {
    return;
  }
  appendNode(outline, sourceLines, section, 'statementGroup', startLine, endLine);
}

function refreshNodeHashes(node: BslRoutineLogicalNode, sourceLines: readonly SourceLine[]): void {
  node.text = sourceLines
    .slice(node.range.startLine - 1, node.range.endLine)
    .map((line, index, selected) => line.text + (index === selected.length - 1 ? '' : line.eol))
    .join('');
  node.textHash = hashText(node.text);
  node.shapeHash = hashText(`${node.kind}:${node.sections.map((section) => section.kind).join('|')}`);
}

function detectControl(trimmed: string): Control | { kind: 'none' } {
  if (trimmed.length === 0) {
    return { kind: 'none' };
  }
  if (/^ElsIf\b/i.test(trimmed)) {
    return { kind: 'switch', blockKind: 'if', sectionKind: 'elseif' };
  }
  if (/^(?:ElseIf\b|ИначеЕсли(?:\s|$))/i.test(trimmed)) {
    return { kind: 'switch', blockKind: 'if', sectionKind: 'elseif' };
  }
  if (/^(?:Else\b|Иначе(?:\s|$))/i.test(trimmed)) {
    return { kind: 'switch', blockKind: 'if', sectionKind: 'else' };
  }
  if (/^(?:EndIf\b|КонецЕсли(?:\s|;|$))/i.test(trimmed)) {
    return { kind: 'end', blockKind: 'if' };
  }
  if (/^(?:EndDo\b|КонецЦикла(?:\s|;|$))/i.test(trimmed)) {
    return { kind: 'end', blockKind: 'loop' };
  }
  if (/^(?:Except\b|Исключение(?:\s|$))/i.test(trimmed)) {
    return { kind: 'switch', blockKind: 'try', sectionKind: 'except' };
  }
  if (/^(?:EndTry\b|КонецПопытки(?:\s|;|$))/i.test(trimmed)) {
    return { kind: 'end', blockKind: 'try' };
  }
  if (/^(?:If\b|Если(?:\s|$)).*(?:\bThen\b|Тогда(?:\s|$))/i.test(trimmed)) {
    return { kind: 'start', nodeKind: 'if' };
  }
  if (
    /^(?:For\s+Each\b|Для\s+каждого(?:\s|$)|For\b|Для(?:\s|$)|While\b|Пока(?:\s|$)).*(?:\bDo\b|Цикл(?:\s|$))/i.test(
      trimmed
    )
  ) {
    return { kind: 'start', nodeKind: 'loop' };
  }
  if (/^(?:Try\b|Попытка(?:\s|$))/i.test(trimmed)) {
    return { kind: 'start', nodeKind: 'try' };
  }
  if (/^(?:Goto\b|Перейти(?:\s|$))/i.test(trimmed)) {
    return { kind: 'unsupported' };
  }
  return { kind: 'none' };
}

function isOneLineBlock(trimmed: string, control: Control | { kind: 'none' }): boolean {
  if (control.kind === 'switch' && control.blockKind === 'if' && control.sectionKind === 'elseif') {
    return /;/.test(trimmed);
  }
  if (control.kind !== 'start') {
    return false;
  }
  if (control.nodeKind === 'try') {
    return /;/.test(trimmed) || /\b(Except|Исключение|EndTry|КонецПопытки)\b/i.test(trimmed);
  }
  return /;/.test(trimmed) || /\b(EndIf|КонецЕсли|EndDo|КонецЦикла)\b/i.test(trimmed);
}

function isCompoundControlBoundary(trimmed: string, control: Control): boolean {
  if (
    control.kind === 'switch' &&
    (control.sectionKind === 'else' || control.sectionKind === 'except')
  ) {
    return /\s+\S/.test(trimmed);
  }
  if (control.kind === 'end') {
    return /;\s*\S/.test(trimmed) || (!/;\s*$/.test(trimmed) && /^\S+\s+\S/.test(trimmed));
  }
  return false;
}

function countStatementTerminators(line: string): number {
  const matches = line.match(/;/g);
  return matches?.length ?? 0;
}

function lineRange(line: string, lineNo: number): BslTextRange {
  return {
    startLine: lineNo,
    startColumn: firstNonWhitespaceColumn(line),
    endLine: lineNo,
    endColumn: line.length + 1,
  };
}

function firstNonWhitespaceColumn(line: string): number {
  const match = /\S/.exec(line);
  return match ? match.index + 1 : 1;
}

function endColumnForLine(lines: readonly SourceLine[], lineNo: number): number {
  return (lines[lineNo - 1]?.text ?? '').length + 1;
}

function stripStringsAndComments(line: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    if (!inString && char === '/' && next === '/') {
      break;
    }
    if (char === '"') {
      if (inString && next === '"') {
        result += '  ';
        index++;
        continue;
      }
      inString = !inString;
      result += ' ';
      continue;
    }
    result += inString ? ' ' : char;
  }
  return result;
}
