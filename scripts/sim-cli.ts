/**
 * Drive the simulator from a real terminal (handy for checking output fidelity).
 *   npm run sim                      # interactive
 *   npm run sim -- 'ls -l' 'cd /tmp' # run lines, print output
 */
import { createInterface } from 'node:readline';
import { createShell } from '../src/sim';
import { plainPrompt } from '../src/sim/prompt';

const shell = createShell();
const prompt = () => plainPrompt(shell.activeState);
const exec = (line: string) => {
  for (const chunk of shell.run(line).output) (chunk.stream === 'stderr' ? process.stderr : process.stdout).write(chunk.text);
};

const lines = process.argv.slice(2).filter((a) => a !== '--');
if (lines.length) {
  for (const l of lines) {
    process.stdout.write(prompt() + l + '\n');
    exec(l);
  }
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: prompt() });
  rl.prompt();
  rl.on('line', (l) => {
    exec(l);
    rl.setPrompt(prompt());
    rl.prompt();
  });
}
