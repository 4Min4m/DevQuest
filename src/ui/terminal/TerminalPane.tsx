import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { Shell } from '../../sim/shell/shell';
import { tildify } from '../../sim/vfs/path';
import { LineEditor } from './lineEditor';

const GREEN = '\x1b[1;32m';
const BLUE = '\x1b[1;34m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** Convert program output to what xterm expects (CR+LF line endings). */
export function toTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function promptFor(shell: Shell): string {
  const s = shell.state;
  const where = tildify(s.cwd, s.vars.HOME ?? '/');
  const sigil = s.user === 'root' ? '#' : '$';
  return `${GREEN}${s.user}@${s.hostname}${RESET}:${BLUE}${where}${RESET}${sigil} `;
}

interface Props {
  shell: Shell;
  /** Printed once when the terminal starts. */
  banner?: string;
  /** Called after every executed line, e.g. so a mission can re-validate. */
  onCommand?: (line: string, exitCode: number) => void;
}

export function TerminalPane({ shell, banner, onCommand }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

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
          const result = shell.run(ev.line);
          if (result.clear) term.clear();
          for (const chunk of result.output) {
            const text = toTerminal(chunk.text);
            term.write(chunk.stream === 'stderr' ? RED + text + RESET : text);
          }
          onCommandRef.current?.(ev.line, result.exitCode);
          term.write(editor.render());
        }
      }
    });

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    term.focus();
    return () => {
      window.removeEventListener('resize', onResize);
      sub.dispose();
      term.dispose();
    };
  }, [shell, banner]);

  return <div ref={host} className="terminal-host" />;
}
