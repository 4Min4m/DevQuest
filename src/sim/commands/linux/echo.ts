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

/** bash's builtin printf: %s %d %i %f %x %o %c %b %q %%, widths and precision; the format repeats for extra arguments. */
export const printf: CommandDef = {
  name: 'printf',
  summary: 'format and print data (printf FORMAT [ARGUMENT]...)',
  run(ctx) {
    const args = [...ctx.args];
    if (args[0] === '--') args.shift();
    if (args[0] === '-v') {
      ctx.err('devquest: printf -v is not supported\n');
      return 2;
    }
    const fmt = args.shift();
    if (fmt === undefined) {
      ctx.err('printf: usage: printf [-v var] format [arguments]\n');
      return 2;
    }
    let out = '';
    let code = 0;
    let i = 0;
    const next = () => (i < args.length ? args[i++] : undefined);
    do {
      const start = i;
      const r = interpretEscapes(fmt);
      let used = false;
      out += r.text.replace(/%([-+ #0]*)(\d*)(?:\.(\d+))?([sdifxXocbq%])/g, (_m, flags: string, width: string, prec: string | undefined, conv: string) => {
        if (conv === '%') return '%';
        used = true;
        const a = next();
        let s: string;
        if ('dixXo'.includes(conv)) {
          const n = a === undefined || a === '' ? 0 : Number(a);
          if (a !== undefined && a !== '' && Number.isNaN(n)) {
            ctx.err(`bash: printf: ${a}: invalid number\n`);
            code = 1;
          }
          const v = Math.trunc(Number.isNaN(n) ? 0 : n);
          s = conv === 'x' ? v.toString(16) : conv === 'X' ? v.toString(16).toUpperCase() : conv === 'o' ? v.toString(8) : String(v);
          if (flags.includes('+') && v >= 0) s = '+' + s;
        } else if (conv === 'f') s = (Number(a ?? 0) || 0).toFixed(prec === undefined ? 6 : Number(prec));
        else if (conv === 'c') s = (a ?? '').slice(0, 1);
        else if (conv === 'b') s = interpretEscapes(a ?? '').text;
        else if (conv === 'q') s = a === undefined || /^[\w@%+=:,./-]+$/.test(a) ? (a ?? "''") : `'${a.replace(/'/g, `'\\''`)}'`;
        else s = prec !== undefined ? (a ?? '').slice(0, Number(prec)) : (a ?? '');
        const w = Number(width || 0);
        if (s.length < w) s = flags.includes('-') ? s.padEnd(w) : flags.includes('0') && 'dixXof'.includes(conv) ? s.padStart(w, '0') : s.padStart(w);
        return s;
      });
      if (!used || i === start) break;
    } while (i < args.length);
    ctx.out(out);
    return code;
  },
};
