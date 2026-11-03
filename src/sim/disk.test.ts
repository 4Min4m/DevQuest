import { describe, expect, it } from 'vitest';
import { diskUsage, mountFor } from './disk';
import { makeShell } from './testing';

describe('disk usage', () => {
  it('counts simulated files on top of the base usage', () => {
    const t = makeShell();
    const root = mountFor(t.state.disks, '/home/student')!;
    expect(root.mount).toBe('/');
    const before = diskUsage(t.state, root);
    t.vfs().writeFile('/home/student/big.bin', 'x'.repeat(10000));
    const after = diskUsage(t.state, root);
    expect(after.usedKb - before.usedKb).toBe(12); // three 4K blocks
    expect(after.inodesUsed - before.inodesUsed).toBe(1);
    expect(mountFor(t.state.disks, '/tmp/x')!.mount).toBe('/tmp');
  });

  it('uses the apparent size of huge files, and du / ls / df agree', () => {
    const t = makeShell();
    t.setup('sudo mkdir -p /var/log/app', 'echo log | sudo tee /var/log/app/debug.log');
    const node = t.vfs().lookup('/var/log/app/debug.log');
    if (node.type === 'file') node.size = 10 * 1024 ** 3;
    expect(t.run('du -sh /var/log/app').out).toBe('11G\t/var/log/app\n');
    expect(t.run('ls -lh /var/log/app').out).toContain(' 10G ');
    expect(t.run('df -h /').out).toMatch(/\/dev\/sda1 +20G +16G +3\.8G +81% \/\n$/);
    t.setup('sudo rm /var/log/app/debug.log');
    expect(t.run('df -h /').out).toMatch(/30% \/\n$/);
  });

  it('df -i reports inodes', () => {
    const t = makeShell();
    expect(t.run('df -i').out).toMatch(/^Filesystem +Inodes +IUsed +IFree +IUse% +Mounted on\n\/dev\/sda1 +1310720 +\d+ +\d+ +15% \/\n/);
    expect(t.run('df -hi /').out).toMatch(/\/dev\/sda1 +1\.3M +\d+K +\d\.\dM +15% \/\n$/);
  });
});

describe('ENOSPC', () => {
  function fullTmp() {
    const t = makeShell();
    const tmp = t.state.disks.find((d) => d.mount === '/tmp')!;
    tmp.size = 100; // KiB
    tmp.inodes = 10;
    return t;
  }

  it('refuses writes when the disk is out of space', () => {
    const t = fullTmp();
    t.setup('echo small > /tmp/a');
    expect(t.run(`echo ${'x'.repeat(200 * 1024)} > /tmp/b`)).toMatchObject({ err: 'bash: echo: write error: No space left on device\n', code: 1 });
    expect(t.run('cat /tmp/b').out).toBe(''); // created, but nothing fit
    expect(t.run('df /tmp').out).toMatch(/\/tmp\n$/);
  });

  it('refuses new files when inodes are exhausted, though bytes are free', () => {
    const t = fullTmp();
    for (let i = 0; i < 8; i++) t.setup(`touch /tmp/f${i}`);
    expect(t.run('touch /tmp/one-more')).toMatchObject({ err: "touch: cannot touch '/tmp/one-more': No space left on device\n", code: 1 });
    expect(t.run('mkdir /tmp/d')).toMatchObject({ err: "mkdir: cannot create directory '/tmp/d': No space left on device\n", code: 1 });
    expect(t.run('df -i /tmp').out).toMatch(/100% \/tmp\n$/);
    t.setup('rm /tmp/f0');
    expect(t.run('touch /tmp/one-more').code).toBe(0);
  });

  it('other filesystems are unaffected', () => {
    const t = fullTmp();
    for (let i = 0; i < 9; i++) t.shell.run(`touch /tmp/f${i}`);
    expect(t.run('touch ~/fine').code).toBe(0);
  });
});
