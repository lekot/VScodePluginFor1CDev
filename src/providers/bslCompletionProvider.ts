import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isBslCompletionIndex,
  type BslCompletionIndex,
  type BslCompletionType,
  type CompletionArticleReference,
} from './bslCompletionIndex';
import { BslLocalCompletionIndex, type BslLocalRoutineCandidate } from './bslLocalCompletionIndex';

const MAX_CONTEXT_LINES = 200;
const MAX_CONTEXT_CHARS = 16_384;

type CompletionKind = 'global' | 'property' | 'method' | 'type';

interface Candidate {
  readonly name: string;
  readonly kind: CompletionKind;
  readonly article: CompletionArticleReference;
}

interface RuntimeIndex {
  readonly globalCandidates: readonly Candidate[];
  readonly globalCandidatesByFirstCharacter: ReadonlyMap<string, readonly Candidate[]>;
  readonly typeCandidates: readonly Candidate[];
  readonly typeCandidatesByFirstCharacter: ReadonlyMap<string, readonly Candidate[]>;
  readonly typesByAlias: ReadonlyMap<string, readonly BslCompletionType[]>;
}

interface MaskedLine {
  readonly text: string;
  readonly ignoredAtEnd: boolean;
}

interface MemberContext {
  readonly receiver?: string;
  readonly filter: string;
  readonly dotOffset: number;
}

interface CompletionContext {
  readonly kind: 'global' | 'type' | 'member';
  readonly prefix: string;
  readonly typeName?: string;
  readonly receiver?: string;
}

interface ReceiverInference {
  readonly typeName?: string;
  readonly assigned: boolean;
}

export type LoadedTypeObjectsResult =
  | { readonly status: 'loaded'; readonly names: readonly string[] }
  | { readonly status: 'notLoaded' };

export interface BslMetadataCompletionReader {
  getLoadedTypeObjectsForResource(resourcePath: string, folderId: string): LoadedTypeObjectsResult;
}

type MetadataCompletionReaderProvider = () => BslMetadataCompletionReader | null | undefined;

const METADATA_COLLECTION_FOLDERS = new Map<string, string>([
  ['документы', 'Documents'],
  ['documents', 'Documents'],
  ['справочники', 'Catalogs'],
  ['catalogs', 'Catalogs'],
  ['регистрысведений', 'InformationRegisters'],
  ['informationregisters', 'InformationRegisters'],
]);

const indexLoads = new Map<string, Promise<RuntimeIndex>>();

function normalizeIdentifier(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU');
}

function firstCharacter(value: string): string {
  return Array.from(normalizeIdentifier(value))[0] ?? '';
}

function groupByFirstCharacter(candidates: readonly Candidate[]): ReadonlyMap<string, readonly Candidate[]> {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const first = firstCharacter(candidate.name);
    const bucket = grouped.get(first) ?? [];
    bucket.push(candidate);
    grouped.set(first, bucket);
  }
  return grouped;
}

function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = normalizeIdentifier(candidate.name);
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

function createRuntimeIndex(index: BslCompletionIndex): RuntimeIndex {
  const globalArticle = index.global.article;
  const globalCandidates = uniqueCandidates([
    ...index.global.properties.map((name) => ({ name, kind: 'global' as const, article: globalArticle })),
    ...index.global.methods.map((name) => ({ name, kind: 'global' as const, article: globalArticle })),
  ]);
  const typeCandidates = uniqueCandidates(index.types.flatMap((type) => type.aliases.map((name) => ({
    name,
    kind: 'type' as const,
    article: type.article,
  }))));
  const mutableTypesByAlias = new Map<string, BslCompletionType[]>();
  for (const type of index.types) {
    for (const alias of type.aliases) {
      const key = normalizeIdentifier(alias);
      const types = mutableTypesByAlias.get(key) ?? [];
      if (!types.some(({ article }) => article.id === type.article.id)) {
        types.push(type);
        mutableTypesByAlias.set(key, types);
      }
    }
  }
  return {
    globalCandidates,
    globalCandidatesByFirstCharacter: groupByFirstCharacter(globalCandidates),
    typeCandidates,
    typeCandidatesByFirstCharacter: groupByFirstCharacter(typeCandidates),
    typesByAlias: mutableTypesByAlias,
  };
}

/** Reads the compact index once per extension installation; no SQLite/WASM work is done here. */
export function loadBslCompletionIndex(extensionPath: string): Promise<RuntimeIndex> {
  const cacheKey = path.resolve(extensionPath);
  const cached = indexLoads.get(cacheKey);
  if (cached) {
    return cached;
  }
  const indexPath = path.join(cacheKey, 'resources', 'help', 'bsl-completion-index.json');
  const loading = fs.promises.readFile(indexPath, 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .then((value) => {
      if (!isBslCompletionIndex(value)) {
        throw new Error('The BSL completion index has an unexpected format.');
      }
      return createRuntimeIndex(value);
    });
  indexLoads.set(cacheKey, loading);
  void loading.catch(() => {
    if (indexLoads.get(cacheKey) === loading) {
      indexLoads.delete(cacheKey);
    }
  });
  return loading;
}

/** Masks strings and `//` comments without changing code-unit offsets. */
function maskLine(source: string): MaskedLine {
  const masked = source.split('');
  let inString = false;
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (inComment) {
      masked[index] = ' ';
      continue;
    }
    if (inString) {
      if (current === '"' && source[index + 1] === '"') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
      } else if (current === '"') {
        masked[index] = ' ';
        inString = false;
      } else {
        masked[index] = ' ';
      }
      continue;
    }
    if (current === '"') {
      masked[index] = ' ';
      inString = true;
    } else if (current === '/' && source[index + 1] === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      inComment = true;
      index += 1;
    }
  }
  return { text: masked.join(''), ignoredAtEnd: inString || inComment };
}

function memberContext(prefix: string): MemberContext | undefined {
  const match = /\.\s*([\p{L}_][\p{L}\p{N}_]*)?$/u.exec(prefix);
  if (!match) {
    return undefined;
  }
  const dotOffset = match.index;
  const receiverText = prefix.slice(0, dotOffset).trimEnd();
  const statementStart = Math.max(receiverText.lastIndexOf(';'), receiverText.lastIndexOf('\n'), receiverText.lastIndexOf('\r')) + 1;
  const receiverExpression = receiverText.slice(statementStart).trim();
  const receiver = /^([\p{L}_][\p{L}\p{N}_]*)$/u.exec(receiverExpression)?.[1];
  return { ...(receiver ? { receiver } : {}), filter: match[1] ?? '', dotOffset };
}

function directConstructorType(prefix: string, member: MemberContext): string | undefined {
  const expression = prefix.slice(0, member.dotOffset).trimEnd();
  if (!expression.endsWith(')')) {
    return undefined;
  }
  let depth = 0;
  let opening = -1;
  for (let index = expression.length - 1; index >= 0; index -= 1) {
    if (expression[index] === ')') {
      depth += 1;
    } else if (expression[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        opening = index;
        break;
      }
    }
  }
  if (opening < 0) {
    return undefined;
  }
  const beforeCall = expression.slice(0, opening);
  return /(?:^|[^\p{L}\p{N}_])(?:Новый|New)\s+([\p{L}_][\p{L}\p{N}_]*)\s*$/iu.exec(beforeCall)?.[1];
}

function completionContext(prefix: string): CompletionContext | undefined {
  const masked = maskLine(prefix);
  if (masked.ignoredAtEnd) {
    return undefined;
  }
  const member = memberContext(masked.text);
  if (member) {
    const typeName = directConstructorType(masked.text, member);
    return {
      kind: 'member',
      prefix: member.filter,
      ...(typeName ? { typeName } : {}),
      ...(member.receiver ? { receiver: member.receiver } : {}),
    };
  }
  const typeContext = /(?:^|[^\p{L}\p{N}_])(?:Новый|New)\s+([\p{L}_][\p{L}\p{N}_]*)?$/iu.exec(masked.text);
  if (typeContext) {
    return { kind: 'type', prefix: typeContext[1] ?? '' };
  }
  const currentWord = /([\p{L}_][\p{L}\p{N}_]*)?$/u.exec(masked.text)?.[1] ?? '';
  return { kind: 'global', prefix: currentWord };
}

function isMultilineStringContinuationLine(line: string): boolean {
  const scanLength = Math.min(line.length, MAX_CONTEXT_CHARS);
  const firstNonWhitespace = line.slice(0, scanLength).search(/\S/u);
  if (firstNonWhitespace >= 0) {
    return line[firstNonWhitespace] === '|';
  }
  return line.length > scanLength;
}

function currentProcedureBoundary(line: string): 'start' | 'end' | undefined {
  const trimmed = maskLine(line).text.trimStart();
  if (/^(?:Процедура|Функция|procedure|function)(?=\s|\()/iu.test(trimmed)) {
    return 'start';
  }
  if (/^(?:КонецПроцедуры|КонецФункции|endprocedure|endfunction)(?=\s|;|$)/iu.test(trimmed)) {
    return 'end';
  }
  return undefined;
}

function inferredTypeForReceiver(
  document: vscode.TextDocument,
  position: vscode.Position,
  currentLinePrefix: string,
  receiver: string,
): ReceiverInference {
  if (currentLinePrefix.length > MAX_CONTEXT_CHARS) {
    return { assigned: false };
  }
  const reverseLines = [currentLinePrefix];
  let characters = currentLinePrefix.length;
  let foundProcedureStart = false;
  const firstLine = position.line;
  const oldestLine = Math.max(0, firstLine - MAX_CONTEXT_LINES + 1);
  for (let lineNumber = firstLine - 1; lineNumber >= oldestLine; lineNumber -= 1) {
    const line = document.lineAt(lineNumber).text;
    if (characters + line.length + 1 > MAX_CONTEXT_CHARS) {
      break;
    }
    reverseLines.push(line);
    characters += line.length + 1;
    const boundary = currentProcedureBoundary(line);
    if (boundary === 'end') {
      return { assigned: false };
    }
    if (boundary === 'start') {
      foundProcedureStart = true;
      break;
    }
  }
  if (!foundProcedureStart) {
    return { assigned: false };
  }

  const assignments = new Map<string, string>();
  const assignedVariables = new Set<string>();
  for (const rawLine of reverseLines.reverse()) {
    const line = maskLine(rawLine).text;
    for (const statement of line.split(';')) {
      const assignment = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=\s*([\s\S]*)$/u.exec(statement);
      if (!assignment) {
        continue;
      }
      const variable = normalizeIdentifier(assignment[1]);
      assignedVariables.add(variable);
      const constructor = /^\s*(?:Новый|New)\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(/iu.exec(assignment[2]);
      if (constructor) {
        assignments.set(variable, normalizeIdentifier(constructor[1]));
      } else {
        assignments.delete(variable);
      }
    }
  }
  const normalizedReceiver = normalizeIdentifier(receiver);
  const typeName = assignments.get(normalizedReceiver);
  return {
    ...(typeName ? { typeName } : {}),
    assigned: assignedVariables.has(normalizedReceiver),
  };
}

function matchingCandidates(
  prefix: string,
  all: readonly Candidate[],
  byFirstCharacter: ReadonlyMap<string, readonly Candidate[]>,
): Candidate[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  const candidates = foldedPrefix
    ? byFirstCharacter.get(firstCharacter(foldedPrefix)) ?? []
    : all;
  return candidates.filter(({ name }) => normalizeIdentifier(name).startsWith(foldedPrefix));
}

function toCompletionItem(candidate: Candidate): vscode.CompletionItem {
  const kind = candidate.kind === 'method'
    ? vscode.CompletionItemKind.Method
    : candidate.kind === 'property'
      ? vscode.CompletionItemKind.Property
      : candidate.kind === 'type'
        ? vscode.CompletionItemKind.Class
        : vscode.CompletionItemKind.Variable;
  const item = new vscode.CompletionItem(candidate.name, kind);
  item.insertText = candidate.name;
  item.detail = candidate.kind === 'method'
    ? `Метод платформы • ${candidate.article.name}`
    : candidate.kind === 'property'
      ? `Свойство платформы • ${candidate.article.name}`
      : candidate.kind === 'type'
        ? 'Тип платформы с конструктором'
        : 'Глобальное имя платформы';
  item.documentation = `Статья справки платформы: «${candidate.article.name}» (syntax:${candidate.article.id}, ${candidate.article.path}).`;
  item.sortText = normalizeIdentifier(candidate.name);
  return item;
}

function hasUnsafeParameterControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code <= 8) || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function toLocalRoutineCompletionItem(
  candidate: BslLocalRoutineCandidate,
  sourceLabel: string,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    candidate.name,
    candidate.kind === 'function' ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Method,
  );
  item.insertText = candidate.name;
  const kindLabel = candidate.kind === 'function' ? 'Функция' : 'Процедура';
  const parameterText = candidate.parameterText;
  const safeParameterText = parameterText.length <= 160
    && !hasUnsafeParameterControlCharacters(parameterText)
    ? parameterText.replace(/\s+/gu, ' ').trim()
    : '';
  item.detail = safeParameterText
    ? `${kindLabel} • ${sourceLabel} • Параметры: ${safeParameterText}`
    : `${kindLabel} • ${sourceLabel}`;
  item.sortText = normalizeIdentifier(candidate.name);
  return item;
}

function toMetadataCompletionItem(name: string, folderId: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
  item.insertText = name;
  item.detail = `Объект метаданных • ${folderId}`;
  item.sortText = normalizeIdentifier(name);
  return item;
}

function metadataFolderForReceiver(receiver: string): string | undefined {
  return METADATA_COLLECTION_FOLDERS.get(normalizeIdentifier(receiver));
}

function localRoutineCompletionItems(
  prefix: string,
  routines: readonly BslLocalRoutineCandidate[],
  sourceLabel: string,
): vscode.CompletionItem[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  return routines
    .filter(({ name }) => normalizeIdentifier(name).startsWith(foldedPrefix))
    .map((routine) => toLocalRoutineCompletionItem(routine, sourceLabel));
}

function metadataCompletionItems(prefix: string, names: readonly string[], folderId: string): vscode.CompletionItem[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  return names
    .filter((name) => normalizeIdentifier(name).startsWith(foldedPrefix))
    .map((name) => toMetadataCompletionItem(name, folderId));
}

function candidatesForType(type: BslCompletionType): Candidate[] {
  return [
    ...type.properties.map((name) => ({ name, kind: 'property' as const, article: type.article })),
    ...type.methods.map((name) => ({ name, kind: 'method' as const, article: type.article })),
  ];
}

export class BslCompletionProvider implements vscode.CompletionItemProvider {
  private loadedIndex: Promise<RuntimeIndex> | undefined;
  private readonly localIndex = new BslLocalCompletionIndex();

  constructor(
    private readonly extensionPath: string,
    private readonly getMetadataCompletionReader?: MetadataCompletionReaderProvider,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }
    if (position.character > MAX_CONTEXT_CHARS) {
      return [];
    }
    const currentLine = document.lineAt(position.line).text;
    if (isMultilineStringContinuationLine(currentLine)) {
      return undefined;
    }
    const character = Math.min(position.character, currentLine.length);
    const currentLinePrefix = currentLine.slice(0, character);
    const context = completionContext(currentLinePrefix);
    if (!context) {
      return undefined;
    }

    let inferredTypeName = context.typeName;
    if (context.kind === 'member' && !inferredTypeName) {
      const receiver = context.receiver;
      const metadataFolder = receiver ? metadataFolderForReceiver(receiver) : undefined;
      if (metadataFolder) {
        const resourcePath = document.uri.scheme === 'file' ? document.uri.fsPath : '';
        if (!resourcePath || token.isCancellationRequested) {
          return token.isCancellationRequested ? undefined : [];
        }
        try {
          const result = this.getMetadataCompletionReader?.()?.getLoadedTypeObjectsForResource(resourcePath, metadataFolder);
          if (token.isCancellationRequested) {
            return undefined;
          }
          return result?.status === 'loaded'
            ? metadataCompletionItems(context.prefix, result.names, metadataFolder)
            : [];
        } catch {
          return [];
        }
      }
      const receiverInference = receiver
        ? inferredTypeForReceiver(document, position, currentLinePrefix, receiver)
        : { assigned: false };
      inferredTypeName = receiverInference.typeName;
      if (!inferredTypeName) {
        if (!receiver || receiverInference.assigned) {
          return [];
        }
        const routines = await this.localIndex.getCommonModuleRoutines(document, receiver, token);
        if (token.isCancellationRequested) {
          return undefined;
        }
        return localRoutineCompletionItems(context.prefix, routines, `Общий модуль ${receiver}`);
      }
    }

    try {
      const index = await (this.loadedIndex ??= loadBslCompletionIndex(this.extensionPath));
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (context.kind === 'global') {
        const platformItems = matchingCandidates(
          context.prefix,
          index.globalCandidates,
          index.globalCandidatesByFirstCharacter,
        ).map(toCompletionItem);
        const seenNames = new Set(platformItems.map(({ label }) => normalizeIdentifier(String(label))));
        const localItems = localRoutineCompletionItems(context.prefix, this.localIndex.getCurrentDocumentRoutines(document), 'текущий модуль')
          .filter(({ label }) => !seenNames.has(normalizeIdentifier(String(label))));
        return [...platformItems, ...localItems];
      }
      if (context.kind === 'type') {
        return matchingCandidates(context.prefix, index.typeCandidates, index.typeCandidatesByFirstCharacter)
          .map(toCompletionItem);
      }
      const types = index.typesByAlias.get(normalizeIdentifier(inferredTypeName ?? ''));
      if (!types || types.length !== 1) {
        return [];
      }
      const members = uniqueCandidates(candidatesForType(types[0]));
      return matchingCandidates(context.prefix, members, groupByFirstCharacter(members)).map(toCompletionItem);
    } catch {
      this.loadedIndex = undefined;
      return undefined;
    }
  }
}

/** Registers and tracks the BSL completion provider for extension deactivation. */
export function registerBslCompletionProvider(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  extensionPath: string,
  getMetadataCompletionReader?: MetadataCompletionReaderProvider,
): vscode.Disposable {
  const disposable = vscode.languages.registerCompletionItemProvider(
    { language: 'bsl' },
    new BslCompletionProvider(extensionPath, getMetadataCompletionReader),
    '.',
  );
  context.subscriptions.push(disposable);
  return disposable;
}
