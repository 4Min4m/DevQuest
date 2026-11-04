import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { Shell } from '../../sim/shell/shell';
import type { EditRequest, RunResult } from '../../sim/shell/types';
import { Editor } from './Editor';
import { promptParts } from '../../sim/prompt';
import { LineEditor } from './lineEditor';

const GREEN = '\x1b[1;32m';
const BLUE = '\x1b[1;34m';
const YELLOW = '\x1b[1;33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** Convert program output to what xterm expects (CR+LF line endings). */
export function toTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function promptFor(shell: Shell): string {
  const p = promptParts(shell.activeState);
  if (p.style === 'sh') return `${p.path} ${p.sigil} `;
  // Inside a container the user@host part is shown in a different colour.
  const who = shell.activeState.context ? YELLOW : GREEN;
  return `${who}${p.userHost}${RESET}:${BLUE}${p.path}${RESET}${p.sigil} `;
}

interface Props {
  shell: Shell;
  /** Printed once when the terminal starts. */
  banner?: string;
  /** Runs a line; defaults to `shell.run`. Missions route commands through their session. */
  execute?: (line: string) => RunResult;
  /** Called after every executed line. May return extra text to print before the next prompt. */
  onCommand?: (line: string, result: RunResult) => string | void;
  /** Called after the editor saved a file. May return extra text to print. */
  onFileSaved?: () => string | void;
}

export function TerminalPane({ shell, banner, execute, onCommand, onFileSaved }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ execute, onCommand, onFileSaved });
  callbacks.current = { execute, onCommand, onFileSaved };
  const [edit, setEdit] = useState<EditRequest | null>(null);
  const editing = useRef(false);
  editing.current = edit !== null;
  /** Live terminal + line editor, for printing after the editor closes. */
  const live = useRef<{ term: Terminal; editor: LineEditor } | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 14,
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff' },
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const editor = new LineEditor({
      prompt: () => promptFor(shell),
      complete: (line, cursor) => shell.complete(line, cursor),
      cols: () => term.cols,
    });
    if (banner) term.write(toTerminal(banner));
    term.write(editor.render(true));
    live.current = { term, editor };

    const sub = term.onData((data) => {
      if (editing.current) return;
      for (const ev of editor.feed(data)) {
        if (ev.type === 'write') term.write(ev.data);
        else if (ev.type === 'clear') term.clear();
        else {
          const run = callbacks.current.execute ?? ((l: string) => shell.run(l));
          const result = run(ev.line);
          if (result.clear) term.clear();
          for (const chunk of result.output) {
            const text = toTerminal(chunk.text);
            term.write(chunk.stream === 'stderr' && !chunk.note ? RED + text + RESET : text);
          }
          const extra = callbacks.current.onCommand?.(ev.line, result);
          if (extra) term.write(toTerminal(extra));
          if (result.edit) setEdit(result.edit);
          term.write(editor.render(true));
        }
      }
    });

    // Refit whenever the panel changes size (window resize or layout changes).
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host.current);
    term.focus();
    return () => {
      live.current = null;
      ro.disconnect();
      sub.dispose();
      term.dispose();
    };
  }, [shell, banner]);

  return (
    <div className="terminal-wrap">
      <div ref={host} className="terminal-host" />
      {edit && (
        <Editor
          request={edit}
          onSaved={() => {
            const extra = callbacks.current.onFileSaved?.();
            const l = live.current;
            if (extra && l) l.term.write('\r\x1b[J' + toTerminal(extra) + l.editor.render(true));
          }}
          onClose={() => {
            setEdit(null);
            live.current?.term.focus();
          }}
        />
      )}
    </div>
  );
}
