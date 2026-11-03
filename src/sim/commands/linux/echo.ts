import type { CommandDef } from '../../shell/types';

function interpretEscapes(s: string): { text: string; stop: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i === s.length - 1) {
      out += s[i];
      continue;
    }
    const c = s[++i];
    const map: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', a: '\x07', b: '\b', r: '\r', v: '\v', f: '\f', e: '\x1b' };
    if (c === 'c') return { text: out, stop: true };
    out += map[c] ?? '\\' + c;
  }
  return { text: out, stop: false };
}

/** bash's builtin echo: -n, -e, -E (combinable, unknown flags are printed literally). */
export const echo: CommandDef = {
  name: 'echo',
  summary: 'display a line of text',
  run(ctx) {
    let newline = true;
    let escapes = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (!/^-[neE]+$/.test(a)) break;
      for (const f of a.slice(1)) {
        if (f === 'n') newline = false;
        else if (f === 'e') escapes = true;
        else escapes = false;
      }
    }
    let text = ctx.args.slice(i).join(' ');
    if (escapes) {
      const r = interpretEscapes(text);
      text = r.text;
      if (r.stop) newline = false;
    }
    ctx.out(text + (newline ? '\n' : ''));
    return 0;
  },
};
