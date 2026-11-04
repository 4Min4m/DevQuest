/**
 * A small readline-style line editor, independent of xterm.js so it can be unit tested.
 * Feed it raw terminal input; it returns events and the ANSI text to write.
 */

import type { Completion } from '../../sim/shell/complete';

export type EditorEvent =
  | { type: 'write'; data: string }
  | { type: 'submit'; line: string }
  | { type: 'clear' };

export interface LineEditorOptions {
  prompt: () => string;
  complete?: (line: string, cursor: number) => Completion;
  /** Terminal width; when given, long lines that wrap onto several rows are redrawn correctly. */
  cols?: () => number;
}

/** Printable width of text (ANSI escape sequences take no space). */
const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

const KEYS: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1b[3~': 'delete',
  '\x1b[1;5C': 'wordRight',
  '\x1b[1;5D': 'wordLeft',
  '\x1bf': 'wordRight',
  '\x1bb': 'wordLeft',
};

export class LineEditor {
  buffer = '';
  cursor = 0;
  history: string[] = [];
  private historyPos = 0;
  private draft = '';

  constructor(private readonly opts: LineEditorOptions) {}

  /** Row of the cursor inside the (possibly wrapped) input line, as last drawn. */
  private row = 0;

  /**
   * Text that draws the prompt and current buffer from the start of the input line.
   * `fresh`: the cursor is at the start of a new, empty line (after output).
   */
  render(fresh = false): string {
    if (fresh) this.row = 0;
    const cols = this.opts.cols?.() ?? 0;
    const prompt = this.opts.prompt();
    if (!cols) {
      const back = this.buffer.length - this.cursor;
      return '\r\x1b[2K' + prompt + this.buffer + (back > 0 ? `\x1b[${back}D` : '');
    }
    // Go back to the first row of the input line, clear everything below, redraw, then place the cursor.
    let out = (this.row > 0 ? `\x1b[${this.row}A` : '') + '\r\x1b[J' + prompt + this.buffer;
    const end = visibleLength(prompt) + this.buffer.length;
    const at = visibleLength(prompt) + this.cursor;
    // At an exact multiple of the width the terminal waits to wrap; force it so rows add up.
    if (end > 0 && end % cols === 0) out += ' \r';
    const endRow = Math.floor(end / cols);
    const row = Math.floor(at / cols);
    const col = at % cols;
    out += (endRow > row ? `\x1b[${endRow - row}A` : '') + '\r' + (col ? `\x1b[${col}C` : '');
    this.row = row;
    return out;
  }

  /** Move from the cursor to the line after the input (before printing below it). */
  private leaveLine(): string {
    const cols = this.opts.cols?.() ?? 0;
    let down = '';
    if (cols) {
      const endRow = Math.floor((visibleLength(this.opts.prompt()) + this.buffer.length) / cols);
      if (endRow > this.row) down = `\x1b[${endRow - this.row}B`;
    }
    this.row = 0;
    return down + '\r\n';
  }

  /** Process raw input (a keypress or a paste). */
  feed(data: string): EditorEvent[] {
    const events: EditorEvent[] = [];
    const redraw = () => events.push({ type: 'write', data: this.render() });
    let i = 0;
    while (i < data.length) {
      const seq = Object.keys(KEYS).find((k) => data.startsWith(k, i));
      if (seq) {
        this.key(KEYS[seq]);
        redraw();
        i += seq.length;
        continue;
      }
      const c = data[i++];
      switch (c) {
        case '\r':
        case '\n': {
          if (c === '\n' && data[i - 2] === '\r') break; // CRLF paste
          const line = this.buffer;
          events.push({ type: 'write', data: this.leaveLine() });
          if (line.trim() && this.history[this.history.length - 1] !== line) this.history.push(line);
          this.historyPos = this.history.length;
          this.buffer = '';
          this.cursor = 0;
          events.push({ type: 'submit', line });
          break;
        }
        case '\x7f':
        case '\b':
          if (this.cursor > 0) {
            this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
            this.cursor--;
          }
          redraw();
          break;
        case '\x03': // Ctrl+C
          events.push({ type: 'write', data: '^C' + this.leaveLine() });
          this.buffer = '';
          this.cursor = 0;
          this.historyPos = this.history.length;
          redraw();
          break;
        case '\x0c': // Ctrl+L
          events.push({ type: 'clear' });
          this.row = 0;
          redraw();
          break;
        case '\x01':
          this.cursor = 0;
          redraw();
          break;
        case '\x05':
          this.cursor = this.buffer.length;
          redraw();
          break;
        case '\x15': // Ctrl+U: kill to start
          this.buffer = this.buffer.slice(this.cursor);
          this.cursor = 0;
          redraw();
          break;
        case '\x0b': // Ctrl+K: kill to end
          this.buffer = this.buffer.slice(0, this.cursor);
          redraw();
          break;
        case '\x17': {
          // Ctrl+W: delete previous word
          const start = this.wordStartBefore(this.cursor);
          this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
          this.cursor = start;
          redraw();
          break;
        }
        case '\t':
          events.push(...this.tab());
          break;
        case '\x1b':
          break; // unknown escape sequence start: ignore
        default:
          if (c >= ' ') {
            this.buffer = this.buffer.slice(0, this.cursor) + c + this.buffer.slice(this.cursor);
            this.cursor++;
            redraw();
          }
      }
    }
    return collapseWrites(events);
  }

  private wordStartBefore(pos: number): number {
    let p = pos;
    while (p > 0 && this.buffer[p - 1] === ' ') p--;
    while (p > 0 && this.buffer[p - 1] !== ' ') p--;
    return p;
  }

  private key(name: string): void {
    switch (name) {
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'right':
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
        break;
      case 'home':
        this.cursor = 0;
        break;
      case 'end':
        this.cursor = this.buffer.length;
        break;
      case 'delete':
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        break;
      case 'wordLeft':
        this.cursor = this.wordStartBefore(this.cursor);
        break;
      case 'wordRight': {
        let p = this.cursor;
        while (p < this.buffer.length && this.buffer[p] === ' ') p++;
        while (p < this.buffer.length && this.buffer[p] !== ' ') p++;
        this.cursor = p;
        break;
      }
      case 'up':
        if (this.historyPos === this.history.length) this.draft = this.buffer;
        if (this.historyPos > 0) {
          this.historyPos--;
          this.buffer = this.history[this.historyPos];
          this.cursor = this.buffer.length;
        }
        break;
      case 'down':
        if (this.historyPos < this.history.length) {
          this.historyPos++;
          this.buffer = this.historyPos === this.history.length ? this.draft : this.history[this.historyPos];
          this.cursor = this.buffer.length;
        }
        break;
    }
  }

  private tab(): EditorEvent[] {
    if (!this.opts.complete) return [];
    const before = { buffer: this.buffer, cursor: this.cursor };
    const r = this.opts.complete(this.buffer, this.cursor);
    this.buffer = r.line;
    this.cursor = r.cursor;
    const events: EditorEvent[] = [];
    if (r.candidates.length) {
      // Leave the line as it was drawn before completion, then list the candidates.
      const shown = { buffer: this.buffer, cursor: this.cursor };
      this.buffer = before.buffer;
      this.cursor = before.cursor;
      const leave = this.leaveLine();
      this.buffer = shown.buffer;
      this.cursor = shown.cursor;
      events.push({ type: 'write', data: leave + r.candidates.join('  ') + '\r\n' });
    }
    events.push({ type: 'write', data: this.render() });
    return events;
  }
}

/** Merge consecutive write events so the terminal receives fewer, larger writes. */
function collapseWrites(events: EditorEvent[]): EditorEvent[] {
  const out: EditorEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === 'write' && last?.type === 'write') last.data += e.data;
    else out.push(e.type === 'write' ? { ...e } : e);
  }
  return out;
}
