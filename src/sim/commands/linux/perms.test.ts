import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';
import { applyMode } from './chmod';

const mode = (t: ReturnType<typeof makeShell>, p: string) => t.vfs().stat(p).mode;

describe('applyMode', () => {
  it('handles octal and symbolic modes', () => {
    expect(applyMode('755', 0, false)).toBe(0o755);
    expect(applyMode('u+x', 0o644, false)).toBe(0o744);
    expect(applyMode('go-r', 0o644, false)).toBe(0o600);
    expect(applyMode('a=r', 0o777, false)).toBe(0o444);
    expect(applyMode('u=rwx,g=rx,o=', 0, false)).toBe(0o750);
    expect(applyMode('+x', 0o644, false)).toBe(0o755);
    expect(applyMode('+w', 0o444, false)).toBe(0o644); // umask 022 limits who-less +w
    expect(applyMode('u+x-w', 0o644, false)).toBe(0o544);
    expect(applyMode('a+X', 0o644, true)).toBe(0o755);
    expect(applyMode('a+X', 0o644, false)).toBe(0o644);
    expect(applyMode('+t', 0o777, true)).toBe(0o1777);
    expect(applyMode('zz', 0, false)).toBeNull();
  });
});

describe('chmod', () => {
  it('changes modes, visible in ls -l', () => {
    const t = makeShell();
    t.setup('touch run.sh', 'chmod +x run.sh');
    expect(mode(t, '/home/student/run.sh')).toBe(0o755);
    expect(t.run('ls -l run.sh').out).toMatch(/^-rwxr-xr-x /);
    t.run('chmod 600 run.sh');
    expect(t.run('ls -l run.sh').out).toMatch(/^-rw------- /);
  });
  it('accepts -x style modes and -R', () => {
    const t = makeShell();
    t.setup('mkdir -p d/e', 'touch d/e/f', 'chmod -R 700 d');
    expect(mode(t, '/home/student/d/e/f')).toBe(0o700);
    t.run('chmod -x d/e/f');
    expect(mode(t, '/home/student/d/e/f')).toBe(0o600);
  });
  it('-v reports changes', () => {
    const t = makeShell();
    expect(t.run('chmod -v 600 notes.txt').out).toBe(
      "mode of 'notes.txt' changed from 0644 (rw-r--r--) to 0600 (rw-------)\n",
    );
  });
  it('permission bits really gate access', () => {
    const t = makeShell();
    t.setup('echo secret > s', 'chmod 000 s');
    expect(t.run('cat s')).toMatchObject({ err: 'cat: s: Permission denied\n', code: 1 });
    expect(t.run('echo x > s').err).toBe('bash: s: Permission denied\n');
    t.run('chmod u+r s');
    expect(t.run('cat s').out).toBe('secret\n');
    t.setup('mkdir locked', 'touch locked/f', 'chmod 600 locked');
    expect(t.run('cd locked').err).toBe('bash: cd: locked: Permission denied\n');
    expect(t.run('cat locked/f').err).toBe('cat: locked/f: Permission denied\n');
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('chmod')).toMatchObject({ err: "chmod: missing operand\nTry 'chmod --help' for more information.\n", code: 1 });
    expect(t.run('chmod 644').err).toBe("chmod: missing operand after '644'\nTry 'chmod --help' for more information.\n");
    expect(t.run('chmod abc notes.txt').err).toBe("chmod: invalid mode: 'abc'\nTry 'chmod --help' for more information.\n");
    expect(t.run('chmod 644 nope').err).toBe("chmod: cannot access 'nope': No such file or directory\n");
    expect(t.run('chmod 777 /etc/hostname')).toMatchObject({
      err: "chmod: changing permissions of '/etc/hostname': Operation not permitted\n",
      code: 1,
    });
  });
});

describe('chown', () => {
  it('requires root to change owner', () => {
    const t = makeShell();
    expect(t.run('chown root notes.txt')).toMatchObject({
      err: "chown: changing ownership of 'notes.txt': Operation not permitted\n",
      code: 1,
    });
  });
  it('lets a user change group to one they belong to', () => {
    const t = makeShell();
    expect(t.run('chown :sudo notes.txt').code).toBe(0);
    expect(t.vfs().stat('/home/student/notes.txt').group).toBe('sudo');
    expect(t.run('chown :www-data notes.txt').code).toBe(1);
  });
  it('root can chown user, user:group, user: and -R', () => {
    const t = makeShell({ user: 'root' });
    t.setup('mkdir -p /srv/app/x', 'touch /srv/app/x/f');
    t.run('chown -R www-data:www-data /srv/app');
    const f = t.vfs().stat('/srv/app/x/f');
    expect([f.owner, f.group]).toEqual(['www-data', 'www-data']);
    t.run('chown student: /srv/app');
    const d = t.vfs().stat('/srv/app');
    expect([d.owner, d.group]).toEqual(['student', 'student']);
    t.run('chown root /srv/app');
    expect(t.vfs().stat('/srv/app').group).toBe('student');
    expect(t.run('ls -l /srv').out).toMatch(/drwxr-xr-x 3 root student 4096 .* app/);
  });
  it('errors', () => {
    const t = makeShell({ user: 'root' });
    expect(t.run('chown').err).toBe("chown: missing operand\nTry 'chown --help' for more information.\n");
    expect(t.run('chown bob').err).toBe("chown: missing operand after 'bob'\nTry 'chown --help' for more information.\n");
    expect(t.run('chown bob /tmp')).toMatchObject({ err: "chown: invalid user: 'bob'\n", code: 1 });
    expect(t.run('chown root:nogroup /tmp').err).toBe("chown: invalid group: 'root:nogroup'\n");
    expect(t.run('chown root nope').err).toBe("chown: cannot access 'nope': No such file or directory\n");
  });
});
