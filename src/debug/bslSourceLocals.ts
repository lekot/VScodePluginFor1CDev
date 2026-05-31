import { findBslRoutineAtLine } from '../bsl/routineRangeProvider';

export type BslLocalCandidateOrigin = 'parameter' | 'moduleVariable' | 'assignment';

export interface BslLocalCandidate {
    name: string;
    origin: BslLocalCandidateOrigin;
}

const IDENTIFIER = '[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*';
const MODULE_VAR_RE = /^\s*(?:Перем|Var)\s+(.+?)(?:;|$)/i;
const ASSIGNMENT_RE = new RegExp(`^\\s*(${IDENTIFIER})\\s*=`);
const FOR_RE = new RegExp(`^\\s*(?:Для|For)\\s+(${IDENTIFIER})\\s*=`, 'i');
const FOR_EACH_RE = new RegExp(`^\\s*(?:Для\\s+Каждого|For\\s+Each)\\s+(${IDENTIFIER})\\s+(?:Из|In)(?:\\s|$)`, 'i');
const PARAM_PREFIX_RE = /^(?:Знач|Val|ByVal)\s+/i;

const KEYWORDS = new Set([
    'Если',
    'ИначеЕсли',
    'Иначе',
    'Для',
    'Каждого',
    'Пока',
    'Попытка',
    'Исключение',
    'Возврат',
    'Процедура',
    'Функция',
    'Перем',
    'If',
    'ElsIf',
    'Else',
    'For',
    'Each',
    'While',
    'Try',
    'Except',
    'Return',
    'Procedure',
    'Function',
    'Var',
]);

export function extractLocalCandidatesFromBsl(source: string, currentLine: number): BslLocalCandidate[] {
    const lines = source.split(/\r?\n/);
    const safeLine = Math.max(1, Math.min(currentLine, lines.length));
    const stripped = lines.map(stripStringsAndComments);
    const routine = findBslRoutineAtLine(source, safeLine);
    const candidates: BslLocalCandidate[] = [];
    const seen = new Set<string>();

    const add = (name: string, origin: BslLocalCandidateOrigin): void => {
        const normalized = normalizeIdentifier(name);
        if (!normalized || KEYWORDS.has(normalized) || seen.has(normalized.toLowerCase())) {
            return;
        }
        seen.add(normalized.toLowerCase());
        candidates.push({ name: normalized, origin });
    };

    if (routine) {
        for (const param of parseParameters(routine.parameterText)) {
            add(param, 'parameter');
        }
    }

    const moduleVariableEnd = routine ? routine.range.startLine - 1 : safeLine;
    for (let lineNo = 1; lineNo <= moduleVariableEnd; lineNo++) {
        const line = stripped[lineNo - 1];
        const match = MODULE_VAR_RE.exec(line);
        if (!match) {
            continue;
        }
        for (const name of match[1].split(',')) {
            add(name, 'moduleVariable');
        }
    }

    const scanStart = routine ? routine.range.startLine + 1 : 1;
    for (let lineNo = scanStart; lineNo <= safeLine; lineNo++) {
        const line = stripped[lineNo - 1];
        const forEachMatch = FOR_EACH_RE.exec(line);
        if (forEachMatch) {
            add(forEachMatch[1], 'assignment');
        }
        const forMatch = FOR_RE.exec(line);
        if (forMatch) {
            add(forMatch[1], 'assignment');
        }
        const assignmentMatch = ASSIGNMENT_RE.exec(line);
        if (assignmentMatch) {
            add(assignmentMatch[1], 'assignment');
        }
    }

    return candidates;
}

function parseParameters(params: string): string[] {
    if (params.trim() === '') {
        return [];
    }
    return params
        .split(',')
        .map((raw) => raw.split('=')[0].trim().replace(PARAM_PREFIX_RE, '').trim())
        .filter((name) => name.length > 0);
}

function normalizeIdentifier(raw: string): string {
    const trimmed = raw.trim().replace(PARAM_PREFIX_RE, '').trim();
    const match = new RegExp(`^(${IDENTIFIER})`).exec(trimmed);
    return match ? match[1] : '';
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
