import type { CommandDef } from '../../shell/types';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const env: CommandDef = {
  name: 'env',
  summary: 'print the environment',
  run(ctx) {
    const vars = { ...ctx.env };
    for (const a of ctx.args) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        vars[a.slice(0, eq)] = a.slice(eq + 1);
        continue;
      }
      ctx.err(`env: running commands via env ('${a}') is not supported in devquest yet\n`);
      return 125;
    }
    for (const [k, v] of Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : 1))) ctx.out(`${k}=${v}\n`);
    return 0;
  },
};

export const exportCmd: CommandDef = {
  name: 'export',
  summary: 'mark variables to be passed to child processes',
  run(ctx) {
    const { state } = ctx;
    const args = ctx.args.filter((a) => a !== '-p');
    if (!args.length) {
      for (const k of [...state.exported].sort()) {
        const v = state.vars[k];
        ctx.out(v === undefined ? `declare -x ${k}\n` : `declare -x ${k}="${v.replace(/(["\\$`])/g, '\\$1')}"\n`);
      }
      return 0;
    }
    let code = 0;
    for (const a of args) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (!NAME_RE.test(name)) {
        ctx.err(`bash: export: \`${a}': not a valid identifier\n`);
        code = 1;
        continue;
      }
      if (eq >= 0) state.vars[name] = a.slice(eq + 1);
      if (!state.exported.includes(name)) state.exported.push(name);
    }
    return code;
  },
};

export const unset: CommandDef = {
  name: 'unset',
  summary: 'remove shell variables',
  run(ctx) {
    const { state } = ctx;
    let code = 0;
    for (const name of ctx.args.filter((a) => a !== '-v')) {
      if (!NAME_RE.test(name)) {
        ctx.err(`bash: unset: \`${name}': not a valid identifier\n`);
        code = 1;
        continue;
      }
      delete state.vars[name];
      state.exported = state.exported.filter((e) => e !== name);
    }
    return code;
  },
};
