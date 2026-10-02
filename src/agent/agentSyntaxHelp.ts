import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';
import type { AgentResult } from './types';

export type SyntaxHelpSource = 'syntax' | 'standards' | 'all';
export type SyntaxHelpAction = 'search' | 'get' | 'children';

export interface SyntaxHelpParams {
  source?: SyntaxHelpSource;
  action?: SyntaxHelpAction;
  query?: string;
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
  const allowedKeys = new Set(['source', 'action', 'query', 'id', 'parentId', 'limit', 'snippetLength']);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'Arguments contain an unsupported property.') };
  }
  const source = params.source ?? 'all';
  const action = params.action ?? 'search';
  if (source !== 'syntax' && source !== 'standards' && source !== 'all') {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'source must be syntax, standards, or all.') };
  }
  if (action !== 'search' && action !== 'get' && action !== 'children') {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'action must be search, get, or children.') };
  }
  if (params.query !== undefined && (typeof params.query !== 'string' || params.query.trim().length === 0 || params.query.length > 500)) {
    return { error: new KnowledgeError('INVALID_ARGUMENTS', 'query must contain 1 to 500 characters.') };
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
    if (params.id !== undefined || params.parentId !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'id and parentId are only valid for get or children.') };
    }
  } else if (action === 'get') {
    if (params.id !== undefined && params.query !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'get accepts either id or query, not both.') };
    }
    if (params.id === undefined && !params.query) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'get requires id or query.') };
    }
    if (params.parentId !== undefined || params.limit !== undefined || params.snippetLength !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'parentId, limit, and snippetLength are not valid for get.') };
    }
  } else {
    if (params.id !== undefined || params.query !== undefined || params.snippetLength !== undefined) {
      return { error: new KnowledgeError('INVALID_ARGUMENTS', 'id, query, and snippetLength are not valid for children.') };
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
      if (params.action === 'get') { return this.get(nodes, params); }
      return this.children(nodes, params);
    } catch (error) {
      if (error instanceof KnowledgeError) {
        return { success: false, code: error.code, error: error.message, ...(error.data ? { data: error.data } : {}) };
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
    const databasePath = path.join(root, 'help', 'shcntx_help.db');
    const wasmPath = path.join(this.extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    const databaseBytes = await fs.promises.readFile(databasePath);
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const syntaxNodes = this.readSyntaxDatabase(SQL, databaseBytes);
    const standardsNodes = await this.readStandards(root);
    const allNodes = [...syntaxNodes, ...standardsNodes];
    this.validateHierarchy(allNodes);
    return allNodes;
  }

  private readSyntaxDatabase(SQL: SqlJsStatic, bytes: Uint8Array): KnowledgeNode[] {
    let database: SqlDatabase | undefined;
    try {
      database = new SQL.Database(bytes);
      const integrity = database.exec('PRAGMA quick_check');
      if (integrity[0]?.values[0]?.[0] !== 'ok') {
        throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The syntax database failed its integrity check.');
      }
      const rows = database.exec('SELECT id, parent_id, name, path, content FROM nodes ORDER BY id');
      const table = rows[0];
      if (!table || table.columns.join(',') !== 'id,parent_id,name,path,content' || table.values.length === 0) {
        throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The syntax database has an unexpected schema.');
      }
      return table.values.map((row) => {
        const [id, parentId, name, itemPath, content] = row;
        if (typeof id !== 'number' || (parentId !== null && typeof parentId !== 'number')
          || typeof name !== 'string' || typeof itemPath !== 'string' || typeof content !== 'string'
          || !Number.isSafeInteger(id) || id <= 0 || !itemPath || itemPath.startsWith('/') || itemPath.includes('..')) {
          throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The syntax database contains an invalid node.');
        }
        return createNode(
          `syntax:${id}`,
          'syntax',
          parentId === null ? null : `syntax:${parentId}`,
          name,
          itemPath.replace(/\\/g, '/'),
          content,
        );
      });
    } catch (error) {
      if (error instanceof KnowledgeError) { throw error; }
      throw new KnowledgeError('KNOWLEDGE_RESOURCE_INVALID', 'The syntax database could not be read.');
    } finally {
      database?.close();
    }
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
