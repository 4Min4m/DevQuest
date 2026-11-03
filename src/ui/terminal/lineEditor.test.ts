import { describe, expect, it } from 'vitest';
import { makeShell } from '../../sim/testing';
import { EditorEvent, LineEditor } from './lineEditor';

function submits(events: EditorEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'submit' ? [e.line] : []));
}

describe('LineEditor', () => {
  const make = () => new LineEditor({ prompt: () => '$ ' });

  it('types and submits a line', () => {
    const ed = make();
    expect(submits(ed.feed('ls -la\r'))).toEqual(['ls -la']);
    expect(ed.buffer).toBe('');
  });

  it('handles a multi-line paste as separate submissions', () => {
    expect(submits(make().feed('pwd\r\nwhoami\n'))).toEqual(['pwd', 'whoami']);
  });

  it('edits with backspace, arrows, home/end, delete', () => {
    const ed = make();
    ed.feed('helo');
    ed.feed('\x1b[D'); // left
    ed.feed('l');
    expect(ed.buffer).toBe('hello');
    ed.feed('\x01X'); // Ctrl+A then X
    expect(ed.buffer).toBe('Xhello');
    ed.feed('\x1b[3~'); // delete
    expect(ed.buffer).toBe('Xello');
    ed.feed('\x05\x7f'); // end, backspace
    expect(ed.buffer).toBe('Xell');
  });

  it('kills text with Ctrl+U, Ctrl+K, Ctrl+W', () => {
    const ed = make();
    ed.feed('echo hello world\x17');
    expect(ed.buffer).toBe('echo hello ');
    ed.feed('\x01\x0b');
    expect(ed.buffer).toBe('');
    ed.feed('abc\x15');
    expect(ed.buffer).toBe('');
  });

  it('navigates history with up/down and keeps the draft', () => {
    const ed = make();
    ed.feed('one\r');
    ed.feed('two\r');
    ed.feed('dra');
    ed.feed('\x1b[A');
    expect(ed.buffer).toBe('two');
    ed.feed('\x1b[A');
    expect(ed.buffer).toBe('one');
    ed.feed('\x1b[A');
    expect(ed.buffer).toBe('one');
    ed.feed('\x1b[B\x1b[B');
    expect(ed.buffer).toBe('dra');
  });

  it('Ctrl+C abandons the line', () => {
    const ed = make();
    const ev = ed.feed('rm -rf x\x03');
    expect(ed.buffer).toBe('');
    expect(submits(ev)).toEqual([]);
    expect(ev.some((e) => e.type === 'write' && e.data.includes('^C'))).toBe(true);
  });

  it('Ctrl+L requests a clear', () => {
    expect(make().feed('\x0c').some((e) => e.type === 'clear')).toBe(true);
  });

  it('renders prompt and moves the cursor back', () => {
    const ed = make();
    ed.feed('abc\x1b[D\x1b[D');
    expect(ed.render()).toBe('\r\x1b[2K$ abc\x1b[2D');
  });

  it('tab-completes commands and paths through the shell', () => {
    const t = makeShell();
    t.setup('mkdir -p projects/api', 'touch projects/app.py');
    const ed = new LineEditor({ prompt: () => '$ ', complete: (l, c) => t.shell.complete(l, c) });
    ed.feed('wh\t');
    expect(ed.buffer).toBe('whoami ');
    ed.feed('\x15cd pro\t');
    expect(ed.buffer).toBe('cd projects/');
    const ev = ed.feed('a\t');
    expect(ed.buffer).toBe('cd projects/ap');
    ed.feed('\t');
    const ev2 = ed.feed('\t');
    expect(ev2.some((e) => e.type === 'write' && e.data.includes('api/  app.py'))).toBe(true);
    expect(ev.length).toBeGreaterThan(0);
    ed.feed('\x15ls ~/no\t');
    expect(ed.buffer).toBe('ls ~/notes.txt ');
    ed.feed('\x15echo x | so\t');
    expect(ed.buffer).toBe('echo x | sort ');
  });
});
