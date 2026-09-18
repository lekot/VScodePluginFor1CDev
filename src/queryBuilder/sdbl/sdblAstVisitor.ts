import {
  ExpressionNode,
  FromClause,
  JoinClause,
  QueryPackage,
  SelectStatement,
  TableOrSubquery,
} from './sdblAst';

/**
 * Visitor interface for observing or collecting information from AST expressions.
 */
export interface ExpressionVisitor {
  enter?(node: ExpressionNode): void;
  leave?(node: ExpressionNode): void;
  enterSubquery?(stmt: SelectStatement): void;
  traverseSubqueries?: boolean;
}

/**
 * Compile-time assertion helper to ensure exhaustive switch handling.
 */
export function assertNever(x: never): never {
  const node = x as { type?: string };
  throw new Error(`Unhandled AST node type: ${node?.type}`);
}

/**
 * Deeply traverses an expression AST visiting all child nodes in pre-order / post-order.
 * Guarantees 100% compile-time coverage of all 13 AST expression types.
 */
export function traverseExpression(expr: ExpressionNode, visitor: ExpressionVisitor): void {
  if (!expr || typeof expr !== 'object') {
    return;
  }

  visitor.enter?.(expr);

  switch (expr.type) {
    case 'Identifier':
    case 'CompoundIdentifier':
    case 'Literal':
    case 'Parameter':
    case 'RawExpression':
      // Leaf nodes with no child expressions
      break;

    case 'FunctionCall':
      if ((expr as { expression?: ExpressionNode }).expression) {
        traverseExpression((expr as { expression?: ExpressionNode }).expression!, visitor);
      }
      if (expr.args && Array.isArray(expr.args)) {
        for (const arg of expr.args) {
          traverseExpression(arg, visitor);
        }
      }
      break;

    case 'Aggregate':
      if (expr.expression) {
        traverseExpression(expr.expression, visitor);
      }
      break;

    case 'CaseWhen':
      if (expr.cases && Array.isArray(expr.cases)) {
        for (const c of expr.cases) {
          if (c.when) {
            traverseExpression(c.when, visitor);
          }
          if (c.then) {
            traverseExpression(c.then, visitor);
          }
        }
      }
      if (expr.else) {
        traverseExpression(expr.else, visitor);
      }
      break;

    case 'BinaryOp':
      if (expr.left) {
        traverseExpression(expr.left, visitor);
      }
      if (expr.right) {
        traverseExpression(expr.right, visitor);
      }
      break;

    case 'UnaryOp':
      if (expr.operand) {
        traverseExpression(expr.operand, visitor);
      }
      break;

    case 'In':
      if (expr.expression) {
        traverseExpression(expr.expression, visitor);
      }
      if (Array.isArray(expr.values)) {
        for (const val of expr.values) {
          traverseExpression(val, visitor);
        }
      } else if (
        expr.values &&
        typeof expr.values === 'object' &&
        (expr.values as SelectStatement).type === 'Select'
      ) {
        const subquery = expr.values as SelectStatement;
        visitor.enterSubquery?.(subquery);
        if (visitor.traverseSubqueries) {
          traverseSelectStatement(subquery, visitor);
        }
      }
      break;

    case 'Between':
      if (expr.expression) {
        traverseExpression(expr.expression, visitor);
      }
      if (expr.from) {
        traverseExpression(expr.from, visitor);
      }
      if (expr.to) {
        traverseExpression(expr.to, visitor);
      }
      break;

    case 'Like':
      if (expr.expression) {
        traverseExpression(expr.expression, visitor);
      }
      if (expr.pattern) {
        traverseExpression(expr.pattern, visitor);
      }
      if (expr.escape) {
        traverseExpression(expr.escape, visitor);
      }
      break;

    default:
      assertNever(expr);
  }

  visitor.leave?.(expr);
}

/**
 * Recursively transforms an expression node and its children.
 * Returns a new AST structure with modifications while leaving untransformed nodes intact.
 */
export function transformExpression(
  expr: ExpressionNode,
  transformer: (node: ExpressionNode) => ExpressionNode | void
): ExpressionNode {
  if (!expr || typeof expr !== 'object') {
    return expr;
  }

  const custom = transformer(expr);
  const current = custom !== undefined ? custom : expr;

  switch (current.type) {
    case 'Identifier':
    case 'CompoundIdentifier':
    case 'Literal':
    case 'Parameter':
    case 'RawExpression':
      return current;

    case 'FunctionCall': {
      const targetExpr = (current as { expression?: ExpressionNode }).expression;
      const newExpression = targetExpr
        ? transformExpression(targetExpr, transformer)
        : undefined;
      const newArgs = current.args
        ? current.args.map((a) => transformExpression(a, transformer))
        : [];
      return {
        ...current,
        ...(newExpression ? { expression: newExpression } : {}),
        args: newArgs,
      };
    }

    case 'Aggregate': {
      return {
        ...current,
        expression: transformExpression(current.expression, transformer),
      };
    }

    case 'CaseWhen': {
      const newCases = current.cases
        ? current.cases.map((c) => ({
            when: transformExpression(c.when, transformer),
            then: transformExpression(c.then, transformer),
          }))
        : [];
      const newElse = current.else
        ? transformExpression(current.else, transformer)
        : undefined;
      return {
        ...current,
        cases: newCases,
        else: newElse,
      };
    }

    case 'BinaryOp': {
      return {
        ...current,
        left: transformExpression(current.left, transformer),
        right: transformExpression(current.right, transformer),
      };
    }

    case 'UnaryOp': {
      return {
        ...current,
        operand: transformExpression(current.operand, transformer),
      };
    }

    case 'In': {
      const newExpr = transformExpression(current.expression, transformer);
      let newValues = current.values;
      if (Array.isArray(current.values)) {
        newValues = current.values.map((v) => transformExpression(v, transformer));
      }
      return {
        ...current,
        expression: newExpr,
        values: newValues,
      };
    }

    case 'Between': {
      return {
        ...current,
        expression: transformExpression(current.expression, transformer),
        from: transformExpression(current.from, transformer),
        to: transformExpression(current.to, transformer),
      };
    }

    case 'Like': {
      return {
        ...current,
        expression: transformExpression(current.expression, transformer),
        pattern: transformExpression(current.pattern, transformer),
        escape: current.escape ? transformExpression(current.escape, transformer) : undefined,
      };
    }

    default:
      return assertNever(current);
  }
}

/**
 * Replaces table alias occurrences in an expression while strictly preserving:
 * - String literals (e.g. "T.Code")
 * - Query parameters (e.g. &T)
 * - Identifiers not matching oldAlias
 */
export function replaceAliasInExpression(
  expr: ExpressionNode,
  oldAlias: string,
  newAlias: string
): ExpressionNode {
  return transformExpression(expr, (node) => {
    // 1. CompoundIdentifier: T.Code -> NewT.Code
    if (node.type === 'CompoundIdentifier' && node.parts && node.parts.length > 0) {
      if (node.parts[0] === oldAlias) {
        return {
          ...node,
          parts: [newAlias, ...node.parts.slice(1)],
        };
      }
    }

    // 2. Identifier: standalone table alias T -> NewT
    if (node.type === 'Identifier') {
      if (node.name === oldAlias) {
        return {
          ...node,
          name: newAlias,
        };
      }
    }

    // 3. RawExpression: replace outside of string literals
    if (node.type === 'RawExpression') {
      return {
        ...node,
        raw: replaceAliasInRawString(node.raw, oldAlias, newAlias),
      };
    }

    // Literals and parameters are left intact
    return undefined;
  });
}

/**
 * Helper to replace table alias in raw SQL strings while preserving string literals in quotes.
 */
export function replaceAliasInRawString(raw: string, oldAlias: string, newAlias: string): string {
  if (!raw || typeof raw !== 'string') {
    return raw;
  }

  let result = '';
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      if (inString && i + 1 < raw.length && raw[i + 1] === '"') {
        result += '""';
        i += 2;
        continue;
      }
      inString = !inString;
      result += ch;
      i++;
      continue;
    }

    if (!inString) {
      const isParam = i > 0 && raw[i - 1] === '&';
      const isSubProperty = i > 0 && raw[i - 1] === '.';
      const isWordStart = i === 0 || /[^a-zA-Z0-9_а-яА-ЯёЁ]/.test(raw[i - 1]);
      const nextIdx = i + oldAlias.length;
      const isQualifier =
        nextIdx < raw.length &&
        raw[nextIdx] === '.' &&
        (nextIdx + 1 >= raw.length || /[a-zA-Z0-9_а-яА-ЯёЁ*]/.test(raw[nextIdx + 1]));
      const isExactWord =
        nextIdx >= raw.length || /[^a-zA-Z0-9_а-яА-ЯёЁ]/.test(raw[nextIdx]);

      if (
        !isParam &&
        !isSubProperty &&
        isWordStart &&
        raw.substring(i, nextIdx) === oldAlias
      ) {
        if (isQualifier || (isExactWord && i === 0 && nextIdx === raw.length)) {
          result += newAlias;
          i = nextIdx;
          continue;
        }
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Extracts unique parameter names from a raw SDBL expression string, ignoring string literals.
 */
export function extractParametersFromRawString(raw: string): string[] {
  if (!raw || typeof raw !== 'string') {
    return [];
  }

  const result = new Set<string>();
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      if (inString && i + 1 < raw.length && raw[i + 1] === '"') {
        i += 2;
        continue;
      }
      inString = !inString;
      i++;
      continue;
    }

    if (!inString && ch === '&') {
      let j = i + 1;
      while (j < raw.length && /[a-zA-Z0-9_а-яА-ЯёЁ]/.test(raw[j])) {
        j++;
      }
      if (j > i + 1) {
        result.add(raw.substring(i + 1, j));
        i = j;
        continue;
      }
    }

    i++;
  }

  return Array.from(result);
}

/**
 * Traverses all expressions contained within a TableSource or SubquerySource.
 */
export function traverseTableSource(
  source: TableOrSubquery | undefined,
  visitor: ExpressionVisitor
): void {
  if (!source) {
    return;
  }
  if (source.type === 'Table' && source.params) {
    for (const param of source.params) {
      traverseExpression(param, visitor);
    }
  } else if (source.type === 'Subquery' && source.query) {
    visitor.enterSubquery?.(source.query);
    traverseSelectStatement(source.query, visitor);
  }
}

/**
 * Traverses all expressions and subqueries contained within a SelectStatement.
 */
export function traverseSelectStatement(
  stmt: SelectStatement,
  visitor: ExpressionVisitor
): void {
  if (!stmt || typeof stmt !== 'object') {
    return;
  }

  stmt.fields?.forEach((f) => {
    if (typeof f.expression === 'string') {
      visitor.enter?.({ type: 'RawExpression', raw: f.expression });
    } else if (f.expression) {
      traverseExpression(f.expression, visitor);
    } else if (f.raw) {
      visitor.enter?.({ type: 'RawExpression', raw: f.raw });
    }
  });

  stmt.from?.forEach((fc) => {
    traverseTableSource(fc.source, visitor);
    fc.joins?.forEach((j) => {
      traverseTableSource(j.source, visitor);
      if (typeof j.on === 'string') {
        visitor.enter?.({ type: 'RawExpression', raw: j.on });
      } else if (j.on) {
        traverseExpression(j.on, visitor);
      }
    });
  });

  if (typeof stmt.where === 'string') {
    visitor.enter?.({ type: 'RawExpression', raw: stmt.where });
  } else if (stmt.where) {
    traverseExpression(stmt.where, visitor);
  }

  stmt.groupBy?.forEach((g) => traverseExpression(g, visitor));

  if (typeof stmt.having === 'string') {
    visitor.enter?.({ type: 'RawExpression', raw: stmt.having });
  } else if (stmt.having) {
    traverseExpression(stmt.having, visitor);
  }

  stmt.unions?.forEach((u) => {
    visitor.enterSubquery?.(u.statement);
    traverseSelectStatement(u.statement, visitor);
  });

  stmt.orderBy?.forEach((o) => {
    if (o.expression) {
      traverseExpression(o.expression, visitor);
    }
  });

  if (stmt.totals) {
    stmt.totals.fields?.forEach((f) => {
      if (f.expression) {
        traverseExpression(f.expression, visitor);
      }
    });
    stmt.totals.by?.forEach((b) => {
      if (b.expression) {
        traverseExpression(b.expression, visitor);
      }
      if (b.periodDefinition?.from) {
        traverseExpression(b.periodDefinition.from, visitor);
      }
      if (b.periodDefinition?.to) {
        traverseExpression(b.periodDefinition.to, visitor);
      }
    });
  }
}

/**
 * Returns true if the expression contains any aggregate function (Sum, Count, Avg, Min, Max) at any depth.
 */
export function isAggregateExpression(expr: ExpressionNode): boolean {
  let hasAggregate = false;
  traverseExpression(expr, {
    enter: (node) => {
      if (node.type === 'Aggregate') {
        hasAggregate = true;
      }
    },
  });
  return hasAggregate;
}

/**
 * Extracts all unique query parameter names (without '&') from an expression AST, sorted alphabetically.
 * Handles ParameterNode, RawExpressionNode (excluding string literals), and subqueries in InNode.
 */
export function extractParametersFromExpression(expr: ExpressionNode): string[] {
  const params = new Set<string>();

  const visitor: ExpressionVisitor = {
    traverseSubqueries: true,
    enter: (node) => {
      if (node.type === 'Parameter' && node.name) {
        params.add(node.name);
      } else if (node.type === 'RawExpression' && node.raw) {
        for (const p of extractParametersFromRawString(node.raw)) {
          params.add(p);
        }
      }
    },
  };

  traverseExpression(expr, visitor);
  return Array.from(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Extracts all unique query parameter names from an entire QueryPackage, sorted alphabetically.
 */
export function extractParametersFromPackage(pkg: QueryPackage): string[] {
  const params = new Set<string>();

  const visitor: ExpressionVisitor = {
    traverseSubqueries: true,
    enter: (node) => {
      if (node.type === 'Parameter' && node.name) {
        params.add(node.name);
      } else if (node.type === 'RawExpression' && node.raw) {
        for (const p of extractParametersFromRawString(node.raw)) {
          params.add(p);
        }
      }
    },
  };

  for (const q of pkg.queries) {
    if (q.type === 'Select') {
      traverseSelectStatement(q, visitor);
    }
  }

  return Array.from(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Returns a stable string key identifying a table source.
 */
export function getTableKey(source: TableOrSubquery, alias?: string): string {
  if (alias && alias.trim().length > 0) {
    return alias.trim();
  }
  if (source && source.type === 'Table' && source.name) {
    return source.name;
  }
  return '';
}

export interface QueryTableInfo {
  source: TableOrSubquery;
  alias?: string;
  key: string;
}

/**
 * Returns all participating tables in an array of FromClause items (both roots and joined tables).
 */
export function getAllTablesFromClauses(from?: FromClause[]): QueryTableInfo[] {
  if (!from || !Array.isArray(from)) {
    return [];
  }
  const result: QueryTableInfo[] = [];
  const seen = new Set<string>();

  for (const fc of from) {
    const rootKey = getTableKey(fc.source, fc.alias);
    if (rootKey && !seen.has(rootKey)) {
      seen.add(rootKey);
      result.push({ source: fc.source, alias: fc.alias, key: rootKey });
    }
    if (fc.joins && Array.isArray(fc.joins)) {
      for (const jn of fc.joins) {
        const jnKey = getTableKey(jn.source, jn.alias);
        if (jnKey && !seen.has(jnKey)) {
          seen.add(jnKey);
          result.push({ source: jn.source, alias: jn.alias, key: jnKey });
        }
      }
    }
  }

  return result;
}

/**
 * Normalizes an array of FromClause items:
 * 1. Unfolds any 'Right' join into an equivalent 'Left' join by swapping the left and right tables:
 *    (T1 RIGHT JOIN T2 ON Cond) => (T2 LEFT JOIN T1 ON Cond).
 * 2. Deduplicates tables: joined tables are attached to their parent join tree and NOT emitted
 *    as duplicate comma-separated roots in ИЗ.
 * 3. Preserves isolated unjoined tables as independent FromClause roots.
 * 4. Ensures the root of each connected component in ИЗ is valid (never a table that only appears
 *    on the right side of a Left join).
 */
interface RegisteredTable {
  key: string;
  source: TableOrSubquery;
  alias?: string;
  identKeys: Set<string>;
  order: number;
}

interface RawJoinEntry {
  jn: JoinClause;
  t1Ident?: string;
  defaultT1Key: string;
}

export function normalizeFromClauses(from?: FromClause[]): FromClause[] {
  if (!from || !Array.isArray(from) || from.length === 0) {
    return [];
  }

  // 1. Collect all registered tables and raw joins
  const tablesMap = new Map<string, RegisteredTable>();
  const tableOrder: string[] = [];
  const rawJoins: RawJoinEntry[] = [];
  let orderCounter = 0;

  const registerTable = (source: TableOrSubquery, alias?: string) => {
    const key = getTableKey(source, alias);
    if (!key) {
      return;
    }
    if (!tablesMap.has(key)) {
      tablesMap.set(key, {
        key,
        source,
        alias,
        identKeys: getTableIdentKeys(source, alias),
        order: orderCounter++,
      });
      tableOrder.push(key);
    } else {
      const existing = tablesMap.get(key)!;
      if (source.type === 'Table' && source.params && source.params.length > 0) {
        existing.source = source;
      }
      if (alias && !existing.alias) {
        existing.alias = alias;
      }
    }
  };

  for (const fc of from) {
    registerTable(fc.source, fc.alias);
    const fcKey = getTableKey(fc.source, fc.alias);
    if (fc.joins && Array.isArray(fc.joins)) {
      for (const jn of fc.joins) {
        registerTable(jn.source, jn.alias);
        rawJoins.push({
          jn,
          t1Ident: (jn as { t1?: string }).t1,
          defaultT1Key: fcKey,
        });
      }
    }
  }

  // If there are no joins at all, return deduplicated tables
  if (rawJoins.length === 0) {
    return tableOrder.map((key) => {
      const t = tablesMap.get(key)!;
      return { source: t.source, alias: t.alias };
    });
  }

  // 2. Resolve true t1Key and t2Key for each join
  const findTableKeyByIdent = (ident?: string): string | undefined => {
    if (!ident) {
      return undefined;
    }
    const norm = ident.trim().toLowerCase();
    for (const key of tableOrder) {
      const t = tablesMap.get(key)!;
      if (t.identKeys.has(norm)) {
        return key;
      }
    }
    return undefined;
  };

  interface ResolvedJoin {
    t1Key: string;
    t2Key: string;
    joinClause: JoinClause;
  }
  const resolvedJoins: ResolvedJoin[] = [];
  const joinedTables = new Set<string>();

  for (const rj of rawJoins) {
    const t2Key = getTableKey(rj.jn.source, rj.jn.alias);
    const t1Key = (rj.t1Ident ? findTableKeyByIdent(rj.t1Ident) : undefined) || rj.defaultT1Key;
    if (t1Key && t2Key && t1Key !== t2Key) {
      resolvedJoins.push({
        t1Key,
        t2Key,
        joinClause: rj.jn,
      });
      joinedTables.add(t2Key);
    } else if (t1Key && t2Key) {
      resolvedJoins.push({
        t1Key,
        t2Key,
        joinClause: rj.jn,
      });
    }
  }

  // 3. Construct FromClause trees starting from root tables
  const normalized: FromClause[] = [];
  const processedTables = new Set<string>();
  const remainingJoins = [...resolvedJoins];

  for (const rootKey of tableOrder) {
    if (joinedTables.has(rootKey)) {
      // Table is attached via JOIN to another table
      continue;
    }
    if (processedTables.has(rootKey)) {
      continue;
    }

    const rootTable = tablesMap.get(rootKey)!;
    processedTables.add(rootKey);

    const inTree = new Set<string>([rootKey]);
    const treeJoins: JoinClause[] = [];

    let progress = true;
    while (remainingJoins.length > 0 && progress) {
      progress = false;
      for (let i = 0; i < remainingJoins.length; i++) {
        const j = remainingJoins[i];
        if (inTree.has(j.t1Key)) {
          treeJoins.push(j.joinClause);
          inTree.add(j.t2Key);
          processedTables.add(j.t2Key);
          remainingJoins.splice(i, 1);
          progress = true;
          break;
        }
      }
    }

    const initialClause: FromClause = {
      source: rootTable.source,
      alias: rootTable.alias,
      joins: treeJoins.length > 0 ? treeJoins : undefined,
    };

    normalized.push(normalizeSingleFromClause(initialClause));
  }

  // Any remaining unattached joins (e.g. cycles or orphan edges)
  for (const rj of remainingJoins) {
    if (!processedTables.has(rj.t2Key)) {
      processedTables.add(rj.t2Key);
      const t = tablesMap.get(rj.t2Key)!;
      normalized.push({ source: t.source, alias: t.alias });
    }
  }

  return normalized;
}

function getTableIdentKeys(source: TableOrSubquery, alias?: string): Set<string> {
  const set = new Set<string>();
  if (alias && alias.trim()) {
    set.add(alias.trim().toLowerCase());
  }
  if (source.type === 'Table' && source.name) {
    const rawName = source.name.trim();
    set.add(rawName.toLowerCase());
    const dotIdx = rawName.indexOf('.');
    if (dotIdx !== -1) {
      set.add(rawName.substring(dotIdx + 1).toLowerCase());
    }
  }
  return set;
}

function getTableKeysFromExpression(expr: ExpressionNode | string): Set<string> {
  const keys = new Set<string>();
  if (!expr) {
    return keys;
  }
  if (typeof expr === 'string') {
    const matches = expr.matchAll(/\b([a-zA-Z0-9_а-яА-ЯёЁ]+)\.[a-zA-Z0-9_а-яА-ЯёЁ]+/g);
    for (const m of matches) {
      keys.add(m[1].toLowerCase());
    }
    return keys;
  }
  traverseExpression(expr, {
    enter: (node) => {
      if (node.type === 'CompoundIdentifier' && node.parts && node.parts.length > 1) {
        keys.add(node.parts[0].toLowerCase());
      } else if (node.type === 'RawExpression' && node.raw) {
        const matches = node.raw.matchAll(/\b([a-zA-Z0-9_а-яА-ЯёЁ]+)\.[a-zA-Z0-9_а-яА-ЯёЁ]+/g);
        for (const m of matches) {
          keys.add(m[1].toLowerCase());
        }
      }
    },
  });
  return keys;
}

function normalizeSingleFromClause(fc: FromClause): FromClause {
  if (!fc.joins || fc.joins.length === 0) {
    return fc;
  }

  // Finding R2: A RIGHT join can ONLY be safely unfolded into an equivalent LEFT join
  // if it is a single 2-table join (i.e. exactly 1 join in fc.joins).
  // Multi-table RIGHT join chains (e.g. ((A RIGHT B) RIGHT C)) cannot be flattened into
  // flat LEFT joins ((C LEFT B) LEFT A) without changing outer join associativity and row
  // multiplication when intermediate tables contain NULLs (see Astra SQLite proof).
  // 1C SDBL natively supports ПРАВОЕ СОЕДИНЕНИЕ for multi-table chains.
  if (fc.joins.length !== 1 || fc.joins[0].joinType !== 'Right') {
    return fc;
  }

  const j = fc.joins[0];
  const rootKeys = getTableIdentKeys(fc.source, fc.alias);
  const targetKeys = getTableIdentKeys(j.source, j.alias);
  const scope = new Set<string>();
  for (const k of rootKeys) {
    scope.add(k);
  }
  for (const k of targetKeys) {
    scope.add(k);
  }

  const condRefs = getTableKeysFromExpression(j.on);
  for (const ref of condRefs) {
    if (!scope.has(ref)) {
      return fc;
    }
  }

  return {
    source: j.source,
    alias: j.alias,
    joins: [
      {
        joinType: 'Left',
        source: fc.source,
        alias: fc.alias,
        on: j.on,
      },
    ],
  };
}
