/** Syntax tree produced by the parser. Plain data, no behaviour. */

/**
 * How a piece of a word was quoted. Determines which expansions apply:
 * - `none`: variables, tilde, globbing and word splitting
 * - `double`: variables only
 * - `literal`: nothing (single quotes or backslash escapes)
 */
export type QuoteKind = 'none' | 'double' | 'literal';

export interface WordPart {
  text: string;
  quote: QuoteKind;
}

export interface Word {
  parts: WordPart[];
}

export type RedirectOp = '>' | '>>' | '<' | '>&' | '&>' | '&>>';

export interface Redirect {
  /** Source file descriptor (1 for `>`, 0 for `<`, 2 for `2>`). Ignored for `&>`. */
  fd: number;
  op: RedirectOp;
  target: Word;
}

export interface Assignment {
  name: string;
  value: Word;
}

export interface SimpleCommand {
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: SimpleCommand[];
}

export type ListOp = ';' | '&&' | '||';

export interface ListItem {
  /** Operator that connects this item to the previous one (null for the first). */
  op: ListOp | null;
  pipeline: Pipeline;
}

export interface Script {
  items: ListItem[];
}

/** Concatenate a word's raw text (used for error messages and assignment detection). */
export function wordText(word: Word): string {
  return word.parts.map((p) => p.text).join('');
}
