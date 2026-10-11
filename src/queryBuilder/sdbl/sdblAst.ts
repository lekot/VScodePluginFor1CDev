/**
 * SDBL (1C:Enterprise Query Language) Abstract Syntax Tree (AST) definitions.
 */

export interface QueryPackage {
  queries: QueryStatement[];
  _runtimeTemplate?: boolean;
  _comments?: unknown[];
  _originalText?: string;
  _originalSemantics?: string;
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
export interface JoinedTableSource {
  type: 'JoinedTable';
  clauses: FromClause[];
}

export type TableOrSubquery = TableSource | SubquerySource | JoinedTableSource;

export interface JoinClause {
  optional?: boolean;
  optionalEnd?: boolean;
  joinType: 'Left' | 'Right' | 'Full' | 'Inner';
  source: TableOrSubquery;
  alias?: string;
  on: ExpressionNode;
  t1?: string;
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
  /** УПОРЯДОЧИТЬ ПО Поле ИЕРАРХИЯ: hierarchical order of a reference field. */
  hierarchy?: boolean;
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
  /** ИТОГИ ПО Поле КАК Имя: the name of the grouping in the result. */
  alias?: string;
}

export interface TotalsClause {
  fields?: TotalsField[];
  by: TotalsGroupItem[];
  overall?: boolean;
}

export interface SelectStatement {
  type: 'Select';
  extensions?: Array<{ after: string; raw: string }>;
  distinct?: boolean;
  allowed?: boolean;
  top?: number | string;
  forUpdate?: boolean;
  forUpdateTables?: string[];
  autoOrder?: boolean;
  into?: string;
  indexBy?: string[];
  indexSets?: string[][];
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
export interface AnnotatedExpressionNode { type: 'AnnotatedExpression'; expression: ExpressionNode; annotation: string; }
export interface TableProjectionNode { type: 'TableProjection'; expression: ExpressionNode; fields: SelectedField[]; }
export interface TupleNode { type: 'Tuple'; items: ExpressionNode[]; }
export interface MemberAccessNode { type: 'MemberAccess'; expression: ExpressionNode; member: string; }

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
  | RawExpressionNode
  | AnnotatedExpressionNode
  | TableProjectionNode
  | TupleNode
  | MemberAccessNode;
