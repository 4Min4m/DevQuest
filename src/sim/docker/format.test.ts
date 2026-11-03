import { describe, expect, it } from 'vitest';
import { ellipsis, goTemplate, hexId, humanDuration, humanSize, isoTime, randomName, table } from './format';

describe('docker formatting', () => {
  it('humanDuration matches go-units', () => {
    expect(humanDuration(500)).toBe('Less than a second');
    expect(humanDuration(1000)).toBe('1 second');
    expect(humanDuration(45_000)).toBe('45 seconds');
    expect(humanDuration(61_000)).toBe('About a minute');
    expect(humanDuration(5 * 60_000)).toBe('5 minutes');
    expect(humanDuration(65 * 60_000)).toBe('About an hour');
    expect(humanDuration(5 * 3600_000)).toBe('5 hours');
    expect(humanDuration(3 * 86_400_000)).toBe('3 days');
    expect(humanDuration(20 * 86_400_000)).toBe('2 weeks');
    expect(humanDuration(90 * 86_400_000)).toBe('3 months');
    expect(humanDuration(800 * 86_400_000)).toBe('2 years');
  });

  it('humanSize uses decimal units with 3 significant digits', () => {
    expect(humanSize(192_004_242)).toBe('192MB');
    expect(humanSize(7_799_999)).toBe('7.8MB');
    expect(humanSize(13_256)).toBe('13.3kB');
    expect(humanSize(1_120_442_316)).toBe('1.12GB');
    expect(humanSize(512)).toBe('512B');
  });

  it('table pads like tabwriter (minwidth 10, padding 3)', () => {
    expect(table([['REPOSITORY', 'TAG', 'IMAGE ID'], ['nginx', 'latest', 'b7cac2313480']])).toBe(
      'REPOSITORY   TAG       IMAGE ID\nnginx        latest    b7cac2313480\n',
    );
  });

  it('ellipsis, ids, names, timestamps', () => {
    expect(ellipsis('/docker-entrypoint.sh nginx -g', 20)).toBe('/docker-entrypoint.…');
    expect(ellipsis('echo hi', 20)).toBe('echo hi');
    expect(hexId('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(hexId('a')).toBe(hexId('a'));
    expect(hexId('a')).not.toBe(hexId('b'));
    expect(randomName(3)).toMatch(/^[a-z]+_[a-z]+$/);
    expect(isoTime(Date.UTC(2026, 10, 3, 9, 0, 0))).toBe('2026-11-03T09:00:00.000000000Z');
  });

  it('goTemplate supports fields, json and index', () => {
    const data = { State: { Status: 'running', ExitCode: 0 }, Names: 'web', Env: ['A=1'], Ports: { '80/tcp': [{ HostPort: '8080' }] } };
    expect(goTemplate('{{.State.Status}} {{.Names}}', data)).toBe('running web');
    expect(goTemplate('{{json .State}}', data)).toBe('{"Status":"running","ExitCode":0}');
    expect(goTemplate('{{.Env}}', data)).toBe('[A=1]');
    expect(goTemplate('{{index .Ports "80/tcp"}}', data)).toBe('[map[HostPort:8080]]');
    expect(goTemplate('{{.Names}}\\t{{.State.ExitCode}}', data)).toBe('web\t0');
    expect(() => goTemplate('{{.Nope}}', data)).toThrow('map has no entry for key "Nope"');
    expect(() => goTemplate('{{range .Env}}{{.}}{{end}}', data)).toThrow('unsupported in devquest');
  });
});
