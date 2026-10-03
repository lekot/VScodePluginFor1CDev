import * as fs from 'fs';
import * as path from 'path';
import type { AgentResult } from './types';
import { loadSyntaxHelpDatabase, SyntaxHelpDatabaseError } from './syntaxHelpDatabase';

export type SyntaxHelpSource = 'syntax' | 'standards' | 'all';
export type SyntaxHelpAction = 'search' | 'searchLine' | 'get' | 'children';

export interface SyntaxHelpParams {
  source?: SyntaxHelpSource;
  action?: SyntaxHelpAction;
  query?: string;
  line?: string;
  cursorColumn?: number;
  id?: string | number;
  parentId?: string | number | null;
  limit?: number;
  snippetLength?: number;
}

export interface SyntaxHelpItem {
  id: string;
  source: 'syntax' | 'standards';
  name: string;
  path: string;
  snippet: string;
}

export interface SyntaxHelpChildItem {
  id: string;
  source: 'syntax' | 'standards';
  name: string;
  path: string;
  hasChildren: boolean;
}

export interface SyntaxHelpArticle {
  id: string;
  source: 'syntax' | 'standards';
  name: string;
  path: string;
  markdown: string;
  sourceUrl?: string;
}

interface KnowledgeNode {
  readonly id: string;
  readonly source: 'syntax' | 'standards';
  readonly parentId: string | null;
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly sourceUrl?: string;
  readonly searchName: string;
  readonly searchPath: string;
  readonly searchContent: string;
}

interface StandardsManifest {
  version: number;
  entries: Array<{
    slug: string;
    name: string;
    path: string;
    parentSlug?: string;
    category?: boolean;
    summary: string;
    contentPath?: string;
    sourceUrl?: string;
  }>;
}

type ValidatedSyntaxHelpParams = Omit<SyntaxHelpParams, 'source' | 'action'> & {
  source: SyntaxHelpSource;
} & (
  | { action: 'search' }
  | { action: 'searchLine' }
  | { action: 'get' }
  | { action: 'children' }
);

class KnowledgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

function fold(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU');
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseIdentifier(value: string | number): { source: 'syntax' | 'standards'; key: string } | null {
  const text = String(value).trim();
  const namespaced = /^(syntax|standards):(.+)$/.exec(text);
  if (namespaced) {
    if (namespaced[1] === 'syntax' && /^\d+$/.test(namespaced[2])) {
      return { source: 'syntax', key: namespaced[2] };
    }
    if (namespaced[1] === 'standards' && /^[a-z0-9][a-z0-9-]*$/.test(namespaced[2])) {
      return { source: 'standards', key: namespaced[2] };
    }
    return null;
  }
  return /^\d+$/.test(text) ? { source: 'syntax', key: text } : null;
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const hexadecimal = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function normalizeKnowledgeText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
    .replace(/<\/?(?:a|b|strong|em|i|u|span|font|code|pre|p|div|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|section|article|sup|sub)\b[^>]*>/gi, ' '));
}

function excerpt(text: string, query: string, maxLength: number): string {
  const clean = normalizeKnowledgeText(text).replace(/[\t ]+/g, ' ').replace(/\n+/g, ' ').trim();
  if (clean.length <= maxLength) { return clean; }
  const queryIndex = query ? fold(clean).indexOf(fold(query)) : -1;
  const start = queryIndex < 0
    ? 0
    : Math.max(0, Math.min(queryIndex - Math.floor(maxLength / 3), clean.length - maxLength));
  const prefix = start > 0 ? '…' : '';
  const suffix = start + maxLength < clean.length ? '…' : '';
  return `${prefix}${clean.slice(start, start + maxLength - prefix.length - suffix.length).trim()}${suffix}`;
}

function createNode(
  id: string,
  source: 'syntax' | 'standards',
  parentId: string | null,
  name: string,
  itemPath: string,
  content: string,
  sourceUrl?: string,
): KnowledgeNode {
  return {
    id,
    source,
    parentId,
    name,
    path: itemPath,
    content,
    ...(sourceUrl ? { sourceUrl } : {}),
    searchName: fold(name),
    searchPath: fold(itemPath),
    searchContent: fold(normalizeKnowledgeText(content)),
  };
}

function validateParams(value: unknown): { params?: ValidatedSyntaxHelpParams; error?: KnowledgeError } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'Arguments must be an object.') };
  }
  const params = value as SyntaxHelpParams;
  const allowedKeys = new Set(['source', 'action', 'query', 'line', 'cursorColumn', 'id', 'parentId', 'limit', 'snippetLength']);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'Arguments contain an unsupported property.') };
  }
  const source = params.source ?? 'all';
  const action = params.action ?? 'search';
  if (source !== 'syntax' && source !== 'standards' && source !== 'all') {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'source must be syntax, standards, or all.') };
  }
  if (action !== 'search' && action !== 'searchLine' && action !== 'get' && action !== 'children') {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'action must be search, searchLine, get, or children.') };
  }
  if (params.query !== undefined && (typeof params.query !== 'string' || params.query.trim().length === 0 || params.query.length > 500)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'query must contain 1 to 500 characters.') };
  }
  if (params.line !== undefined && (typeof params.line !== 'string' || params.line.length === 0 || params.line.length > 2000)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'line must contain 1 to 2000 characters.') };
  }
  if (params.cursorColumn !== undefined && (!Number.isSafeInteger(params.cursorColumn) || params.cursorColumn < 0)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'cursorColumn must be a non-negative integer.') };
  }
  if (params.id !== undefined && !((typeof params.id === 'string' && params.id.trim().length > 0 && params.id.length <= 200)
    || (typeof params.id === 'number' && Number.isSafeInteger(params.id) && params.id > 0))) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'id must be a non-empty identifier or positive integer.') };
  }
  if (params.parentId !== undefined && params.parentId !== null && !((typeof params.parentId === 'string'
    && params.parentId.trim().length > 0 && params.parentId.length <= 200)
    || (typeof params.parentId === 'number' && Number.isSafeInteger(params.parentId) && params.parentId > 0))) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'parentId must be null, a non-empty identifier, or a positive integer.') };
  }
  if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'limit must be an integer from 1 to 50.') };
  }
  if (params.snippetLength !== undefined && (!Number.isSafeInteger(params.snippetLength)
    || params.snippetLength < 40 || params.snippetLength > 1000)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'snippetLength must be an integer from 40 to 1000.') };
  }

  if (action === 'search') {
    if (!params.query) { return { error: new KnowledgeError('INVALID_ARGUMENTS', 'query is required for search.') }; }
    if (params.id !== undefined || params.parentId !== undefined || params.line !== undefined || params.cursorColumn !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'search does not accept id, parentId, line, or cursorColumn.') };
    }
  } else if (action === 'searchLine') {
    if (params.line === undefined) { return { error: new KnowledgeError('INVALID_ARGUMENTS', 'line is required for searchLine.') }; }
    if (params.cursorColumn !== undefined && params.cursorColumn > params.line.length) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'cursorColumn cannot exceed the line length.') };
    }
    if (params.query !== undefined || params.id !== undefined || params.parentId !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'searchLine does not accept query, id, or parentId.') };
    }
  } else if (action === 'get') {
    if (params.id !== undefined && params.query !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'get accepts either id or query, not both.') };
    }
    if (params.id === undefined && !params.query) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'get requires id or query.') };
    }
    if (params.parentId !== undefined || params.limit !== undefined || params.snippetLength !== undefined
      || params.line !== undefined || params.cursorColumn !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'parentId, limit, snippetLength, line, and cursorColumn are not valid for get.') };
    }
  } else {
    if (params.id !== undefined || params.query !== undefined || params.snippetLength !== undefined
      || params.line !== undefined || params.cursorColumn !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'id, query, snippetLength, line, and cursorColumn are not valid for children.') };
    }
  }
  return { params: { ...params, source, action } as ValidatedSyntaxHelpParams };
}

function sourceAllows(source: SyntaxHelpSource, candidate: 'syntax' | 'standards'): boolean {
  return source === 'all' || source === candidate;
}

function compareNodes(left: KnowledgeNode, right: KnowledgeNode): number {
  return codepointCompare(fold(left.name), fold(right.name))
    || codepointCompare(left.path, right.path)
    || codepointCompare(left.id, right.id);
}

function rankNode(node: KnowledgeNode, query: string): number | null {
  if (node.searchName === query) { return 0; }
  if (node.searchName.startsWith(query)) { return 1; }
  if (node.searchName.includes(query)) { return 2; }
  if (node.searchPath.includes(query)) { return 3; }
  if (node.searchContent.includes(query)) { return 4; }
  return null;
}

const BSL_KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'each', 'else', 'elseif', 'elsif', 'enddo', 'endif', 'endfunction',
  'endprocedure', 'endtry', 'except', 'export', 'false', 'for', 'function', 'if', 'in', 'new', 'not',
  'null', 'or', 'procedure', 'raise', 'return', 'then', 'to', 'true', 'try', 'undefined', 'val', 'var',
  'while', 'асинх', 'вызватьисключение', 'возврат', 'для', 'каждого', 'из', 'если', 'иначе', 'иначеесли',
  'истина', 'конецесли', 'конецпопытки', 'конецпроцедуры', 'конецфункции', 'конеццикла', 'ложь',
  'неопределено', 'новый', 'по', 'пока', 'попытка', 'прервать', 'продолжить', 'процедура', 'знач',
  'тогда', 'функция', 'цикл', 'экспорт', 'исключение', 'и', 'или', 'не',
]);

const MAX_LINE_TERMS = 8;
const BSL_IDENTIFIER_AT_CURSOR = /[\p{L}_][\p{L}\p{N}_]*/uy;

interface LineIdentifier {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function scanLineIdentifiers(line: string): LineIdentifier[] {
  const identifiers: LineIdentifier[] = [];
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) {
        if (line[index + 1] === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '/' && line[index + 1] === '/') { break; }
    BSL_IDENTIFIER_AT_CURSOR.lastIndex = index;
    const match = BSL_IDENTIFIER_AT_CURSOR.exec(line);
    if (match) {
      identifiers.push({ value: match[0], start: index, end: index + match[0].length });
      index = index + match[0].length - 1;
    }
  }
  return identifiers;
}

function distanceFromCursor(identifier: LineIdentifier, cursorColumn: number): number {
  if (cursorColumn >= identifier.start && cursorColumn <= identifier.end) { return 0; }
  return cursorColumn < identifier.start
    ? identifier.start - cursorColumn
    : cursorColumn - identifier.end;
}

function extractLineTerms(line: string, cursorColumn: number): string[] {
  const identifiers = scanLineIdentifiers(line)
    .filter((identifier) => !BSL_KEYWORDS.has(fold(identifier.value)))
    .sort((left, right) => {
      const distance = distanceFromCursor(left, cursorColumn) - distanceFromCursor(right, cursorColumn);
      if (distance !== 0) { return distance; }
      const leftIsBeforeCursor = left.end <= cursorColumn;
      const rightIsBeforeCursor = right.end <= cursorColumn;
      if (leftIsBeforeCursor !== rightIsBeforeCursor) { return leftIsBeforeCursor ? -1 : 1; }
      return left.start - right.start;
    });
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const identifier of identifiers) {
    const key = fold(identifier.value);
    if (seen.has(key)) { continue; }
    seen.add(key);
    terms.push(identifier.value);
    if (terms.length === MAX_LINE_TERMS) { break; }
  }
  return terms;
}

function publicCandidate(node: KnowledgeNode): SyntaxHelpChildItem {
  return {
    id: node.id,
    source: node.source,
    name: node.name,
    path: node.path,
    hasChildren: false,
  };
}

export class AgentSyntaxHelpOperations {
  private loadedKnowledge: Promise<KnowledgeNode[]> | undefined;

  constructor(private readonly extensionPath: string) {}

  async execute(value: unknown): Promise<AgentResult<unknown>> {
    const validation = validateParams(value);
    if (!validation.params) {
      return { success: false, code: validation.error?.code ?? 'INVALID_ARGUMENTS', error: validation.error?.message };
    }
    const params = validation.params;
    try {
      const nodes = await (this.loadedKnowledge ??= this.loadKnowledge());
      if (params.action === 'search') { return { success: true, data: this.search(nodes, params) }; }
      if (params.action === 'searchLine') { return { success: true, data: this.searchLine(nodes, params) }; }
      if (params.action === 'get') { return this.get(nodes, params); }
      return this.children(nodes, params);
    } catch (error) {
      if (error instanceof KnowledgeError) {
        return { success: false, code: error.code, error: error.message, ...(error.data ? { data: error.data } : {}) };
      }
      if (error instanceof SyntaxHelpDatabaseError) {
        return { success: false, code: error.code, error: error.message };
      }
      return {
        success: false,
        code: 'KNOWLEDGE_RESOURCE_UNAVAILABLE',
        error: 'Syntax help resources could not be loaded.',
      };
    }
  }

  private async loadKnowledge(): Promise<KnowledgeNode[]> {
    const root = path.join(this.extensionPath, 'resources');
    const syntaxNodes = (await loadSyntaxHelpDatabase(this.extensionPath)).map((node) => createNode(
      `syntax:${node.id}`,
      'syntax',
      node.parentId === null ? null : `syntax:${node.parentId}`,
      node.name,
      node.path,
      node.content,
    ));
    const standardsNodes = await this.readStandards(root);
    const allNodes = [...syntaxNodes, ...standardsNodes];
    this.validateHierarchy(allNodes);
    return allNodes;
  }

  private async readStandards(resourcesRoot: string): Promise<KnowledgeNode[]> {
    const standardsRoot = path.join(resourcesRoot, 'standards');
    const manifestPath = path.join(standardsRoot, 'manifest.json');
    let manifest: StandardsManifest;
    try {
      manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as StandardsManifest;
    } catch {
      throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The standards manifest could not be read.');
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The standards manifest has an unexpected format.');
    }

    const entries = new Map<string, StandardsManifest['entries'][number]>();
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.slug)
        || typeof entry.name !== 'string' || !entry.name.trim()
        || typeof entry.path !== 'string' || !entry.path.trim()
        || typeof entry.summary !== 'string' || !entry.summary.trim()
        || entries.has(entry.slug)) {
        throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The standards manifest contains an invalid entry.');
      }
      entries.set(entry.slug, entry);
    }

    const nodes: KnowledgeNode[] = [];
    for (const entry of entries.values()) {
      let content = `# ${entry.name}\n\n${entry.summary}\n`;
      if (entry.contentPath) {
        const relative = entry.contentPath.replace(/\\/g, '/');
        if (path.posix.isAbsolute(relative) || relative.split('/').some((part) => part === '..' || !part)) {
          throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'A standards entry has an invalid content path.');
        }
        const resolved = path.resolve(standardsRoot, relative);
        if (!resolved.startsWith(`${standardsRoot}${path.sep}`)) {
          throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'A standards entry escapes the standards resources.');
        }
        try {
          content = await fs.promises.readFile(resolved, 'utf8');
        } catch {
          throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'A standards article could not be read.');
        }
      }
      if (entry.sourceUrl && !/^https:\/\/its\.1c\.ru\//i.test(entry.sourceUrl)) {
        throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'A standards source link is invalid.');
      }
      nodes.push(createNode(
        `standards:${entry.slug}`,
        'standards',
        entry.parentSlug ? `standards:${entry.parentSlug}` : null,
        entry.name,
        `resources/standards/${entry.path.replace(/\\/g, '/')}`,
        content,
        entry.sourceUrl,
      ));
    }
    return nodes;
  }

  private validateHierarchy(nodes: KnowledgeNode[]): void {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    if (byId.size !== nodes.length) {
      throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'Knowledge resources contain duplicate identifiers.');
    }
    for (const node of nodes) {
      if (node.parentId && !byId.has(node.parentId)) {
        throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'Knowledge resources contain an unresolved parent.');
      }
    }
  }

  private search(nodes: KnowledgeNode[], params: Extract<ValidatedSyntaxHelpParams, { action: 'search' }>): Record<string, unknown> {
    const query = fold(params.query!.trim());
    const selected = nodes
      .filter((node) => sourceAllows(params.source, node.source))
      .map((node) => ({ node, rank: rankNode(node, query) }))
      .filter((entry): entry is { node: KnowledgeNode; rank: number } => entry.rank !== null)
      .sort((left, right) => left.rank - right.rank || compareNodes(left.node, right.node));
    const limit = params.limit ?? 10;
    const snippetLength = params.snippetLength ?? 300;
    return {
      query: params.query!.trim(),
      source: params.source,
      total: selected.length,
      limit,
      hasMore: selected.length > limit,
      items: selected.slice(0, limit).map(({ node }) => ({
        id: node.id,
        source: node.source,
        name: node.name,
        path: node.path,
        snippet: excerpt(node.content, params.query!.trim(), snippetLength),
      } satisfies SyntaxHelpItem)),
    };
  }

  private searchLine(
    nodes: KnowledgeNode[],
    params: Extract<ValidatedSyntaxHelpParams, { action: 'searchLine' }>,
  ): Record<string, unknown> {
    const line = params.line!;
    const terms = extractLineTerms(line, params.cursorColumn ?? line.length);
    const bestMatches = new Map<string, { node: KnowledgeNode; termIndex: number; rank: number; query: string }>();
    terms.forEach((term, termIndex) => {
      const query = fold(term);
      for (const node of nodes) {
        if (!sourceAllows(params.source, node.source)) { continue; }
        const rank = rankNode(node, query);
        if (rank === null) { continue; }
        const existing = bestMatches.get(node.id);
        if (!existing || rank < existing.rank || (rank === existing.rank && termIndex < existing.termIndex)) {
          bestMatches.set(node.id, { node, termIndex, rank, query: term });
        }
      }
    });
    const selected = [...bestMatches.values()].sort((left, right) =>
      left.rank - right.rank || left.termIndex - right.termIndex || compareNodes(left.node, right.node));
    const limit = params.limit ?? 10;
    const snippetLength = params.snippetLength ?? 300;
    return {
      line,
      terms,
      source: params.source,
      total: selected.length,
      limit,
      hasMore: selected.length > limit,
      items: selected.slice(0, limit).map(({ node, query }) => ({
        id: node.id,
        source: node.source,
        name: node.name,
        path: node.path,
        snippet: excerpt(node.content, query, snippetLength),
      } satisfies SyntaxHelpItem)),
    };
  }

  private get(nodes: KnowledgeNode[], params: Extract<ValidatedSyntaxHelpParams, { action: 'get' }>): AgentResult<unknown> {
    let candidates: KnowledgeNode[];
    if (params.id !== undefined) {
      const identifier = parseIdentifier(params.id);
      const candidate = identifier
        ? nodes.find((node) => node.source === identifier.source && node.id === `${identifier.source}:${identifier.key}`)
        : undefined;
      candidates = candidate && sourceAllows(params.source, candidate.source) ? [candidate] : [];
    } else {
      const query = fold(params.query!.trim());
      candidates = nodes.filter((node) => sourceAllows(params.source, node.source)
        && (fold(node.name) === query || fold(node.path) === query || node.id === params.query));
    }
    if (candidates.length === 0) {
      return { success: false, code: 'KNOWLEDGE_ITEM_NOT_FOUND', error: 'Knowledge item was not found.' };
    }
    if (candidates.length > 1) {
      const ordered = [...candidates].sort(compareNodes);
      return {
        success: false,
        code: 'KNOWLEDGE_ITEM_AMBIGUOUS',
        error: 'The exact name matches more than one knowledge item.',
        data: { candidates: ordered.map(publicCandidate) },
      };
    }
    const item = candidates[0];
    const markdownBody = normalizeKnowledgeText(item.content).replace(/^\s+/, '');
    const firstLine = markdownBody.split('\n', 1)[0]?.trim();
    return {
      success: true,
      data: {
        id: item.id,
        source: item.source,
        name: item.name,
        path: item.path,
        markdown: firstLine === `# ${item.name}`
          ? markdownBody
          : `# ${item.name}\n\n${markdownBody}`,
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      },
    };
  }

  private children(nodes: KnowledgeNode[], params: Extract<ValidatedSyntaxHelpParams, { action: 'children' }>): AgentResult<unknown> {
    let parentId: string | null = null;
    if (params.parentId !== undefined && params.parentId !== null) {
      const identifier = parseIdentifier(params.parentId);
      if (!identifier) {
        return { success: false, code: 'KNOWLEDGE_PARENT_NOT_FOUND', error: 'Parent was not found.' };
      }
      const parent = nodes.find((node) => node.source === identifier.source && node.id === `${identifier.source}:${identifier.key}`);
      if (!parent || !sourceAllows(params.source, parent.source)) {
        return { success: false, code: 'KNOWLEDGE_PARENT_NOT_FOUND', error: 'Parent was not found.' };
      }
      parentId = parent.id;
    }
    const children = nodes.filter((node) => sourceAllows(params.source, node.source) && node.parentId === parentId).sort(compareNodes);
    const hasChildren = new Set(nodes.filter((node) => node.parentId !== null).map((node) => node.parentId));
    const limit = params.limit ?? 10;
    return {
      success: true,
      data: {
        parentId,
        source: params.source,
        total: children.length,
        limit,
        hasMore: children.length > limit,
        items: children.slice(0, limit).map((node) => ({
          id: node.id,
          source: node.source,
          name: node.name,
          path: node.path,
          hasChildren: hasChildren.has(node.id),
        } satisfies SyntaxHelpChildItem)),
      },
    };
  }
}
