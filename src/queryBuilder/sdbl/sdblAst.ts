/**
 * SDBL (1C:Enterprise Query Language) Abstract Syntax Tree (AST) definitions.
 */

export interface QueryPackage {
  queries: QueryStatement[];
}

export type QueryStatement = SelectStatement | DropTableStatement;

export interface DropTableStatement {
  type: 'DropTable';
  tableName: string;
}

export interface SelectedField {
  expression: ExpressionNode | string;
  alias?: string;
  raw?: string;
}

export interface TableSource {
  type: 'Table';
  name: string;
  params?: ExpressionNode[];
}

export interface SubquerySource {
  type: 'Subquery';
  query: SelectStatement;
}

export type TableOrSubquery = TableSource | SubquerySource;

export interface JoinClause {
  joinType: 'Left' | 'Right' | 'Full' | 'Inner';
  source: TableOrSubquery;
  alias?: string;
  on: ExpressionNode;
}

export interface FromClause {
  source: TableOrSubquery;
  alias?: string;
  joins?: JoinClause[];
}

export interface UnionClause {
  unionType: 'Union' | 'UnionAll';
  statement: SelectStatement;
}

export interface OrderItem {
  expression: ExpressionNode;
  direction?: 'Asc' | 'Desc';
  autoOrder?: boolean;
}

export interface TotalsField {
  expression: ExpressionNode;
  alias?: string;
}

export interface TotalsGroupItem {
  expression: ExpressionNode;
  hierarchy?: boolean;
  hierarchyType?: 'All' | 'OnlyHierarchy'; // 'All' для ИЕРАРХИЯ, 'OnlyHierarchy' для ТОЛЬКО ИЕРАРХИЯ
  period?: boolean;
  periods?: boolean;
  periodDefinition?: {
    periodType?: string; // например ДЕНЬ, МЕСЯЦ
    from?: ExpressionNode;
    to?: ExpressionNode;
  };
  overall?: boolean;
}

export interface TotalsClause {
  fields?: TotalsField[];
  by: TotalsGroupItem[];
  overall?: boolean;
}

export interface SelectStatement {
  type: 'Select';
  distinct?: boolean;
  allowed?: boolean;
  top?: number;
  forUpdate?: boolean;
  forUpdateTables?: string[];
  autoOrder?: boolean;
  into?: string;
  intoType?: 'create' | 'append';
  indexBy?: string[];
  fields: SelectedField[];
  from?: FromClause[];
  where?: ExpressionNode;
  groupBy?: ExpressionNode[];
  having?: ExpressionNode;
  unions?: UnionClause[];
  orderBy?: OrderItem[];
  totals?: TotalsClause;
}

// --- Expressions ---

export interface IdentifierNode {
  type: 'Identifier';
  name: string;
}

export interface CompoundIdentifierNode {
  type: 'CompoundIdentifier';
  parts: string[];
}

export interface LiteralNode {
  type: 'Literal';
  valueType: 'string' | 'number' | 'boolean' | 'null' | 'date';
  value: string | number | boolean | null | undefined;
  raw: string;
}

export interface ParameterNode {
  type: 'Parameter';
  name: string;
}

export interface FunctionCallNode {
  type: 'FunctionCall';
  name: string;
  args: ExpressionNode[];
}

export interface AggregateNode {
  type: 'Aggregate';
  aggregateType: 'Sum' | 'Count' | 'Avg' | 'Min' | 'Max';
  distinct?: boolean;
  expression: ExpressionNode;
}

export interface CaseWhenNode {
  type: 'CaseWhen';
  cases: Array<{ when: ExpressionNode; then: ExpressionNode }>;
  else?: ExpressionNode;
}

export interface BinaryOpNode {
  type: 'BinaryOp';
  operator: string;
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface UnaryOpNode {
  type: 'UnaryOp';
  operator: string;
  operand: ExpressionNode;
}

export interface InNode {
  type: 'In';
  expression: ExpressionNode;
  values: ExpressionNode[] | SelectStatement;
  not?: boolean;
  inHierarchy?: boolean;
}

export interface BetweenNode {
  type: 'Between';
  expression: ExpressionNode;
  from: ExpressionNode;
  to: ExpressionNode;
  not?: boolean;
}

export interface LikeNode {
  type: 'Like';
  expression: ExpressionNode;
  pattern: ExpressionNode;
  not?: boolean;
  escape?: ExpressionNode;
}

export interface RawExpressionNode {
  type: 'RawExpression';
  raw: string;
}

export type ExpressionNode =
  | IdentifierNode
  | CompoundIdentifierNode
  | LiteralNode
  | ParameterNode
  | FunctionCallNode
  | AggregateNode
  | CaseWhenNode
  | BinaryOpNode
  | UnaryOpNode
  | InNode
  | BetweenNode
  | LikeNode
  | RawExpressionNode;
