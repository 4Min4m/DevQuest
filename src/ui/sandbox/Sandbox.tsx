import { useMemo, useState } from 'react';
import { createShell } from '../../sim';
import { TerminalPane } from '../terminal/TerminalPane';

const BANNER =
  '\x1b[1;36mSandbox\x1b[0m — free practice: no missions, no hearts, nothing is saved.\n' +
  'Try: \x1b[1mdocker run -d --name web -p 8080:80 nginx\x1b[0m then \x1b[1mcurl localhost:8080\x1b[0m. Type \x1b[1mhelp\x1b[0m for all commands.\n\n';

/** A fresh simulated machine to experiment with freely. */
export function Sandbox() {
  const [generation, setGeneration] = useState(0);
  const shell = useMemo(() => createShell(), [generation]);
  return (
    <div className="sandbox">
      <div className="sandbox-bar">
        <span className="muted">A throwaway Linux + Docker machine. Break things!</span>
        <button onClick={() => setGeneration((g) => g + 1)}>Reset machine</button>
      </div>
      <main className="terminal-area">
        <TerminalPane key={generation} shell={shell} banner={BANNER} />
      </main>
    </div>
  );
}
