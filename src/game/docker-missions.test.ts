import { describe, expect, it } from 'vitest';
import { lessons } from '../content';
import { createShell } from '../sim';
import { makeShell } from '../sim/testing';
import { buildInitialState } from './initialState';
import { MissionSession } from './session';
import type { Check, Mission } from './types';
import { runCheck } from './validators';

const mission = (id: string): Mission => lessons.flatMap((l) => l.missions).find((m) => m.id === id)!;

/** Run lines in a fresh session for `id` and report whether it passed. */
function attempt(id: string, lines: string[]) {
  const s = new MissionSession(mission(id));
  for (const l of lines) s.run(l);
  return s;
}

describe('docker checks', () => {
  function ctx() {
    const t = makeShell();
    t.setup(
      'docker pull nginx',
      'docker network create backend',
      'docker run -d --name web -p 8080:80 -e MODE=prod -v data:/data --network backend nginx',
      'docker exec web sh -c "echo hi > /data/x"',
    );
    return { state: t.state, outputs: [] as string[] };
  }
  const pass = (c: Check, x = ctx()) => runCheck(c, x).passed;

  it('container checks', () => {
    const x = ctx();
    expect(pass({ type: 'containerRunning', name: 'web' }, x)).toBe(true);
    expect(pass({ type: 'containerRunning', image: 'nginx:latest' }, x)).toBe(true);
    expect(pass({ type: 'containerRunning', name: 'web', image: 'redis' }, x)).toBe(false);
    expect(pass({ type: 'containerAbsent', name: 'nope' }, x)).toBe(true);
    expect(pass({ type: 'containerPort', name: 'web', hostPort: 8080, containerPort: 80 }, x)).toBe(true);
    expect(pass({ type: 'containerPort', name: 'web', hostPort: 9090 }, x)).toBe(false);
    expect(pass({ type: 'containerEnv', name: 'web', env: 'MODE=prod' }, x)).toBe(true);
    expect(pass({ type: 'containerEnv', name: 'web', env: 'MODE' }, x)).toBe(true);
    expect(pass({ type: 'containerEnv', name: 'web', env: 'MODE=dev' }, x)).toBe(false);
    expect(pass({ type: 'containerMount', name: 'web', target: '/data', source: 'data', mountType: 'volume' }, x)).toBe(true);
    expect(pass({ type: 'containerNetwork', name: 'web', network: 'backend' }, x)).toBe(true);
    expect(pass({ type: 'containerInspect', name: 'web', path: 'State.Status', equals: 'running' }, x)).toBe(true);
    expect(pass({ type: 'containerFile', name: 'web', path: '/data/x', text: 'hi' }, x)).toBe(true);
    expect(pass({ type: 'containerFile', name: 'web', path: '/nope' }, x)).toBe(false);
  });

  it('image, volume, network and http checks', () => {
    const x = ctx();
    expect(pass({ type: 'imageExists', ref: 'nginx' }, x)).toBe(true);
    expect(pass({ type: 'imageExists', ref: 'redis' }, x)).toBe(false);
    expect(pass({ type: 'imageInspect', ref: 'nginx', path: 'Os', equals: 'linux' }, x)).toBe(true);
    expect(pass({ type: 'volumeExists', name: 'data' }, x)).toBe(true);
    expect(pass({ type: 'networkExists', name: 'backend' }, x)).toBe(true);
    expect(pass({ type: 'httpResponds', url: 'http://localhost:8080', contains: 'Welcome to nginx!' }, x)).toBe(true);
    expect(pass({ type: 'httpResponds', url: 'http://localhost:8080/nope' }, x)).toBe(false);
    expect(pass({ type: 'httpResponds', url: 'http://localhost:8080/nope', status: 404 }, x)).toBe(true);
    expect(pass({ type: 'httpResponds', url: 'http://localhost:9999' }, x)).toBe(false);
  });

  it('http checks are silent (no access-log lines)', () => {
    const x = ctx();
    const web = x.state.docker!.containers[0];
    const before = web.logs.length;
    runCheck({ type: 'httpResponds', url: 'http://localhost:8080' }, x);
    expect(web.logs.length).toBe(before);
    expect(web.requests).toBe(0);
  });
});

describe('mission setup', () => {
  it('runs setup commands, then starts the learner with a clean history', () => {
    const state = buildInitialState({ setup: ['docker pull nginx', 'docker run -d --name web nginx', 'cd /tmp'] });
    expect(state.history).toEqual([]);
    expect(state.commandLog).toEqual([]);
    expect(state.cwd).toBe('/home/student');
    const out = createShell(state).run('docker ps --format "{{.Names}} {{.Status}}"').output[0].text;
    expect(out).toBe('web Up 5 minutes\n');
  });

  it('fails loudly on broken setup (authoring errors)', () => {
    expect(() => buildInitialState({ setup: ['docker run --name x1 nosuchimage'] })).toThrow(/setup command failed \(exit 125\)/);
  });
});

describe('Docker missions reject the wrong fixes', () => {
  it('clean-up: removing api breaks the guard and blocks success', () => {
    const s = attempt('clean-up', ['docker rm -f old-job-1 old-job-2 debug-shell api']);
    expect(s.status).toBe('active');
    expect(s.stats.mistakes).toBe(1);
  });

  it('crashloop: restarting is not a fix; deleting the volume is a disaster', () => {
    expect(attempt('crashloop', ['docker restart db']).status).toBe('active');
    const s = attempt('crashloop', ['docker rm -f db', 'docker volume rm pgdata']);
    expect(s.stats.mistakes).toBe(1);
    // a new db without the volume doesn't count either
    expect(attempt('crashloop', ['docker rm -f db', 'docker run -d --name db --restart always -e POSTGRES_PASSWORD=x postgres']).status).toBe('active');
  });

  it('port-conflict: starting site while legacy holds the port fails', () => {
    const s = attempt('port-conflict', ['docker start site']);
    expect(s.status).toBe('active');
    expect(attempt('port-conflict', ['docker stop legacy', 'docker start site']).status).toBe('passed');
  });

  it('broken-config: fixing only the semicolon is not enough', () => {
    const conf = 'server {\\n    listen 8081;\\n    location / {\\n        root /usr/share/nginx/html;\\n    }\\n}';
    const s = attempt('broken-config', [`echo -e "${conf}" > proxy/default.conf`, 'docker start web']);
    expect(s.status).toBe('active');
    expect(s.shell.run('curl localhost:8080').exitCode).toBe(56);
    // recreating the container with a different mapping doesn't count
    expect(attempt('broken-config', ['docker rm -f web', 'docker run -d --name web -p 8080:80 nginx']).status).toBe('active');
  });

  it('first-container: wrong port mapping does not pass', () => {
    expect(attempt('first-container', ['docker run -d --name web -p 8080:8080 nginx']).status).toBe('active');
  });

  it('first-dockerfile: the editor flow (save triggers re-validation)', () => {
    const s = attempt('first-dockerfile', ['cd hello-api', 'nano Dockerfile']);
    const r = s.shell.run('nano Dockerfile');
    expect(r.edit?.content).toBe('');
    expect(r.edit?.save('FROM python:3.12-slim\nWORKDIR /app\nCOPY app.py .\nCMD ["python3", "app.py"]\n')).toBeNull();
    expect(s.reevaluate()).toEqual([]); // not done yet: still needs build + run
    s.run('docker build -t hello-api:1.0 .');
    s.run('docker run -d --name api -p 8000:8000 hello-api:1.0');
    expect(s.status).toBe('passed');
  });
});
