import type { BslRoutineInfo, BslTextRange } from '../bsl/bslRoutineTypes';

export interface CapturedBslRoutineSpan {
  readonly sourceText: string;
  readonly routineRange: BslTextRange;
  readonly sourceTextRange: BslTextRange;
}

/** Captures a routine together with directives that the parser associates with it. */
export function captureBslRoutineSpan(source: string, routine: BslRoutineInfo): CapturedBslRoutineSpan | undefined {
  if (isInsideConditional(source, routine.range.startLine)) {return undefined;}
  const lines = splitLines(source);
  let firstLine = routine.range.startLine;
  let cursor = firstLine - 2;
  for (const directive of [...routine.directives].reverse()) {
    while (cursor >= 0 && isCommentOrBlank(lines[cursor]!.text)) {cursor -= 1;}
    if (cursor < 0 || normalizeDirectiveLine(lines[cursor]!.text) !== normalizeDirectiveLine(directive)) {return undefined;}
    firstLine = cursor + 1;
    cursor -= 1;
  }
  let startOffset = lineStartOffset(lines, firstLine);
  let startColumn = 1;
  if (firstLine === 1 && source.startsWith('\uFEFF')) {
    startOffset = startOffset === undefined ? undefined : startOffset + 1;
    startColumn = 2;
  }
  const routineEnd = offsetForPosition(lines, routine.range.endLine, routine.range.endColumn);
  if (startOffset === undefined || routineEnd === undefined || routineEnd <= startOffset) {return undefined;}
  const text = source.slice(startOffset, routineEnd);
  return {
    sourceText: text,
    routineRange: routine.range,
    sourceTextRange: {
      startLine: firstLine,
      startColumn,
      endLine: routine.range.endLine,
      endColumn: routine.range.endColumn,
    },
  };
}

function normalizeDirectiveLine(line: string): string {
  return line.trim().replace(/^\uFEFF/u, '');
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('//');
}

function isInsideConditional(source: string, startLine: number): boolean {
  let depth = 0;
  const lines = source.split(/\r\n|\r|\n/u);
  let inString = false;
  for (let index = 0; index < Math.min(startLine - 1, lines.length); index += 1) {
    const scanned = stripStringsAndComments(lines[index]!, inString);
    inString = scanned.inString;
    const line = scanned.code.trim().replace(/^\uFEFF/u, '');
    if (/^#(?:If|Если)(?:\s|$)/iu.test(line)) {
      depth += 1;
    } else if (/^#(?:EndIf|КонецЕсли)(?:\s|$)/iu.test(line)) {
      if (depth === 0) {return true;}
      depth -= 1;
    }
  }
  return depth > 0;
}

function stripStringsAndComments(line: string, inString: boolean): { code: string; inString: boolean } {
  let code = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (!inString && character === '/' && next === '/') {
      break;
    }
    if (character === '"') {
      if (inString && next === '"') {
        code += '  ';
        index += 1;
        continue;
      }
      inString = !inString;
      code += ' ';
      continue;
    }
    code += inString ? ' ' : character;
  }
  return { code, inString };
}

function splitLines(source: string): Array<{ text: string; start: number; end: number; eolEnd: number }> {
  const result: Array<{ text: string; start: number; end: number; eolEnd: number }> = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gyu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[0] === '' && pattern.lastIndex >= source.length) {break;}
    const text = match[0].replace(/(?:\r\n|\r|\n)$/u, '');
    const end = match.index + text.length;
    result.push({ text, start: match.index, end, eolEnd: pattern.lastIndex });
  }
  return result;
}

function lineStartOffset(lines: readonly { start: number }[], lineNumber: number): number | undefined {
  return lineNumber > 0 ? lines[lineNumber - 1]?.start : undefined;
}

function offsetForPosition(
  lines: readonly { start: number; end: number }[],
  lineNumber: number,
  columnNumber: number,
): number | undefined {
  const line = lines[lineNumber - 1];
  if (!line || columnNumber < 1) {return undefined;}
  const offset = line.start + columnNumber - 1;
  return offset <= line.end ? offset : undefined;
}
