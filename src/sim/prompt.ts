import type { SimState } from './state';
import { tildify } from './vfs/path';

export interface PromptParts {
  /** `user@host` for bash-style prompts, empty for busybox `sh`. */
  userHost: string;
  path: string;
  sigil: '$' | '#';
  style: 'bash' | 'sh';
}

/** What the prompt shows for a machine state (host shell or a shell inside a container). */
export function promptParts(state: SimState): PromptParts {
  const style = state.context?.promptStyle ?? 'bash';
  const path = tildify(state.cwd, state.vars.HOME ?? '/');
  const sigil = state.user === 'root' ? '#' : '$';
  return { userHost: style === 'bash' ? `${state.user}@${state.hostname}` : '', path, sigil, style };
}

/** e.g. `student@devquest:~$ `, `root@3f2a1b9c8d7e:/# `, or busybox `/ # `. */
export function plainPrompt(state: SimState): string {
  const p = promptParts(state);
  return p.style === 'bash' ? `${p.userHost}:${p.path}${p.sigil} ` : `${p.path} ${p.sigil} `;
}
