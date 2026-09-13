import {
  ExpressionNode,
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
        visitor.enterSubquery?.(expr.values as SelectStatement);
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
      const newArgs = current.args
        ? current.args.map((a) => transformExpression(a, transformer))
        : [];
      return {
        ...current,
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
    if (typeof f.expression !== 'string') {
      traverseExpression(f.expression, visitor);
    } else if (f.raw) {
      visitor.enter?.({ type: 'RawExpression', raw: f.raw });
    }
  });

  stmt.from?.forEach((fc) => {
    traverseTableSource(fc.source, visitor);
    fc.joins?.forEach((j) => {
      traverseTableSource(j.source, visitor);
      if (j.on) {
        traverseExpression(j.on, visitor);
      }
    });
  });

  if (stmt.where) {
    traverseExpression(stmt.where, visitor);
  }

  stmt.groupBy?.forEach((g) => traverseExpression(g, visitor));

  if (stmt.having) {
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
    enter: (node) => {
      if (node.type === 'Parameter' && node.name) {
        params.add(node.name);
      } else if (node.type === 'RawExpression' && node.raw) {
        for (const p of extractParametersFromRawString(node.raw)) {
          params.add(p);
        }
      }
    },
    enterSubquery: (subquery) => {
      traverseSelectStatement(subquery, visitor);
    },
  };

  traverseExpression(expr, visitor);
  return Array.from(params).sort((a, b) => a.localeCompare(b));
}

/**
 * Extracts all unique query parameter names from an entire QueryPackage, sorted alphabetically.
 */
export function extractParametersFromPackage(pkg: QueryPackage): string[] {
  const params = new Set<string>();

  const visitor: ExpressionVisitor = {
    enter: (node) => {
      if (node.type === 'Parameter' && node.name) {
        params.add(node.name);
      } else if (node.type === 'RawExpression' && node.raw) {
        for (const p of extractParametersFromRawString(node.raw)) {
          params.add(p);
        }
      }
    },
    enterSubquery: (subquery) => {
      traverseSelectStatement(subquery, visitor);
    },
  };

  for (const q of pkg.queries) {
    if (q.type === 'Select') {
      traverseSelectStatement(q, visitor);
    }
  }

  return Array.from(params).sort((a, b) => a.localeCompare(b));
}
