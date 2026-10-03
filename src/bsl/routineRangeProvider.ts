import { createHash } from 'crypto';

import {
  BslRoutineDiagnostic,
  BslRoutineInfo,
  BslRoutineKind,
  BslRoutineParseResult,
  BslTextRange,
} from './bslRoutineTypes';

const IDENTIFIER = '[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*';
const DECL_HEAD_RE = new RegExp(
  `^\\s*(Процедура|Функция|Procedure|Function)\\s+(${IDENTIFIER})\\s*\\(`,
  'i'
);
const END_RE = /^\s*(КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)(?:\s|$)/i;
const EXPORT_RE = /\)\s*(?:(?:Экспорт)(?:\s|$)|Export\b)/i;

interface OpenRoutine {
  name: string;
  normalizedName: string;
  kind: BslRoutineKind;
  startLine: number;
  startColumn: number;
  signatureRange: BslTextRange;
  exported: boolean;
  directives: string[];
  parameterText: string;
}

interface RoutineSignature {
  complete: boolean;
  endIndex: number;
  signatureRange: BslTextRange;
  exported: boolean;
  parameterText: string;
}

export function parseBslRoutines(source: string): BslRoutineParseResult {
  const lines = source.split(/\r?\n/);
  if (source === '') {
    return { routines: [], diagnostics: [] };
  }

  const strippedLines = lines.map(stripStringsAndComments);
  const routines: BslRoutineInfo[] = [];
  const diagnostics: BslRoutineDiagnostic[] = [];
  const routinesByName = new Map<string, BslRoutineInfo>();
  let pendingDirectives: string[] = [];
  let active: OpenRoutine | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = strippedLines[index];
    const lineNo = index + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('&')) {
      pendingDirectives.push(lines[index].trim());
      continue;
    }

    const decl = DECL_HEAD_RE.exec(line);
    if (decl) {
      if (active) {
        diagnostics.push({
          code: 'nested-routine',
          severity: 'error',
          message: `Routine "${decl[2]}" starts before "${active.name}" is closed.`,
          range: lineRange(lines[index], lineNo),
          routineName: decl[2],
        });
        routines.push(closeRoutine(active, lines, lineNo - 1));
      }

      const kind = parseRoutineKind(decl[1]);
      const signature = readRoutineSignature(lines, strippedLines, index, decl[0].length);
      const missingClosingParen = !signature.complete;
      const signatureRange = signature.complete
        ? signature.signatureRange
        : lineRange(lines[index], lineNo);
      const exported = signature.complete && signature.exported;
      const parameterText = signature.parameterText;
      const startColumn = firstNonWhitespaceColumn(lines[index]);
      if (signature.complete) {
        index = signature.endIndex;
      }
      active = {
        name: decl[2],
        normalizedName: decl[2].toLowerCase(),
        kind,
        startLine: lineNo,
        startColumn,
        signatureRange,
        exported,
        directives: pendingDirectives,
        parameterText,
      };
      if (missingClosingParen) {
        diagnostics.push({
          code: 'unclosed-routine',
          severity: 'error',
          message: `Routine "${decl[2]}" declaration is incomplete: missing closing ")".`,
          range: lineRange(lines[index], lineNo),
          routineName: decl[2],
        });
      }
      pendingDirectives = [];
      continue;
    }

    const end = END_RE.exec(line);
    if (end) {
      if (active) {
        routines.push(closeRoutine(active, lines, lineNo));
        active = undefined;
      } else {
        diagnostics.push({
          code: 'unexpected-end',
          severity: 'error',
          message: `End keyword "${end[1]}" has no matching routine declaration.`,
          range: lineRange(lines[index], lineNo),
        });
      }
      pendingDirectives = [];
      continue;
    }

    if (trimmed.length > 0) {
      pendingDirectives = [];
    }
  }

  if (active) {
    diagnostics.push({
      code: 'unclosed-routine',
      severity: 'error',
      message: `Routine "${active.name}" has no closing end keyword.`,
      range: active.signatureRange,
      routineName: active.name,
    });
    routines.push(closeRoutine(active, lines, lines.length));
  }

  for (const routine of routines) {
    const duplicate = routinesByName.get(routine.normalizedName);
    if (duplicate) {
      diagnostics.push({
        code: 'duplicate-routine',
        severity: 'error',
        message: `Routine "${routine.name}" duplicates "${duplicate.name}".`,
        range: routine.signatureRange,
        routineName: routine.name,
      });
    } else {
      routinesByName.set(routine.normalizedName, routine);
    }
  }

  return { routines, diagnostics };
}

export function findBslRoutineAtLine(source: string, line: number): BslRoutineInfo | undefined {
  const result = parseBslRoutines(source);
  return result.routines.find(
    (routine) => line >= routine.range.startLine && line <= routine.range.endLine
  );
}

function readRoutineSignature(
  lines: string[],
  strippedLines: string[],
  startIndex: number,
  parameterStartColumn: number,
): RoutineSignature {
  let depth = 1;
  const parameterParts: string[] = [];

  for (let index = startIndex; index < strippedLines.length; index++) {
    const line = strippedLines[index];
    if (index > startIndex && (END_RE.test(line) || DECL_HEAD_RE.test(line))) {
      break;
    }

    const startColumn = index === startIndex ? parameterStartColumn : 0;
    for (let column = startColumn; column < line.length; column++) {
      const ch = line[column];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          parameterParts.push(lines[index].slice(startColumn, column));
          return {
            complete: true,
            endIndex: index,
            signatureRange: {
              startLine: startIndex + 1,
              startColumn: firstNonWhitespaceColumn(lines[startIndex]),
              endLine: index + 1,
              endColumn: endColumnForLine(lines, index + 1),
            },
            exported: EXPORT_RE.test(line),
            parameterText: stripCommentsPreservingStrings(parameterParts.join('\n')).trim(),
          };
        }
      }
    }

    parameterParts.push(lines[index].slice(startColumn));
  }

  return {
    complete: false,
    endIndex: startIndex,
    signatureRange: lineRange(lines[startIndex], startIndex + 1),
    exported: false,
    parameterText: stripCommentsPreservingStrings(parameterParts.join('\n')).trim(),
  };
}

function closeRoutine(active: OpenRoutine, lines: string[], endLine: number): BslRoutineInfo {
  const safeEndLine = Math.max(active.startLine, Math.min(endLine, lines.length));
  const range = {
    startLine: active.startLine,
    startColumn: active.startColumn,
    endLine: safeEndLine,
    endColumn: endColumnForLine(lines, safeEndLine),
  };
  const bodyStartLine = active.signatureRange.endLine + 1;
  const bodyEndLine = Math.max(bodyStartLine, safeEndLine - 1);
  const bodyRange =
    bodyStartLine > safeEndLine - 1
      ? zeroWidthRange(bodyStartLine)
      : {
          startLine: bodyStartLine,
          startColumn: 1,
          endLine: bodyEndLine,
          endColumn: endColumnForLine(lines, bodyEndLine),
        };

  return {
    name: active.name,
    normalizedName: active.normalizedName,
    kind: active.kind,
    range,
    signatureRange: active.signatureRange,
    bodyRange,
    bodyHash: hashBody(lines, active.signatureRange.endLine + 1, safeEndLine - 1),
    exported: active.exported,
    directives: active.directives,
    parameterText: active.parameterText,
  };
}

function parseRoutineKind(keyword: string): BslRoutineKind {
  return /^Функция$/i.test(keyword) || /^Function$/i.test(keyword) ? 'function' : 'procedure';
}

function hashBody(lines: string[], startLine: number, endLine: number): string {
  if (startLine > endLine) {
    return createHash('sha256').update('').digest('hex');
  }
  return createHash('sha256')
    .update(lines.slice(startLine - 1, endLine).join('\n'))
    .digest('hex');
}

function lineRange(line: string, lineNo: number): BslTextRange {
  return {
    startLine: lineNo,
    startColumn: firstNonWhitespaceColumn(line),
    endLine: lineNo,
    endColumn: line.length + 1,
  };
}

function zeroWidthRange(lineNo: number): BslTextRange {
  return {
    startLine: lineNo,
    startColumn: 1,
    endLine: lineNo,
    endColumn: 1,
  };
}

function firstNonWhitespaceColumn(line: string): number {
  const match = /\S/.exec(line);
  return match ? match.index + 1 : 1;
}

function endColumnForLine(lines: string[], lineNo: number): number {
  const line = lines[lineNo - 1] ?? '';
  return line.length + 1;
}

function stripStringsAndComments(line: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (!inString && ch === '/' && next === '/') {
      break;
    }
    if (ch === '"') {
      if (inString && next === '"') {
        result += '  ';
        i++;
        continue;
      }
      inString = !inString;
      result += ' ';
      continue;
    }
    result += inString ? ' ' : ch;
  }
  return result;
}

function stripCommentsPreservingStrings(text: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    const next = text[index + 1];
    if (!inString && ch === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index++;
      }
      if (index < text.length) {
        result += '\n';
      }
      continue;
    }
    if (ch === '"') {
      if (inString && next === '"') {
        result += '""';
        index++;
        continue;
      }
      inString = !inString;
    }
    result += ch;
  }
  return result;
}
