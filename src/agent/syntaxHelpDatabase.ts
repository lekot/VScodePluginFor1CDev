import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';

export interface SyntaxHelpDatabaseNode {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly renderedContent?: string;
}

export class SyntaxHelpDatabaseError extends Error {
  readonly code = 'KNOWLEDGE_RESOURCE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SyntaxHelpDatabaseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const databaseLoads = new Map<string, Promise<readonly SyntaxHelpDatabaseNode[]>>();

/** Loads and validates the bundled platform syntax database once per extension installation. */
export function loadSyntaxHelpDatabase(extensionPath: string): Promise<readonly SyntaxHelpDatabaseNode[]> {
  const cacheKey = path.resolve(extensionPath);
  const cached = databaseLoads.get(cacheKey);
  if (cached) {
    return cached;
  }

  const loading = readSyntaxHelpDatabase(cacheKey);
  databaseLoads.set(cacheKey, loading);
  void loading.catch(() => {
    if (databaseLoads.get(cacheKey) === loading) {
      databaseLoads.delete(cacheKey);
    }
  });
  return loading;
}

async function readSyntaxHelpDatabase(extensionPath: string): Promise<readonly SyntaxHelpDatabaseNode[]> {
  const databasePath = path.join(extensionPath, 'resources', 'help', 'shcntx_help.db');
  const wasmPath = path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const databaseBytes = await fs.promises.readFile(databasePath);
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  return readNodes(SQL, databaseBytes);
}

function readNodes(SQL: SqlJsStatic, bytes: Uint8Array): readonly SyntaxHelpDatabaseNode[] {
  let database: SqlDatabase | undefined;
  try {
    database = new SQL.Database(bytes);
    const integrity = database.exec('PRAGMA quick_check');
    if (integrity[0]?.values[0]?.[0] !== 'ok') {
      throw new SyntaxHelpDatabaseError('The syntax database failed its integrity check.');
    }
    const hasArticleMarkdown = database.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'article_markdown'",
    )[0]?.values.length === 1;
    const rows = database.exec(hasArticleMarkdown
      ? 'SELECT n.id, n.parent_id, n.name, n.path, n.content, a.markdown FROM nodes AS n LEFT JOIN article_markdown AS a ON a.node_id = n.id ORDER BY n.id'
      : 'SELECT id, parent_id, name, path, content FROM nodes ORDER BY id');
    const table = rows[0];
    const expectedColumns = hasArticleMarkdown
      ? 'id,parent_id,name,path,content,markdown'
      : 'id,parent_id,name,path,content';
    if (!table || table.columns.join(',') !== expectedColumns || table.values.length === 0) {
      throw new SyntaxHelpDatabaseError('The syntax database has an unexpected schema.');
    }
    return table.values.map((row) => {
      const [id, parentId, name, itemPath, content, renderedContent] = row;
      if (typeof id !== 'number' || (parentId !== null && typeof parentId !== 'number')
        || typeof name !== 'string' || typeof itemPath !== 'string' || typeof content !== 'string'
        || (hasArticleMarkdown && renderedContent !== null && typeof renderedContent !== 'string')
        || !Number.isSafeInteger(id) || id <= 0 || !itemPath || itemPath.startsWith('/') || itemPath.includes('..')) {
        throw new SyntaxHelpDatabaseError('The syntax database contains an invalid node.');
      }
      return {
        id,
        parentId,
        name,
        path: itemPath.replace(/\\/g, '/'),
        content,
        ...(typeof renderedContent === 'string' ? { renderedContent } : {}),
      } satisfies SyntaxHelpDatabaseNode;
    });
  } catch (error) {
    if (error instanceof SyntaxHelpDatabaseError) {
      throw error;
    }
    throw new SyntaxHelpDatabaseError('The syntax database could not be read.');
  } finally {
    database?.close();
  }
}
