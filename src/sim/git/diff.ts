/** Line diffs (unified format, stats) and three-way merges with conflict markers. */

/** Split into lines, each keeping its "\n" (the last one may lack it). */
export function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.split(/(?<=\n)/);
  return out;
}

export type DiffOp = { op: ' ' | '-' | '+'; line: string; a: number; b: number };

/** Longest-common-subsequence alignment: pairs of matching indices (a, b), increasing. */
export function lcsPairs(a: string[], b: string[]): [number, number][] {
  // Trim the common prefix/suffix first: most real edits are small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let k = 0; k < start; k++) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      pairs.push([start + i, start + j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...lcsPairs(a, b), [a.length, b.length] as [number, number]]) {
    while (i < pi) ops.push({ op: '-', line: a[i], a: i++, b: j });
    while (j < pj) ops.push({ op: '+', line: b[j], a: i, b: j++ });
    if (pi < a.length) ops.push({ op: ' ', line: a[i], a: i++, b: j++ });
  }
  return ops;
}

export function countChanges(oldText: string, newText: string): { ins: number; del: number } {
  let ins = 0;
  let del = 0;
  for (const o of diffLines(lines(oldText), lines(newText))) {
    if (o.op === '+') ins++;
    else if (o.op === '-') del++;
  }
  return { ins, del };
}

function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

/** Hunks of a unified diff (without the file headers). Empty when the texts are equal. */
export function unifiedHunks(oldText: string, newText: string, context = 3): string {
  const oldLines = lines(oldText);
  const ops = diffLines(oldLines, lines(newText));
  const changed = ops.map((o, i) => (o.op !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return '';
  // Group changes whose context windows touch.
  const groups: [number, number][] = [];
  for (const c of changed) {
    const last = groups[groups.length - 1];
    if (last && c - last[1] <= context * 2) last[1] = c;
    else groups.push([c, c]);
  }
  let out = '';
  for (const [first, lastChange] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, lastChange + context);
    const slice = ops.slice(from, to + 1);
    const aCount = slice.filter((o) => o.op !== '+').length;
    const bCount = slice.filter((o) => o.op !== '-').length;
    const aStart = slice[0].a;
    const bStart = slice[0].b;
    // Like git's default "funcname": the last line before the hunk that starts with a letter, _ or $.
    let func = '';
    for (let k = aStart - 1; k >= 0; k--) {
      if (/^[A-Za-z_$]/.test(oldLines[k])) {
        func = ' ' + oldLines[k].replace(/\n$/, '').slice(0, 80);
        break;
      }
    }
    out += `@@ -${aCount === 0 ? `${aStart},0` : range(aStart, aCount)} +${bCount === 0 ? `${bStart},0` : range(bStart, bCount)} @@${func}\n`;
    for (const o of slice) {
      out += o.op + o.line.replace(/\n$/, '') + '\n';
      if (!o.line.endsWith('\n')) out += '\\ No newline at end of file\n';
    }
  }
  return out;
}

export interface Merge3Result {
  text: string;
  conflicts: number;
}

/**
 * diff3-style merge: changes on one side only are taken; identical changes are taken
 * once; overlapping different changes become conflict blocks.
 */
export function merge3(base: string, ours: string, theirs: string, oursLabel: string, theirsLabel: string): Merge3Result {
  const B = lines(base);
  const O = lines(ours);
  const T = lines(theirs);
  const mo = new Map<number, number>(lcsPairs(B, O));
  const mt = new Map<number, number>(lcsPairs(B, T));
  let i = 0;
  let o = 0;
  let t = 0;
  let out = '';
  let conflicts = 0;
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((l, k) => l === y[k]);
  const withNl = (ls: string[]) => ls.map((l, k) => (k === ls.length - 1 && !l.endsWith('\n') ? l + '\n' : l)).join('');
  for (;;) {
    while (i < B.length && mo.get(i) === o && mt.get(i) === t) {
      out += B[i];
      i++;
      o++;
      t++;
    }
    if (i >= B.length && o >= O.length && t >= T.length) break;
    let i2 = i;
    while (i2 < B.length && !(mo.has(i2) && mt.has(i2) && mo.get(i2)! >= o && mt.get(i2)! >= t)) i2++;
    const o2 = i2 < B.length ? mo.get(i2)! : O.length;
    const t2 = i2 < B.length ? mt.get(i2)! : T.length;
    const b = B.slice(i, i2);
    const oc = O.slice(o, o2);
    const tc = T.slice(t, t2);
    if (eq(oc, b)) out += tc.join('');
    else if (eq(tc, b) || eq(oc, tc)) out += oc.join('');
    else {
      conflicts++;
      out += `<<<<<<< ${oursLabel}\n${withNl(oc)}=======\n${withNl(tc)}>>>>>>> ${theirsLabel}\n`;
    }
    i = i2;
    o = o2;
    t = t2;
  }
  return { text: out, conflicts };
}
