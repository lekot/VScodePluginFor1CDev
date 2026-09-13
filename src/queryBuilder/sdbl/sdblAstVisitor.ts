import { ExpressionNode } from './sdblAst';

/**
 * Visitor interface for observing or collecting information from AST expressions.
 */
export interface ExpressionVisitor {
  enter?(node: ExpressionNode): void;
  leave?(node: ExpressionNode): void;
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
      if (
        (i === 0 || /[^a-zA-Z0-9_а-яА-ЯёЁ]/.test(raw[i - 1])) &&
        raw.substring(i, i + oldAlias.length) === oldAlias &&
        (i + oldAlias.length >= raw.length || /[^a-zA-Z0-9_а-яА-ЯёЁ]/.test(raw[i + oldAlias.length]))
      ) {
        result += newAlias;
        i += oldAlias.length;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
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
 */
export function extractParametersFromExpression(expr: ExpressionNode): string[] {
  const params = new Set<string>();
  traverseExpression(expr, {
    enter: (node) => {
      if (node.type === 'Parameter' && node.name) {
        params.add(node.name);
      }
    },
  });
  return Array.from(params).sort();
}
