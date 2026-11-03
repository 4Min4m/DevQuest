import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { Shell } from '../../sim/shell/shell';
import type { RunResult } from '../../sim/shell/types';
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
}

export function TerminalPane({ shell, banner, execute, onCommand }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ execute, onCommand });
  callbacks.current = { execute, onCommand };

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
    });
    if (banner) term.write(toTerminal(banner));
    term.write(editor.render());

    const sub = term.onData((data) => {
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
          term.write(editor.render());
        }
      }
    });

    // Refit whenever the panel changes size (window resize or layout changes).
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host.current);
    term.focus();
    return () => {
      ro.disconnect();
      sub.dispose();
      term.dispose();
    };
  }, [shell, banner]);

  return <div ref={host} className="terminal-host" />;
}
