import { createHash } from 'crypto';

import {
  BslRoutineDiagnostic,
  BslRoutineInfo,
  BslRoutineKind,
  BslRoutineParseResult,
  BslTextRange,
} from './bslRoutineTypes';

const IDENTIFIER = '[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*';
const DECL_RE = new RegExp(
  `^\\s*(Процедура|Функция|Procedure|Function)\\s+(${IDENTIFIER})\\s*\\(([^)]*)\\)`,
  'i'
);
const INCOMPLETE_DECL_RE = new RegExp(
  `^\\s*(Процедура|Функция|Procedure|Function)\\s+(${IDENTIFIER})\\s*\\(([^)]*)$`,
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

interface MultilineSignature {
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

    const completeDecl = DECL_RE.exec(line);
    const incompleteDecl = completeDecl ? null : INCOMPLETE_DECL_RE.exec(line);
    const decl = completeDecl ?? incompleteDecl;
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
      let missingClosingParen = incompleteDecl !== null;
      let signatureRange = lineRange(lines[index], lineNo);
      let exported = EXPORT_RE.test(line);
      let parameterText = decl[3];
      const startColumn = firstNonWhitespaceColumn(lines[index]);
      if (incompleteDecl) {
        const multilineSignature = readMultilineSignature(
          lines,
          strippedLines,
          index,
          parameterText
        );
        if (multilineSignature) {
          missingClosingParen = false;
          signatureRange = multilineSignature.signatureRange;
          exported = multilineSignature.exported;
          parameterText = multilineSignature.parameterText;
          index = multilineSignature.endIndex;
        }
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

function readMultilineSignature(
  lines: string[],
  strippedLines: string[],
  startIndex: number,
  initialParameterText: string
): MultilineSignature | undefined {
  let depth = 1 + countParenDelta(initialParameterText);
  const parameterLines = [initialParameterText];

  for (let index = startIndex + 1; index < strippedLines.length; index++) {
    const line = strippedLines[index];
    if (END_RE.test(line) || DECL_RE.test(line) || INCOMPLETE_DECL_RE.test(line)) {
      return undefined;
    }

    for (let column = 0; column < line.length; column++) {
      const ch = line[column];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          parameterLines.push(line.slice(0, column));
          return {
            endIndex: index,
            signatureRange: {
              startLine: startIndex + 1,
              startColumn: firstNonWhitespaceColumn(lines[startIndex]),
              endLine: index + 1,
              endColumn: endColumnForLine(lines, index + 1),
            },
            exported: EXPORT_RE.test(line),
            parameterText: parameterLines.join('\n'),
          };
        }
      }
    }

    parameterLines.push(line);
  }

  return undefined;
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

function countParenDelta(text: string): number {
  let delta = 0;
  for (const ch of text) {
    if (ch === '(') {
      delta++;
    } else if (ch === ')') {
      delta--;
    }
  }
  return delta;
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
