import * as vscode from 'vscode';
import {
  BslLocalCompletionIndex,
  type BslLocalRoutineCandidate,
} from './bslLocalCompletionIndex';

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_DOCUMENT_LINES = 20_000;
const MAX_CALLEE_CHARS = 512;
const MAX_SIGNATURE_LABEL_CHARS = 8_192;
const IDENTIFIER = '[\\p{L}_][\\p{L}\\p{N}_]*';

interface CallHead {
  readonly name: string;
  readonly moduleName?: string;
  readonly isConstructor: boolean;
}

interface DelimiterFrame {
  readonly delimiter: '(' | '[';
  readonly callHead?: CallHead;
  argumentIndex: number;
}

interface ActiveCall {
  readonly callHead: CallHead;
  readonly argumentIndex: number;
}

interface SignatureDefinition {
  readonly label: string;
  readonly parameters: readonly { readonly label: string; readonly documentation?: string }[];
  readonly documentation?: string;
}

export type BslSignatureRoutineSource = Pick<
  BslLocalCompletionIndex,
  'getCurrentDocumentRoutines' | 'getCommonModuleRoutines'
>;

export class BslSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly localIndex: BslSignatureRoutineSource = new BslLocalCompletionIndex()) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.SignatureHelpContext,
  ): Promise<vscode.SignatureHelp | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }
    const text = boundedDocumentPrefix(document, position);
    if (text === undefined || isMultilineStringContinuationAt(document, position)) {
      return undefined;
    }
    const activeCall = findActiveCall(text);
    if (!activeCall || token.isCancellationRequested) {
      return undefined;
    }

    const { callHead } = activeCall;
    let definitions: SignatureDefinition[];
    if (callHead.isConstructor) {
      if (callHead.moduleName || !isStructureName(callHead.name)) {
        return undefined;
      }
      definitions = structureSignatures();
    } else if (callHead.moduleName) {
      const routines = await this.localIndex.getCommonModuleRoutines(document, callHead.moduleName, token);
      if (token.isCancellationRequested) {
        return undefined;
      }
      const routine = findRoutine(routines.filter(({ exported }) => exported), callHead.name);
      if (!routine) {
        return undefined;
      }
      definitions = [routineSignature(routine, `Общий модуль ${callHead.moduleName}`)];
    } else {
      const routine = findRoutine(this.localIndex.getCurrentDocumentRoutines(document), callHead.name);
      if (!routine) {
        return undefined;
      }
      definitions = [routineSignature(routine, 'текущий модуль')];
    }

    if (token.isCancellationRequested) {
      return undefined;
    }
    return toSignatureHelp(definitions, activeCall.argumentIndex);
  }
}

export function registerBslSignatureHelpProvider(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  localIndex?: BslSignatureRoutineSource,
): vscode.Disposable {
  const disposable = vscode.languages.registerSignatureHelpProvider(
    { language: 'bsl' },
    new BslSignatureHelpProvider(localIndex),
    '(',
    ',',
  );
  context.subscriptions.push(disposable);
  return disposable;
}

function normalizeIdentifier(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU');
}

function boundedDocumentPrefix(
  document: vscode.TextDocument,
  position: vscode.Position,
): string | undefined {
  if (!Number.isInteger(document.lineCount) || document.lineCount < 1 || document.lineCount > MAX_DOCUMENT_LINES) {
    return undefined;
  }
  if (typeof document.offsetAt !== 'function') {
    return undefined;
  }
  try {
    const lastLineOffset = document.offsetAt(new vscode.Position(document.lineCount - 1, Number.MAX_SAFE_INTEGER));
    if (lastLineOffset > MAX_SOURCE_BYTES) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    if (!Number.isInteger(offset) || offset < 0 || offset > lastLineOffset) {
      return undefined;
    }
    const prefix = document.getText().slice(0, offset);
    return Buffer.byteLength(prefix, 'utf8') <= MAX_SOURCE_BYTES ? prefix : undefined;
  } catch {
    return undefined;
  }
}

function isMultilineStringContinuationAt(document: vscode.TextDocument, position: vscode.Position): boolean {
  try {
    const line = document.lineAt(position.line).text;
    return /^\s*\|/u.test(line);
  } catch {
    return false;
  }
}

function findActiveCall(text: string): ActiveCall | undefined {
  const frames: DelimiterFrame[] = [];
  let inString = false;
  let inLineComment = false;

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inString) {
      if (ch === '"') {
        if (next === '"') {
          index++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      index++;
      continue;
    }
    if (ch === '(') {
      frames.push({ delimiter: '(', callHead: callHeadBefore(text, index), argumentIndex: 0 });
      continue;
    }
    if (ch === '[') {
      frames.push({ delimiter: '[', argumentIndex: 0 });
      continue;
    }
    if (ch === ')' || ch === ']') {
      const expected = ch === ')' ? '(' : '[';
      const frameIndex = findLastDelimiter(frames, expected);
      if (frameIndex >= 0) {
        frames.splice(frameIndex);
      }
      continue;
    }
    if (ch === ',' && frames[frames.length - 1]?.delimiter === '(') {
      (frames[frames.length - 1] as DelimiterFrame).argumentIndex++;
    }
  }

  if (inString || inLineComment) {
    return undefined;
  }
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index];
    if (frame.delimiter !== '(') {
      continue;
    }
    if (frame.callHead) {
      return { callHead: frame.callHead, argumentIndex: frame.argumentIndex };
    }
  }
  return undefined;
}

function findLastDelimiter(frames: readonly DelimiterFrame[], delimiter: '(' | '['): number {
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index].delimiter === delimiter) {
      return index;
    }
  }
  return -1;
}

function callHeadBefore(text: string, openParenIndex: number): CallHead | undefined {
  const before = text.slice(Math.max(0, openParenIndex - MAX_CALLEE_CHARS), openParenIndex);
  const match = new RegExp(`(?:(Новый|New)\\s+)?(${IDENTIFIER})(?:\\s*\\.\\s*(${IDENTIFIER}))?\\s*$`, 'iu')
    .exec(before);
  if (!match) {
    return undefined;
  }
  return {
    name: match[3] ?? match[2],
    ...(match[3] ? { moduleName: match[2] } : {}),
    isConstructor: match[1] !== undefined,
  };
}

function findRoutine(
  routines: readonly BslLocalRoutineCandidate[],
  name: string,
): BslLocalRoutineCandidate | undefined {
  const normalizedName = normalizeIdentifier(name);
  return routines.find((routine) => normalizeIdentifier(routine.name) === normalizedName);
}

function isStructureName(name: string): boolean {
  const normalizedName = normalizeIdentifier(name);
  return normalizedName === normalizeIdentifier('Структура')
    || normalizedName === normalizeIdentifier('Structure');
}

function routineSignature(routine: BslLocalRoutineCandidate, sourceLabel: string): SignatureDefinition {
  const parameters = splitParameters(routine.parameterText).map((parameter) => normalizeWhitespace(parameter));
  const label = `${routine.name}(${parameters.join(', ')})`;
  return {
    label,
    parameters: parameters.map((parameter) => ({ label: parameter })),
    documentation: `${routine.kind === 'function' ? 'Функция' : 'Процедура'} • ${sourceLabel}`,
  };
}

function structureSignatures(): SignatureDefinition[] {
  return [
    {
      label: 'Структура(Ключи, Значение1, …)',
      parameters: [
        { label: 'Ключи', documentation: 'Строка с именами ключей, перечисленными через запятую.' },
        { label: 'Значение1, …', documentation: 'Значение очередного ключа; параметр повторяется для каждого ключа.' },
      ],
      documentation: 'Создаёт структуру и задаёт значения её ключей.',
    },
    {
      label: 'Структура(ФиксированнаяСтруктура)',
      parameters: [
        { label: 'ФиксированнаяСтруктура', documentation: 'Исходная фиксированная структура для копирования свойств.' },
      ],
      documentation: 'Создаёт структуру на основе фиксированной структуры.',
    },
  ];
}

function splitParameters(parameterText: string): string[] {
  if (!parameterText.trim()) {
    return [];
  }
  const parameters: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;

  for (let index = 0; index < parameterText.length; index++) {
    const ch = parameterText[index];
    const next = parameterText[index + 1];
    if (inString) {
      if (ch === '"') {
        if (next === '"') {
          index++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < parameterText.length && parameterText[index] !== '\n') {
        index++;
      }
      continue;
    }
    if (ch === '(') {
      parenDepth++;
    } else if (ch === ')' && parenDepth > 0) {
      parenDepth--;
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
    } else if (ch === '{') {
      braceDepth++;
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth--;
    } else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parameters.push(parameterText.slice(start, index).trim());
      start = index + 1;
    }
  }
  parameters.push(parameterText.slice(start).trim());
  return parameters.filter((parameter) => parameter.length > 0);
}

function normalizeWhitespace(value: string): string {
  let result = '';
  let pendingSpace = false;
  let inString = false;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    const next = value[index + 1];
    if (inString) {
      result += ch;
      if (ch === '"') {
        if (next === '"') {
          result += next;
          index++;
        } else {
          inString = false;
        }
      }
    } else if (ch === '"') {
      if (pendingSpace && result.length > 0) {
        result += ' ';
      }
      pendingSpace = false;
      inString = true;
      result += ch;
    } else if (/\s/u.test(ch)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && result.length > 0) {
        result += ' ';
      }
      pendingSpace = false;
      result += ch;
    }
  }
  return result.trim();
}

function toSignatureHelp(
  definitions: readonly SignatureDefinition[],
  requestedParameter: number,
): vscode.SignatureHelp | undefined {
  if (definitions.length === 0 || definitions.some(({ label }) => label.length > MAX_SIGNATURE_LABEL_CHARS)) {
    return undefined;
  }
  const signatures = definitions.map(({ label, documentation, parameters }) => {
    const signature = new vscode.SignatureInformation(label, documentation);
    signature.parameters = parameters.map(({ label: parameterLabel, documentation: parameterDocumentation }) =>
      new vscode.ParameterInformation(parameterLabel, parameterDocumentation));
    return signature;
  });
  const help = new vscode.SignatureHelp();
  help.signatures = signatures;
  help.activeSignature = 0;
  const parameterCount = signatures[0].parameters.length;
  help.activeParameter = parameterCount === 0 ? 0 : Math.min(requestedParameter, parameterCount - 1);
  return help;
}
