import { useMemo } from 'react';
import { createShell } from '../sim';
import { TerminalPane } from './terminal/TerminalPane';

const BANNER =
  '\x1b[1;36mDevOps Quest\x1b[0m — simulated Linux terminal (everything runs in your browser)\n' +
  "Type \x1b[1mhelp\x1b[0m to see available commands. Try: ls -la, cat notes.txt, ps aux | grep cron\n\n";

/** Step 1 shell: a full-page terminal. Lessons and the skill tree arrive in later steps. */
export function App() {
  const shell = useMemo(() => createShell(), []);
  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">⚙ DevOps Quest</span>
        <span className="subtitle">Sandbox terminal</span>
      </header>
      <main className="app-main">
        <TerminalPane shell={shell} banner={BANNER} />
      </main>
    </div>
  );
}
