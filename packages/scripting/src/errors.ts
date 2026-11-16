// Internal failure carrying a 1-based source position. Thrown inside the lexer, parser,
// checker and evaluator, and always caught at the compileScript/runScript boundary.

import type { ScriptError } from "./types.ts";

export type Position = Readonly<{ line: number; column: number }>;

export class ScriptFailure extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, at: Position) {
    super(message);
    this.name = "ScriptFailure";
    this.line = at.line;
    this.column = at.column;
  }
}

export const fail = (message: string, at: Position): never => {
  throw new ScriptFailure(message, at);
};

export const unsupported = (name: string, at: Position): never =>
  fail(`not supported in Vertex scripts yet: ${name}`, at);

export const START: Position = { column: 1, line: 1 };

// Any thrown value becomes a short positioned ScriptError; nothing escapes the boundary.
export const toScriptError = (error: unknown): ScriptError => {
  if (error instanceof ScriptFailure) {
    return { column: error.column, line: error.line, message: error.message };
  }
  if (error instanceof RangeError) {
    return { ...START, message: "Script is nested too deeply" };
  }
  return { ...START, message: "Internal script error" };
};
