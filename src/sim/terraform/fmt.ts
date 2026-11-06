/** terraform fmt: canonical indentation and aligned equals signs. */

function scan(line: string, state: { heredoc: string | null }): { opens: number; closes: number; leadingClose: boolean } {
  let opens = 0;
  let closes = 0;
  let inStr = false;
  const t = line.trim();
  if (state.heredoc) {
    if (t === state.heredoc) state.heredoc = null;
    return { opens: 0, closes: 0, leadingClose: false };
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '#' || (c === '/' && line[i + 1] === '/')) break;
    else if (c === '<' && line[i + 1] === '<') {
      const m = /^<<-?([A-Za-z_]\w*)/.exec(line.slice(i));
      if (m) {
        state.heredoc = m[1];
        break;
      }
    } else if ('{[('.includes(c)) opens++;
    else if ('}])'.includes(c)) closes++;
  }
  return { opens, closes, leadingClose: /^[}\])]/.test(t) };
}

export function formatHcl(src: string): string {
  const raw = src.replace(/\r\n/g, '\n').split('\n');
  const out: { text: string; depth: number; attr?: { key: string; rest: string }; verbatim?: boolean }[] = [];
  let depth = 0;
  const st = { heredoc: null as string | null };
  for (const line of raw) {
    if (st.heredoc) {
      out.push({ text: line, depth: 0, verbatim: true });
      scan(line, st);
      continue;
    }
    const t = line.trim();
    const s = scan(line, st);
    let d = depth;
    if (s.leadingClose) d = Math.max(0, depth - 1);
    const m = /^([\w-]+|"[^"]*")\s*=(?!=)\s*(.*)$/.exec(t);
    out.push({ text: t, depth: d, attr: m && !t.startsWith('#') ? { key: m[1], rest: m[2] } : undefined });
    depth = Math.max(0, depth + s.opens - s.closes);
  }
  // Align "=" in runs of consecutive single-line attributes at the same depth.
  for (let i = 0; i < out.length; ) {
    if (!out[i].attr) {
      i++;
      continue;
    }
    let j = i;
    const dep = out[i].depth;
    const multi = (x: (typeof out)[number]) => /[{[(]\s*$/.test(x.attr!.rest) || /^<<-?\w+/.test(x.attr!.rest);
    if (multi(out[i])) {
      out[i].text = `${out[i].attr!.key} = ${out[i].attr!.rest}`;
      i++;
      continue;
    }
    while (j < out.length && out[j].attr && out[j].depth === dep && !multi(out[j])) j++;
    const w = Math.max(...out.slice(i, j).map((x) => x.attr!.key.length));
    for (let k = i; k < j; k++) out[k].text = `${out[k].attr!.key.padEnd(w)} = ${out[k].attr!.rest}`;
    i = j;
  }
  const lines = out.map((x) => (x.verbatim ? x.text : x.text ? '  '.repeat(x.depth) + x.text : ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}
