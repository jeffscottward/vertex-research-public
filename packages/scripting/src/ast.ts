// Typed AST for the Vertex Pine subset. Every node carries a unique numeric id (stable per
// parse) that the evaluator uses as its call-site key for per-bar state.

type Node<K extends string, Fields> = Readonly<
  { kind: K; id: number; line: number; column: number } & Fields
>;

export type NumberLit = Node<"num", { value: number; isInt: boolean }>;
export type StringLit = Node<"str", { value: string }>;
export type BoolLit = Node<"bool", { value: boolean }>;
export type NaLit = Node<"na", Record<never, never>>;
export type ColorLit = Node<"color", { hex: string }>;
// Dotted names ("ta.tr", "color.red") are one Name.
export type Name = Node<"name", { name: string }>;
export type History = Node<"history", { target: Expr; offset: Expr }>;
export type UnaryOp = "-" | "+" | "not";
export type Unary = Node<"unary", { op: UnaryOp; operand: Expr }>;
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";
export type Binary = Node<"binary", { op: BinaryOp; left: Expr; right: Expr }>;
export type Ternary = Node<
  "ternary",
  { cond: Expr; whenTrue: Expr; whenFalse: Expr }
>;
export type Arg = Readonly<{
  name: string | null;
  value: Expr;
  line: number;
  column: number;
}>;
export type Call = Node<"call", { callee: string; args: readonly Arg[] }>;
// `[a, b]`: a function's tuple return value, or an options=[...] list.
export type Tuple = Node<"tuple", { items: readonly Expr[] }>;

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | NaLit
  | ColorLit
  | Name
  | History
  | Unary
  | Binary
  | Ternary
  | Call
  | Tuple;

export type TypeName = "int" | "float" | "bool" | "string" | "color";

export type ExprStmt = Node<"expr", { expr: Expr }>;
export type VarDecl = Node<
  "decl",
  { name: string; persistent: boolean; typeName: TypeName | null; value: Expr }
>;
export type TupleTarget = Readonly<{
  id: number;
  name: string;
  line: number;
  column: number;
}>;
export type TupleDecl = Node<
  "tupleDecl",
  { targets: readonly TupleTarget[]; value: Expr }
>;
export type AssignOp = ":=" | "+=" | "-=" | "*=" | "/=" | "%=";
export type Assign = Node<
  "assign",
  { name: string; op: AssignOp; value: Expr }
>;
export type If = Node<
  "if",
  { cond: Expr; then: readonly Stmt[]; otherwise: readonly Stmt[] | null }
>;
export type For = Node<
  "for",
  {
    variable: string;
    from: Expr;
    to: Expr;
    step: Expr | null;
    body: readonly Stmt[];
  }
>;
export type Param = Readonly<{
  name: string;
  fallback: Expr | null;
  line: number;
  column: number;
}>;
export type FuncDef = Node<
  "func",
  { name: string; params: readonly Param[]; body: readonly Stmt[] }
>;
export type Break = Node<"break", Record<never, never>>;
export type Continue = Node<"continue", Record<never, never>>;

export type Stmt =
  | ExprStmt
  | VarDecl
  | TupleDecl
  | Assign
  | If
  | For
  | FuncDef
  | Break
  | Continue;

export type Program = Readonly<{
  body: readonly Stmt[];
  version: 5 | 6 | null;
  nodeCount: number;
}>;
